// memory-manager.js
// Owns all reads/writes to chat_metadata.scene_memory, plus message collection.
//
// chat_metadata.scene_memory schema:
// {
//   [charName]: [
//     {
//       id, summary, created_at_message, message_range,
//       lifespan, char_message_count, active, format_template
//     }
//   ],
//   _markers: { [charName]: { start: N, end: M } }
// }

import { getContext } from '../../../extensions.js';
import { EXT_NAME } from './constants.js';
import { dmmLog } from './logger.js';

// ── Storage helpers ──────────────────────────────────────────────────────────

function getStore() {
    const ctx = getContext();
    if (!ctx.chatMetadata.scene_memory) {
        ctx.chatMetadata.scene_memory = {};
    }
    return ctx.chatMetadata.scene_memory;
}

export function getCharMemories(charName) {
    const store = getStore();
    return Array.isArray(store[charName]) ? store[charName] : [];
}

export function saveMemories() {
    getContext().saveMetadata();
}

// ── Message collection ───────────────────────────────────────────────────────

/**
 * Collect raw chat messages between two indices (inclusive).
 * Excludes system messages injected by this extension (ghost flag).
 *
 * @param {number} startIndex
 * @param {number} endIndex
 * @returns {{ messages: object[], startIndex: number, endIndex: number }}
 */
export function collectMessageRange(startIndex, endIndex) {
    const ctx = getContext();
    const total = ctx.chat.length;

    const start = Math.max(0, startIndex);
    const end   = Math.min(total - 1, endIndex);

    if (start > end) {
        console.warn(`[${EXT_NAME}] collectMessageRange: empty range ${start}–${end} (chat length: ${total})`);
        return { messages: [], startIndex: start, endIndex: end };
    }

    const messages = ctx.chat
        .slice(start, end + 1)
        .filter(msg => !msg.extra?.scene_memory_ghost);

    dmmLog(`Collected ${messages.length} messages (indices ${start}–${end}, ${end - start + 1} total, ${(end - start + 1) - messages.length} ghost-filtered)`);
    return { messages, startIndex: start, endIndex: end };
}

// ── Mode 1: Manual range ─────────────────────────────────────────────────────

/**
 * Parse a user-supplied "start-end" string and collect.
 * Accepts "23-67", "23–67" (en-dash), or "23 - 67".
 *
 * @param {string} rangeStr
 * @returns {{ messages: object[], startIndex: number, endIndex: number }}
 */
export function collectRangeManual(rangeStr) {
    const match = String(rangeStr).trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (!match) {
        throw new Error(`[${EXT_NAME}] Invalid range format: "${rangeStr}" — use "23-67"`);
    }
    const start = parseInt(match[1], 10);
    const end   = parseInt(match[2], 10);
    if (start > end) {
        throw new Error(`[${EXT_NAME}] Range start (${start}) must be ≤ end (${end})`);
    }
    return collectMessageRange(start, end);
}

// ── Mode 2: From last summary ────────────────────────────────────────────────

/**
 * Record the last message index that was included in a completed summary for
 * charName.  Called by ui.js saveMemory after a successful save.
 *
 * @param {string} charName
 * @param {number} endIndex  last message index that was summarized
 */
export function setLastSummarizedAt(charName, endIndex) {
    const store = getStore();
    if (!store._lastSummarizedAt) store._lastSummarizedAt = {};
    store._lastSummarizedAt[charName] = endIndex;
    saveMemories();
    dmmLog(`setLastSummarizedAt ["${charName}"] = msg #${endIndex}`);
}

/**
 * Clear the "From Last Summary" range tracking for a character, so the next
 * summary using that mode will start from message 0.
 *
 * @param {string} charName
 */
export function clearLastSummarizedAt(charName) {
    const store = getStore();
    if (store._lastSummarizedAt?.[charName] != null) {
        delete store._lastSummarizedAt[charName];
        saveMemories();
        dmmLog(`clearLastSummarizedAt ["${charName}"]`);
    }
}

/**
 * Start from the message immediately after the last completed summary for
 * charName.  Prefers the explicit _lastSummarizedAt tracking; falls back to
 * scanning active memories for backward compat.
 *
 * @param {string} charName
 * @returns {{ messages: object[], startIndex: number, endIndex: number }}
 */
export function collectRangeFromLastSummary(charName) {
    const ctx  = getContext();
    let startIndex = 0;

    const store  = getStore();
    const lastAt = store._lastSummarizedAt?.[charName] ?? null;

    if (lastAt !== null) {
        startIndex = lastAt + 1;
        dmmLog(`Mode 2 [${charName}]: lastSummarizedAt = msg #${lastAt}, collecting from #${startIndex}`);
    } else {
        // Backward-compat fallback: find the latest active memory
        const memories = getCharMemories(charName);
        const active   = memories.filter(m => m.active);
        if (active.length > 0) {
            const latest = active.reduce((a, b) =>
                a.created_at_message > b.created_at_message ? a : b,
            );
            startIndex = latest.created_at_message + 1;
            dmmLog(`Mode 2 [${charName}]: fallback to active memory at msg #${latest.created_at_message}, collecting from #${startIndex}`);
        } else {
            dmmLog(`Mode 2 [${charName}]: no prior data, collecting from #0`);
        }
    }

    const endIndex = ctx.chat.length - 1;

    if (startIndex > endIndex) {
        console.warn(`[${EXT_NAME}] Mode 2 [${charName}]: no new messages since last summary`);
        return { messages: [], startIndex, endIndex };
    }

    return collectMessageRange(startIndex, endIndex);
}

// ── Mode 3: Markers ──────────────────────────────────────────────────────────

/**
 * Store a START or END marker for charName.
 * Called by message click handlers added in Step 5.
 *
 * @param {string} charName
 * @param {'start'|'end'} type
 * @param {number} messageIndex
 */
export function setMarker(charName, type, messageIndex) {
    const store = getStore();
    if (!store._markers)               store._markers = {};
    if (!store._markers[charName])     store._markers[charName] = {};
    store._markers[charName][type] = messageIndex;
    saveMemories();
    dmmLog(`Marker [${charName}] ${type} = ${messageIndex}`);
}

/**
 * @param {string} charName
 * @returns {{ start: number, end: number }|null}
 */
export function getMarkers(charName) {
    return getStore()._markers?.[charName] ?? null;
}

export function clearMarkers(charName) {
    const store = getStore();
    if (store._markers?.[charName]) {
        delete store._markers[charName];
        saveMemories();
    }
}

/**
 * Collect from previously set markers.
 *
 * @param {string} charName
 * @returns {{ messages: object[], startIndex: number, endIndex: number }}
 */
export function collectRangeFromMarkers(charName) {
    const markers = getMarkers(charName);
    if (!markers || markers.start == null || markers.end == null) {
        throw new Error(`[${EXT_NAME}] No complete markers set for "${charName}" — set both START and END first`);
    }
    return collectMessageRange(markers.start, markers.end);
}

// ── Unified entry point ──────────────────────────────────────────────────────

/**
 * Collect messages using the specified mode.
 *
 * @param {'manual'|'last_summary'|'markers'} mode
 * @param {string} charName
 * @param {string} [rangeStr]  required for mode 'manual'
 * @returns {{ messages: object[], startIndex: number, endIndex: number }}
 */
export function collectMessages(mode, charName, rangeStr = '') {
    switch (mode) {
        case 'manual':       return collectRangeManual(rangeStr);
        case 'last_summary': return collectRangeFromLastSummary(charName);
        case 'markers':      return collectRangeFromMarkers(charName);
        default: throw new Error(`[${EXT_NAME}] Unknown collection mode: "${mode}"`);
    }
}

// ── Presence filter ──────────────────────────────────────────────────────────

/**
 * Resolve a character's avatar filename from context.characters.
 * Returns null if the character cannot be found.
 *
 * @param {string} charName
 * @returns {string|null}  e.g. "Ivrene.png"
 */
export function resolveCharAvatar(charName) {
    const ctx  = getContext();
    const char = ctx.characters.find(c => c.name === charName);
    if (!char) {
        console.warn(`[${EXT_NAME}] resolveCharAvatar: no character named "${charName}" in context`);
        return null;
    }
    return char.avatar ?? null;
}

/**
 * Filter a message list to only those where charName was present.
 *
 * Rules (per CLAUDE.md):
 *  - No presence data (msg.present missing or empty) → include (old messages / edge cases)
 *  - msg.present includes targetAvatar → include
 *  - Otherwise → exclude
 *
 * If the character cannot be resolved to an avatar, all messages are returned
 * unchanged with a warning rather than silently discarding everything.
 *
 * @param {object[]} messages   raw message objects from context.chat
 * @param {string}   charName   target character name
 * @returns {object[]}
 */
export function filterMessagesByPresence(messages, charName) {
    const targetAvatar = resolveCharAvatar(charName);

    if (!targetAvatar) {
        console.warn(`[${EXT_NAME}] filterMessagesByPresence: cannot resolve avatar for "${charName}" — skipping presence filter`);
        return messages;
    }

    const kept    = [];
    const dropped = [];

    for (const msg of messages) {
        // No presence data → include unconditionally
        if (!msg.present || msg.present.length === 0) {
            kept.push(msg);
            continue;
        }
        if (msg.present.includes(targetAvatar)) {
            kept.push(msg);
        } else {
            dropped.push(msg);
        }
    }

    dmmLog(
        `Presence filter [${charName} / ${targetAvatar}]: ` +
        `${kept.length} kept, ${dropped.length} dropped` +
        (dropped.length > 0
            ? ` (from: ${dropped.map(m => m.name || 'user').join(', ')})`
            : ''),
    );

    return kept;
}

/**
 * Full pipeline: collect by mode → presence-filter → return.
 * This is the function the summarizer (Step 4) and MM flow (Step 5) should call.
 *
 * @param {'manual'|'last_summary'|'markers'} mode
 * @param {string} charName
 * @param {string} [rangeStr]   required for mode 'manual'
 * @returns {{ messages: object[], startIndex: number, endIndex: number }}
 */
export function collectAndFilter(mode, charName, rangeStr = '') {
    const collected = collectMessages(mode, charName, rangeStr);
    const filtered  = filterMessagesByPresence(collected.messages, charName);
    return { ...collected, messages: filtered };
}

// ── Memory write / lifecycle ─────────────────────────────────────────────────

/**
 * Remove a single memory entry by id.
 *
 * @param {string} charName
 * @param {string} entryId
 */
export function deleteMemoryEntry(charName, entryId) {
    const store = getStore();
    if (!Array.isArray(store[charName])) return;
    store[charName] = store[charName].filter(e => e.id !== entryId);
    saveMemories();
    dmmLog(`Deleted memory entry ${entryId} for "${charName}"`);
}

/**
 * Move all memories (and associated metadata) from one character name to another.
 * Appends to the target's existing entries if any.
 * Returns the number of entries moved.
 *
 * @param {string} fromName
 * @param {string} toName
 * @returns {number}
 */
export function reassignCharMemories(fromName, toName) {
    const store = getStore();

    const entries = store[fromName];
    if (!Array.isArray(entries) || entries.length === 0) {
        console.warn(`[${EXT_NAME}] reassignCharMemories: no memories for "${fromName}"`);
        return 0;
    }

    if (!Array.isArray(store[toName])) store[toName] = [];
    store[toName].push(...entries);
    delete store[fromName];

    // Migrate _lastSummarizedAt — keep the later value
    if (store._lastSummarizedAt?.[fromName] != null) {
        if (!store._lastSummarizedAt) store._lastSummarizedAt = {};
        const fromVal = store._lastSummarizedAt[fromName];
        const toVal   = store._lastSummarizedAt[toName] ?? -1;
        store._lastSummarizedAt[toName] = Math.max(fromVal, toVal);
        delete store._lastSummarizedAt[fromName];
    }

    // Clear any stale markers for fromName
    if (store._markers?.[fromName]) delete store._markers[fromName];

    saveMemories();
    dmmLog(`Reassigned ${entries.length} memories from "${fromName}" to "${toName}"`);
    return entries.length;
}

/**
 * Move a single memory entry from one character to another.
 * Returns true if the entry was found and moved.
 *
 * @param {string} fromName
 * @param {string} entryId
 * @param {string} toName
 * @returns {boolean}
 */
export function reassignMemoryEntry(fromName, entryId, toName) {
    const store = getStore();
    if (!Array.isArray(store[fromName])) return false;

    const idx = store[fromName].findIndex(e => e.id === entryId);
    if (idx < 0) {
        console.warn(`[${EXT_NAME}] reassignMemoryEntry: entry ${entryId} not found for "${fromName}"`);
        return false;
    }

    const [entry] = store[fromName].splice(idx, 1);
    if (!Array.isArray(store[toName])) store[toName] = [];
    store[toName].push(entry);

    saveMemories();
    dmmLog(`Reassigned memory ${entryId} from "${fromName}" to "${toName}"`);
    return true;
}

/**
 * Delete all memories and associated metadata for a character.
 *
 * @param {string} charName
 */
export function deleteCharMemories(charName) {
    const store = getStore();
    delete store[charName];
    if (store._lastSummarizedAt?.[charName] != null) delete store._lastSummarizedAt[charName];
    if (store._markers?.[charName]) delete store._markers[charName];
    saveMemories();
    dmmLog(`Deleted all memories for "${charName}"`);
}

export function addMemoryEntry(charName, entry) {
    const store = getStore();
    if (!Array.isArray(store[charName])) store[charName] = [];
    store[charName].push(entry);
    saveMemories();
    dmmLog(`Memory entry saved for "${charName}":`, entry.id);
}

// ── Swipe rebuild helper ─────────────────────────────────────────────────────

/**
 * Re-render the last real AI message so ST builds its .swipes DOM node.
 *
 * ST only adds swipe arrows when addOneMessage is called for the message at
 * ctx.chat[length - 1].  Because ghost messages or user messages may sit after
 * the last AI message we have to:
 *   1. Temporarily splice trailing messages out of ctx.chat
 *   2. Await addOneMessage  (now the AI message IS at length-1 → swipes built)
 *   3. Restore the trailing messages
 *   4. Move the freshly appended DOM element back to its correct position
 *      (addOneMessage always appends to the END of #chat, so without step 4
 *      the element would appear after any real messages that follow it)
 */
async function _rebuildLastAiSwipes() {
    const ctx = getContext();

    // Find the last non-user, non-system AI message.
    let lastAiIdx = -1;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const m = ctx.chat[i];
        if (!m.is_user && !m.is_system) { lastAiIdx = i; break; }
    }
    if (lastAiIdx < 0) return;

    dmmLog(`Rebuilding swipes for message #${lastAiIdx}`);

    // Remove the existing DOM element for this message.
    $(`#chat .mes[mesid="${lastAiIdx}"]`).remove();

    // Splice everything after it out temporarily.
    const trailing = ctx.chat.splice(lastAiIdx + 1);

    // Now ctx.chat[length-1] === the AI message → ST will build .swipes.
    await ctx.addOneMessage(ctx.chat[lastAiIdx]);

    // Restore trailing messages.
    ctx.chat.push(...trailing);

    // Fix DOM order: addOneMessage always appends to the end of #chat.
    // If there are real (non-ghost) messages in trailing their DOM elements
    // are still in #chat between the old position and the newly appended one.
    // Find the predecessor element and insert right after it.
    if (trailing.length > 0) {
        const $rerendered = $(`#chat .mes[mesid="${lastAiIdx}"]`);
        for (let i = lastAiIdx - 1; i >= 0; i--) {
            const $prev = $(`#chat .mes[mesid="${i}"]`);
            if ($prev.length) {
                $prev.after($rerendered);
                break;
            }
        }
    }
}

// ── Ghost / removal ──────────────────────────────────────────────────────────

/**
 * Remove MM interaction messages from ctx.chat entirely and hide their DOM
 * elements, then rebuild swipe arrows on the preceding AI message.
 *
 * Ghost messages are always appended at the END of ctx.chat (they were the
 * last messages posted during the MM flow), so splicing them out does NOT
 * shift the indices of any real messages.
 *
 * Callers are responsible for calling ctx.saveChat() afterwards to persist
 * the removal.
 *
 * @param {number[]} messageIndices  indices into context.chat
 */
export async function ghostMMInteraction(messageIndices) {
    const ctx = getContext();

    // 1. Remove ghost DOM elements from the chat view.
    messageIndices.forEach(idx => {
        $(`#chat .mes[mesid="${idx}"]`).remove();
    });

    // 2. Splice ghost messages out of ctx.chat.
    //    Descending order so earlier indices stay valid during removal.
    [...messageIndices]
        .sort((a, b) => b - a)
        .forEach(idx => {
            if (idx >= 0 && idx < ctx.chat.length) ctx.chat.splice(idx, 1);
        });

    dmmLog(`Removed ${messageIndices.length} MM message(s) from ctx.chat. New length: ${ctx.chat.length}`);

    // 3. Re-render the last AI message with swipes in the correct DOM position.
    await _rebuildLastAiSwipes();

    saveMemories();
}

/**
 * Backward-compatibility migration for chats saved before the "splice-on-ghost"
 * approach was introduced.  Those chats have ghost messages still sitting in
 * ctx.chat (flagged with extra.scene_memory_ghost).  On CHAT_CHANGED we detect
 * and remove them, rebuild swipes, and re-save the chat.
 */
export async function rehideGhostMessages() {
    const ctx = getContext();
    if (!ctx.chatMetadata?.scene_memory) return;

    // Collect indices of legacy ghost messages still in ctx.chat.
    const ghostIndices = ctx.chat
        .map((msg, idx) => (msg.extra?.scene_memory_ghost ? idx : -1))
        .filter(i => i >= 0);

    if (ghostIndices.length === 0) return;

    dmmLog(`Migrating ${ghostIndices.length} legacy ghost message(s) out of ctx.chat`);

    // Remove from DOM.
    ghostIndices.forEach(idx => {
        $(`#chat .mes[mesid="${idx}"]`).remove();
    });

    // Splice from ctx.chat (descending to preserve lower indices).
    [...ghostIndices]
        .sort((a, b) => b - a)
        .forEach(idx => {
            if (idx >= 0 && idx < ctx.chat.length) ctx.chat.splice(idx, 1);
        });

    // Re-render last AI message with swipes.
    await _rebuildLastAiSwipes();

    // Persist the migration so this runs only once per chat.
    await ctx.saveChat();
}

// ── Lifespan ticking ─────────────────────────────────────────────────────────

/**
 * Increment char_message_count for every active memory belonging to
 * generatingCharName, and mark any that have reached their lifespan as inactive.
 *
 * @param {string} generatingCharName
 */
export function tickMemoryLifespans(generatingCharName) {
    const memories = getCharMemories(generatingCharName);
    let changed = false;

    memories.forEach(entry => {
        if (!entry.active) return;
        entry.char_message_count++;
        changed = true;
        const expired = entry.char_message_count >= entry.lifespan;
        if (expired) {
            entry.active = false;
            dmmLog(`Memory ${entry.id} for "${generatingCharName}" expired (${entry.char_message_count}/${entry.lifespan})`);
        } else {
            dmmLog(`Tick [${generatingCharName}] memory ${entry.id}: ${entry.char_message_count}/${entry.lifespan}`);
        }
    });

    if (changed) saveMemories();
}

// ── Dev console helpers ──────────────────────────────────────────────────────
// Collect only (no presence filter):
//   DMM.collect('manual', 'Ivrene', '0-10')
//   DMM.collect('last_summary', 'Ivrene')
//   DMM.collect('markers', 'Ivrene')
//
// Full pipeline (collect + presence filter):
//   DMM.collectFiltered('manual', 'Ivrene', '0-10')
//   DMM.collectFiltered('last_summary', 'Ivrene')
//
// Presence filter on an arbitrary array:
//   DMM.filterPresence(someMessages, 'Ivrene')
//
// Markers:
//   DMM.setMarker('Ivrene', 'start', 5)
//   DMM.setMarker('Ivrene', 'end', 20)

if (typeof window !== 'undefined') {
    window.DMM = window.DMM || {};
    Object.assign(window.DMM, {
        collect:             collectMessages,
        collectManual:       collectRangeManual,
        collectLastSummary:  collectRangeFromLastSummary,
        collectMarkers:      collectRangeFromMarkers,
        collectFiltered:     collectAndFilter,
        filterPresence:      filterMessagesByPresence,
        resolveCharAvatar,
        setMarker,
        getMarkers,
        clearMarkers,
        getCharMemories,
    });
}
