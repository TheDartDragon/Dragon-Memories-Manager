// summarizer.js — Step 4: fire generateQuietPrompt with filtered transcript
//
// Console test (after Steps 1-3 verified):
//   DMM.summarize('Ivrene', 'manual', '0-10')
//   DMM.summarize('Ivrene', 'last_summary')
//   DMM.summarize('Ivrene', 'markers')   // requires markers set first

import { generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { EXT_NAME } from './constants.js';
import { collectAndFilter } from './memory-manager.js';
import { dmmLog } from './logger.js';

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

// ── Profile swap ─────────────────────────────────────────────────────────────

/**
 * Run `fn` while optionally swapped to the user's summarization connection
 * profile, restoring the original profile afterward.
 *
 * If no summary profile is configured, or if the connection-manager slash
 * command isn't available, `fn` runs with the current profile unchanged.
 *
 * @param {string} summaryProfileName  from extension settings (empty = no swap)
 * @param {Function} fn                async function to run inside the swap
 * @returns {Promise<*>}
 */
async function withSummaryProfile(summaryProfileName, fn) {
    const ctx           = getContext();
    const profileCmd    = ctx.SlashCommandParser?.commands?.['profile'];

    // If no profile configured or command unavailable, just run
    if (!summaryProfileName || !profileCmd) {
        if (summaryProfileName && !profileCmd) {
            console.warn(`[${EXT_NAME}] Connection Manager not available — running with current profile`);
        }
        return await fn();
    }

    // Read current profile name
    let previousProfile = null;
    try {
        previousProfile = await profileCmd.callback({}, '');
    } catch (e) {
        console.warn(`[${EXT_NAME}] Could not read current connection profile:`, e);
    }

    // Switch to summary profile
    try {
        await profileCmd.callback({ await: 'true' }, summaryProfileName);
        dmmLog(`Switched to summary profile: "${summaryProfileName}"`);
    } catch (e) {
        console.warn(`[${EXT_NAME}] Could not switch to summary profile "${summaryProfileName}" — running with current profile:`, e);
        return await fn();
    }

    try {
        return await fn();
    } finally {
        // Always restore, even on error
        if (previousProfile && previousProfile !== '<None>') {
            try {
                await profileCmd.callback({ await: 'false' }, previousProfile);
                dmmLog(`Restored profile: "${previousProfile}"`);
            } catch (e) {
                console.warn(`[${EXT_NAME}] Could not restore profile "${previousProfile}":`, e);
            }
        }
    }
}

// ── Core generation ──────────────────────────────────────────────────────────

/**
 * True while our summarizer is running a generateQuietPrompt call.
 * The injection hook in index.js checks this to skip memory injection
 * during summarization (we don't want memories in the scribe prompt).
 */
export let isSummarizing = false;

/**
 * Generate a memory summary from already-collected and filtered messages.
 * Returns the raw trimmed LLM output.
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

    const promptTemplate = settings?.generationPrompt || DEFAULT_GENERATION_PROMPT;
    const prompt = buildPrompt(charName, filteredMessages, promptTemplate);

    dmmLog(`Summarizing ${filteredMessages.length} messages for "${charName}", prompt length: ${prompt.length} chars`);

    const summaryProfile = settings?.summaryConnectionProfile || '';

    isSummarizing = true;
    let result;
    try {
        result = await withSummaryProfile(summaryProfile, () =>
            generateQuietPrompt({ quietPrompt: prompt, skipWIAN: true }),
        );
    } finally {
        isSummarizing = false;
    }

    if (!result || !result.trim()) {
        throw new Error(`[${EXT_NAME}] Empty response from LLM for "${charName}"`);
    }

    const trimmed = result.trim();
    dmmLog(`Memory summary for "${charName}":`, trimmed);
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

// ── Dev console helpers ──────────────────────────────────────────────────────
// Quick sanity-check: runs the full pipeline and logs result.
//   DMM.summarize('Ivrene', 'manual', '0-10')
//   DMM.summarize('Ivrene', 'last_summary')
//   DMM.summarize('Ivrene', 'markers')

if (typeof window !== 'undefined') {
    window.DMM = window.DMM || {};
    Object.assign(window.DMM, {
        summarize: collectFilterAndSummarize,
        buildPrompt,          // expose for inspecting the prompt before firing
    });
}
