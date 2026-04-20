// injector.js — Step 7: inject active memories into ST's prompt pipeline

import { setExtensionPrompt, extension_prompt_types } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { MODULE_NAME } from './constants.js';
import { getCharMemories } from './memory-manager.js';
import { dmmLog, dmmDevLog } from './logger.js';

// ── Temporary message hiding ──────────────────────────────────────────────────
//
// Uses the same mechanism as ST's /hide slash command: set is_system=true on
// messages 0..maxEnd during the BEFORE→AFTER prompt assembly window.
// This is the correct approach because:
//  - ST's context builder excludes is_system=true messages from the LLM prompt
//  - qvink respects is_system=true via its include_system_messages:false default
// Only messages we marked (extra.dmm_temp_hidden=true) are restored — we don't
// touch messages that were already is_system before we ran.

let _tempHiddenIndices = [];

/**
 * Mark messages 0..maxEnd as is_system=true so ST and qvink exclude them from
 * context during this generation pass. Call restoreHiddenMessages() in
 * AFTER_COMBINE_PROMPTS to undo.
 */
export function hideMessagesUpToRange(charName) {
    const ctx      = getContext();
    const memories = getCharMemories(charName).filter(m => m.active);
    dmmDevLog(`hideMessagesUpToRange("${charName}"): ${memories.length} active memories`, memories.map(m => ({ range: m.message_range, id: m.id })));
    if (!memories.length) return;

    let maxEnd = -1;
    for (const m of memories) {
        const end = parseInt((m.message_range || '').split('-')[1], 10);
        if (!isNaN(end) && end > maxEnd) maxEnd = end;
    }
    dmmDevLog(`hideMessagesUpToRange: maxEnd=${maxEnd}, chat.length=${ctx.chat.length}`);
    if (maxEnd < 0) return;

    _tempHiddenIndices = [];
    for (let i = 0; i <= maxEnd && i < ctx.chat.length; i++) {
        const msg = ctx.chat[i];
        if (!msg || msg.is_system || msg.extra?.dmm_temp_hidden) continue;
        msg.is_system = true;
        if (!msg.extra) msg.extra = {};
        msg.extra.dmm_temp_hidden = true;
        _tempHiddenIndices.push(i);
    }

    if (_tempHiddenIndices.length) {
        dmmLog(`Hide: marked ${_tempHiddenIndices.length} messages (0–${maxEnd}) is_system for "${charName}"`);
        dmmDevLog(`Hide indices: [${_tempHiddenIndices.join(', ')}]`);
    }
}

/**
 * Restore all messages hidden by the current generation pass.
 * Safe to call even if hideMessagesUpToRange was never called.
 * @returns {number} count of messages restored
 */
export function restoreHiddenMessages() {
    const ctx = getContext();
    let restored = 0;
    for (const i of _tempHiddenIndices) {
        const msg = ctx.chat[i];
        if (msg?.extra?.dmm_temp_hidden) {
            msg.is_system = false;
            delete msg.extra.dmm_temp_hidden;
            restored++;
        }
    }
    _tempHiddenIndices = [];
    if (restored) dmmLog(`Restore: unmasked ${restored} messages`);
    return restored;
}

/**
 * Log a three-layer breakdown: DMM-hidden | qvink-summarized | raw.
 * Called after hideMessagesUpToRange. Hidden messages are is_system=true
 * with extra.dmm_temp_hidden set.
 */
export function logLayerDiagnostic(charName) {
    const ctx = getContext();
    if (!ctx?.chat) return;

    const qvinkPresent  = ctx.chat.some(m => m?.extra?.qvink_memory !== undefined);
    const qvinkSettings = window.extension_settings?.['qvink_memory'];
    dmmDevLog(`Layer diagnostic for "${charName}" — qvink: ${qvinkPresent ? 'present' : 'not found'}${qvinkSettings ? `, include_system_messages: ${qvinkSettings.include_system_messages ?? false}` : ''}`);

    const hidden = [], qvink = [], raw = [];
    for (let i = 0; i < ctx.chat.length; i++) {
        const msg = ctx.chat[i];
        if (msg?.extra?.dmm_temp_hidden) {
            hidden.push(i);
        } else if (msg?.extra?.qvink_memory?.include != null) {
            qvink.push(i);
        } else {
            raw.push(i);
        }
    }

    dmmDevLog(`Layers: DMM-hidden=[${hidden[0] ?? '—'}–${hidden.at(-1) ?? '—'}] (${hidden.length}) | qvink-summarized=[${qvink[0] ?? '—'}–${qvink.at(-1) ?? '—'}] (${qvink.length}) | raw=[${raw[0] ?? '—'}–${raw.at(-1) ?? '—'}] (${raw.length})`);
}

/**
 * Startup recovery — scan for any messages left hidden by a crashed/interrupted
 * session and restore them.
 */
export function recoverTempHiddenMessages() {
    const ctx = getContext();
    if (!ctx?.chat) return 0;
    let recovered = 0;
    for (const msg of ctx.chat) {
        if (msg?.extra?.dmm_temp_hidden) {
            msg.is_system = false;
            delete msg.extra.dmm_temp_hidden;
            recovered++;
        }
    }
    return recovered;
}

export const INJECT_KEY = `${MODULE_NAME}_memories`;

// ── Position map ─────────────────────────────────────────────────────────────
// Maps named positions to (type, depth) for setExtensionPrompt.
// at_depth is handled dynamically using per-memory or global settings.

const POSITION_MAP = {
    after_world_info:  { type: extension_prompt_types.IN_PROMPT,     depth: 0 },
    before_world_info: { type: extension_prompt_types.BEFORE_PROMPT, depth: 0 },
    after_system:      { type: extension_prompt_types.IN_PROMPT,     depth: 0 },
    after_char_desc:   { type: extension_prompt_types.IN_CHAT,       depth: 4 },
    before_chat:       { type: extension_prompt_types.IN_CHAT,       depth: 1 },
};

// setExtensionPrompt role arg: 0=system, 1=user, 2=assistant
const ROLE_MAP = { system: 0, user: 1, assistant: 2 };

// ── Injection slot tracking ───────────────────────────────────────────────────
// Each unique (type, depth, role) combination gets its own setExtensionPrompt
// key so memories at different intensities inject at different positions.
// All active keys are cleared at the start of every generation.

const _activeKeys = new Set();

// ── Text assembly ─────────────────────────────────────────────────────────────

function buildInjectionText(charName, memories, template) {
    const sorted = [...memories].sort((a, b) => a.created_at_message - b.created_at_message);
    const block  = sorted
        .map(m => template
            .replace(/\{\{summary\}\}/g, m.summary)
            .replace(/\{\{char\}\}/g, charName))
        .join('\n\n');
    return `<memories>\n${block}\n</memories>`;
}

// ── Slot resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the effective injection slot for a single memory entry.
 * Per-entry fields take precedence over global settings.
 *
 * @param {object} memory   memory entry (may have injectionPosition/Depth/Role)
 * @param {object} settings extension_settings[MODULE_NAME]
 * @returns {{ type: number, depth: number, role: number }}
 */
function resolveSlot(memory, settings) {
    const pos = memory.injectionPosition ?? settings?.injectionPosition ?? 'after_world_info';

    if (pos === 'at_depth') {
        const depth = memory.injectionDepth ?? settings?.injectionDepth ?? 5;
        const role  = ROLE_MAP[memory.injectionRole ?? settings?.injectionRole ?? 'system'] ?? 0;
        return { type: extension_prompt_types.IN_CHAT, depth, role };
    }

    const p = POSITION_MAP[pos] ?? POSITION_MAP.after_world_info;
    return { type: p.type, depth: p.depth, role: 0 };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Clear all active injection slots and re-inject memories for the currently
 * generating character, grouped by their effective injection slot.
 *
 * @param {object} settings  extension_settings[MODULE_NAME]
 */
export function onBeforeGenerate(settings, charName) {
    // Clear every slot registered during the last generation.
    _activeKeys.forEach(key => setExtensionPrompt(key, '', extension_prompt_types.IN_PROMPT, 0));
    _activeKeys.clear();

    if (!charName) return;
    const memories = getCharMemories(charName);
    let active     = memories.filter(m => m.active);
    if (!active.length) return;

    const template        = settings?.injectionTemplate || '{{summary}}';
    const maxInjectionChars = settings?.maxInjectionChars ?? 0;

    // Apply bloat cap — newest memories win, oldest are dropped first.
    const totalChars = active.reduce((sum, m) => sum + (m.summary || '').length, 0);
    dmmDevLog(`Injection: ${active.length} active memories, ${totalChars} total chars, cap ${maxInjectionChars || 'unlimited'}`);

    if (maxInjectionChars > 0 && active.length > 0) {
        const byNewest = [...active].sort((a, b) => b.created_at_message - a.created_at_message);
        const kept = [];
        let total = 0;
        for (const m of byNewest) {
            const len = (m.summary || '').length;
            if (total + len > maxInjectionChars) break;
            kept.push(m);
            total += len;
        }
        if (kept.length < active.length) {
            dmmLog(`Bloat cap: keeping ${kept.length}/${active.length} memories (${total} chars, cap ${maxInjectionChars})`);
        }
        dmmDevLog(`Bloat cap result: kept ${kept.length}/${active.length} (${total} chars)`);
        active = kept;
    }

    // Group memories by their effective slot signature.
    const groups = new Map(); // sig → { type, depth, role, memories[] }

    for (const memory of active) {
        const { type, depth, role } = resolveSlot(memory, settings);
        const sig = `${type}_${depth}_${role}`;
        if (!groups.has(sig)) groups.set(sig, { type, depth, role, memories: [] });
        groups.get(sig).memories.push(memory);
    }

    for (const [sig, { type, depth, role, memories: grp }] of groups) {
        const key  = `${INJECT_KEY}_${sig}`;
        const text = buildInjectionText(charName, grp, template);
        setExtensionPrompt(key, text, type, depth, false, role);
        _activeKeys.add(key);
        dmmLog(`Injected ${grp.length} mem for "${charName}" (type=${type}, depth=${depth}, role=${role})`);
    }
}

/**
 * Clear all injection slots — called when no memories should reach the prompt
 * (summarization pass, no active character, etc.).
 */
export function clearInjection() {
    _activeKeys.forEach(key => setExtensionPrompt(key, '', extension_prompt_types.IN_PROMPT, 0));
    _activeKeys.clear();
    // Also clear the legacy single-key slot in case an older version left it.
    setExtensionPrompt(INJECT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}
