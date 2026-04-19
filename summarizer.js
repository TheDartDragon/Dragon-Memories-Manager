// summarizer.js — generates memory summaries via generateRaw (no ST context injection)
//
// Console test:
//   DMM.summarize('Ivrene', 'manual', '0-10')
//   DMM.summarize('Ivrene', 'last_summary')
//   DMM.summarize('Ivrene', 'markers')   // requires markers set first

import { generateRaw, max_context, setCharacterId, this_chid } from '../../../../script.js';
import { getPresetManager } from '../../../../scripts/preset-manager.js';
import { power_user } from '../../../../scripts/power-user.js';
import { getContext } from '../../../extensions.js';
import { checkWorldInfo, world_info_include_names } from '../../../world-info.js';
import { EXT_NAME } from './constants.js';
import { collectAndFilter } from './memory-manager.js';
import { dmmLog, dmmDevLog } from './logger.js';

// ── Default generation prompt ────────────────────────────────────────────────

/**
 * PList format — concise structured memory, no weather field.
 * Exported so index.js can use it as the DEFAULT_SETTINGS value without
 * duplicating the string.
 */
export const DEFAULT_GENERATION_PROMPT =
    `You are a memory scribe. You do not roleplay. Output only structured memory notes.\n\n` +
    `Write a memory entry for {{char}}. Include only events {{char}} directly witnessed based on the transcript below.\n` +
    `Keep the total output under 400 tokens.\n` +
    `Important: leave a blank line between the Events list and Character Impression. Put the closing ] on its own line.\n\n` +
    `Use exactly this format:\n` +
    `[{{char}}'s Memory\n` +
    `Time: <time of day>\n` +
    `Location: <location>\n` +
    `Topics: <primary topic>; <emotional tone>; <interaction theme>\n` +
    `CharactersPresent: <names of characters present>\n` +
    `Events:\n- <event>\n- <event>\n(5–10 bullet points)\n\n` +
    `Character Impression: <{{char}}'s feelings and impressions>\n` +
    `]\n\n` +
    `Transcript:\n{{transcript}}\n\n` +
    `Memory entry:`;

// ── Prompt building ──────────────────────────────────────────────────────────

/**
 * Convert a raw message object to a "Speaker: text" line.
 * Strips HTML tags that ST may embed in mes.
 */
function formatMessage(msg) {
    const speaker = msg.name || (msg.is_user ? 'User' : 'Unknown');
    const text    = (msg.mes || '').replace(/<[^>]*>/g, '').trim();
    return `${speaker}: ${text}`;
}

/**
 * Build the full summarization prompt for a character.
 * The promptTemplate should contain {{char}} and {{transcript}} placeholders.
 *
 * @param {string}   charName
 * @param {object[]} messages        already presence-filtered
 * @param {string}   [promptTemplate] defaults to DEFAULT_GENERATION_PROMPT
 * @returns {string}
 */
function buildPrompt(charName, messages, promptTemplate = DEFAULT_GENERATION_PROMPT) {
    const transcript = messages.map(formatMessage).join('\n\n');
    return promptTemplate
        .replace(/\{\{char\}\}/g, charName)
        .replace(/\{\{transcript\}\}/g, transcript);
}

// ── Lorebook context ─────────────────────────────────────────────────────────

/**
 * Run ST's lorebook key matching against the filtered transcript messages.
 * Returns the concatenated content of all entries whose keys fired, or ''
 * if nothing matched. isDryRun=true means no side effects (no timed effects,
 * no WORLD_INFO_ACTIVATED event).
 *
 * @param {object[]} messages  presence-filtered transcript messages
 * @returns {Promise<string>}
 */
/**
 * @param {object[]} messages         presence-filtered transcript messages
 * @param {string}   charName         character being summarized
 * @param {string[]} [excludedLorebooks]  blocklist of lorebook filenames; empty = include all
 */
async function getActivatedLorebookContent(messages, charName, excludedLorebooks = []) {
    try {
        // WorldInfoBuffer expects string[], reversed (depth 0 = most recent).
        const chatForWI = messages
            .map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes)
            .reverse();

        // getCharacterLore() and character filter checks both use this_chid, which is
        // null in group chats outside of active generation. Temporarily set it to the
        // summarized character's index so lorebooks and filters resolve correctly.
        const ctx = getContext();
        const charIdx = ctx.characters.findIndex(c => c.name === charName);
        const savedChid = this_chid;
        if (charIdx !== -1) setCharacterId(charIdx);

        let result;
        try {
            result = await checkWorldInfo(chatForWI, max_context, true);
        } finally {
            setCharacterId(savedChid);
        }

        let entries = Array.from(result.allActivatedEntries?.values() ?? []);

        dmmDevLog(`WI scan raw: ${entries.length} entries`, entries.map(e => ({
            world:   e.world,
            uid:     e.uid,
            comment: e.comment,
            constant: e.constant,
            preview: (e.content || '').slice(0, 80),
        })));

        if (excludedLorebooks.length > 0) {
            const before = entries.length;
            entries = entries.filter(e => !excludedLorebooks.includes(e.world));
            dmmDevLog(`Lorebook blocklist applied: ${before} → ${entries.length} (excluded: ${excludedLorebooks.join(', ')})`);
        }

        const content = entries.map(e => e.content).filter(Boolean).join('\n');
        if (content) {
            dmmLog(`Lorebook scan: ${entries.length} entries activated, ${content.length} chars`);
        } else {
            dmmLog('Lorebook scan: no entries activated');
        }
        return content;
    } catch (e) {
        dmmLog(`Lorebook scan failed, proceeding without it: ${e?.message ?? e}`);
        console.warn(`[${EXT_NAME}] Lorebook scan failed:`, e);
        return '';
    }
}

// ── Environment swap (profile + preset) ─────────────────────────────────────

/**
 * Run `fn` while optionally swapped to a summarization connection profile
 * and/or completion preset, restoring both afterward.
 *
 * Order matters (per qvink): save preset BEFORE swapping profile, because
 * a profile change reloads available presets. Restore profile BEFORE preset.
 *
 * @param {string}   summaryProfileName  connection profile name (empty = no swap)
 * @param {string}   summaryPresetName   completion preset name (empty = no swap)
 * @param {Function} fn                  async function to run inside the swap
 * @returns {Promise<*>}
 */
async function withSummaryEnvironment(summaryProfileName, summaryPresetName, fn) {
    const ctx        = getContext();
    const profileCmd = ctx.SlashCommandParser?.commands?.['profile'];

    // 1. Save current preset BEFORE any profile swap
    let currentPreset = null;
    if (summaryPresetName) {
        try {
            currentPreset = getPresetManager().getSelectedPresetName();
        } catch (e) {
            console.warn(`[${EXT_NAME}] Could not read current preset:`, e);
        }
    }

    // 2. Swap connection profile
    let previousProfile = null;
    let profileSwapped  = false;
    if (summaryProfileName) {
        if (!profileCmd) {
            console.warn(`[${EXT_NAME}] Connection Manager not available — skipping profile swap`);
        } else {
            try { previousProfile = await profileCmd.callback({}, ''); } catch (e) { /* ignore */ }
            try {
                await profileCmd.callback({ await: 'true' }, summaryProfileName);
                dmmLog(`Switched to summary profile: "${summaryProfileName}"`);
                profileSwapped = true;
            } catch (e) {
                console.warn(`[${EXT_NAME}] Could not switch to summary profile "${summaryProfileName}":`, e);
            }
        }
    }

    // 3. Swap completion preset
    let presetSwapped = false;
    if (summaryPresetName && currentPreset !== null) {
        try {
            await ctx.executeSlashCommandsWithOptions(`/preset ${summaryPresetName}`);
            dmmLog(`Switched to summary preset: "${summaryPresetName}"`);
            presetSwapped = true;
        } catch (e) {
            console.warn(`[${EXT_NAME}] Could not switch to summary preset "${summaryPresetName}":`, e);
        }
    }

    // 4. Run, then restore in finally
    try {
        return await fn();
    } finally {
        // Restore profile first, then preset
        if (profileSwapped && previousProfile && previousProfile !== '<None>') {
            try {
                await profileCmd.callback({ await: 'false' }, previousProfile);
                dmmLog(`Restored profile: "${previousProfile}"`);
            } catch (e) {
                console.warn(`[${EXT_NAME}] Could not restore profile "${previousProfile}":`, e);
            }
        }
        if (presetSwapped && currentPreset) {
            try {
                await ctx.executeSlashCommandsWithOptions(`/preset ${currentPreset}`);
                dmmLog(`Restored preset: "${currentPreset}"`);
            } catch (e) {
                console.warn(`[${EXT_NAME}] Could not restore preset "${currentPreset}":`, e);
            }
        }
    }
}

// ── Core generation ──────────────────────────────────────────────────────────

/**
 * Count of concurrent generateRaw scribe calls in progress.
 * Non-zero means summarization is active. Integer rather than boolean
 * so nested/parallel calls (e.g. future bulk parallelism) stay correct.
 * The injection hook in index.js checks this to skip memory injection.
 */
export let isSummarizing = 0;

/**
 * Generate a memory summary from already-collected and filtered messages.
 *
 * Uses generateRaw so only our scribe prompt is sent to the LLM — no chat
 * history, no lorebooks, no other extension injections. Instruct template
 * tokens are applied automatically by ST based on the current model config.
 *
 * @param {string}   charName
 * @param {object[]} filteredMessages
 * @param {object}   [settings]  extension settings — used for profile swap
 * @returns {Promise<string>}
 */
export async function generateMemorySummary(charName, filteredMessages, settings = null) {
    if (!filteredMessages || filteredMessages.length === 0) {
        throw new Error(`[${EXT_NAME}] No messages to summarize for "${charName}"`);
    }

    const promptTemplate   = settings?.generationPrompt || DEFAULT_GENERATION_PROMPT;
    const prompt           = buildPrompt(charName, filteredMessages, promptTemplate);
    const summaryProfile   = settings?.summaryConnectionProfile || '';
    const summaryPreset    = settings?.summaryCompletionPreset || '';
    const includeLorebooks  = settings?.includeLorebooksDuringSum ?? false;
    const excludedLorebooks = settings?.excludedLorebooks ?? [];

    dmmLog(`Summarizing ${filteredMessages.length} messages for "${charName}", prompt length: ${prompt.length} chars`);

    dmmLog(`Lorebook inclusion: ${includeLorebooks ? 'enabled' : 'disabled'}${excludedLorebooks.length ? ` (blocking: ${excludedLorebooks.join(', ')})` : ''}`);
    const systemPrompt = includeLorebooks
        ? await getActivatedLorebookContent(filteredMessages, charName, excludedLorebooks)
        : '';

    isSummarizing++;
    let result;
    try {
        result = await withSummaryEnvironment(summaryProfile, summaryPreset, () =>
            generateRaw({ prompt, systemPrompt: systemPrompt || undefined }),
        );
    } finally {
        isSummarizing--;
    }

    if (!result || !result.trim()) {
        throw new Error(`[${EXT_NAME}] Empty response from LLM for "${charName}"`);
    }

    const trimmed = result.trim();
    dmmLog(`Memory summary for "${charName}": ${trimmed.length} chars — "${trimmed.slice(0, 80)}${trimmed.length > 80 ? '…' : ''}"`);
    return trimmed;
}

// ── Convenience pipeline: collect → filter → summarize ───────────────────────

/**
 * Full pipeline: collect by mode → presence-filter → summarize.
 * This is what the MM flow and console helper both call.
 *
 * @param {string}   charName
 * @param {'manual'|'last_summary'|'markers'} mode
 * @param {string}   [rangeStr]   required for mode 'manual'
 * @param {object}   [settings]   extension settings — passed through to profile swap
 * @returns {Promise<{ summary: string, startIndex: number, endIndex: number, messageCount: number }>}
 */
export async function collectFilterAndSummarize(charName, mode, rangeStr = '', settings = null) {
    const { messages, startIndex, endIndex } = collectAndFilter(mode, charName, rangeStr);

    if (messages.length === 0) {
        throw new Error(
            `[${EXT_NAME}] No messages remain for "${charName}" after presence filter ` +
            `(range ${startIndex}–${endIndex}). ` +
            `Check that the Presence extension is active and has logged this character.`,
        );
    }

    const summary = await generateMemorySummary(charName, messages, settings);
    return { summary, startIndex, endIndex, messageCount: messages.length };
}

// ── Summary cleaning ─────────────────────────────────────────────────────────

/**
 * Strip reasoning blocks and custom strings from a generated summary.
 * Called at save time — before token count is computed.
 *
 * @param {string} text     raw summary from LLM
 * @param {object} settings extension settings
 * @returns {string}
 */
export function cleanSummary(text, settings) {
    let result = text;

    // Strip reasoning blocks using ST's configured prefix/suffix
    if (settings?.stripReasoningBlocks !== false) {
        const prefix = power_user?.reasoning?.prefix;
        const suffix = power_user?.reasoning?.suffix;
        if (prefix && suffix) {
            const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(esc(prefix) + '[\\s\\S]*?' + esc(suffix), 'g'), '');
            dmmDevLog(`cleanSummary: stripped reasoning blocks (prefix="${prefix}", suffix="${suffix}")`);
        }
    }

    // Strip custom strings literally
    const stripStrings = settings?.stripStrings ?? [];
    for (const s of stripStrings) {
        if (!s) continue;
        result = result.split(s).join('');
    }
    if (stripStrings.length) {
        dmmDevLog(`cleanSummary: stripped ${stripStrings.length} custom string(s)`);
    }

    return result.trim();
}

// ── Dev console helpers ──────────────────────────────────────────────────────
// Quick sanity-check: runs the full pipeline and logs result.
//   DMM.summarize('Ivrene', 'manual', '0-10')
//   DMM.summarize('Ivrene', 'last_summary')
//   DMM.summarize('Ivrene', 'markers')

if (typeof window !== 'undefined') {
    window.DMM = window.DMM || {};
    Object.assign(window.DMM, {
        summarize: collectFilterAndSummarize,
        buildPrompt,
    });
}
