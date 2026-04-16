// ui.js — Step 5: MM in-chat conversation flow
//
// Flow: startMMFlow()
//   → showCharSelector()      Step 2: avatar buttons for each group member
//   → showRangeSelector()     Step 3: Manual / Last Summary / Markers
//   → runGeneration()         Step 4: loading → summary
//   → showReviewControls()    Step 5: lifespan + Save / Cancel
//   → saveMemory()            Step 6: write entry, ghost messages, save chat

import { getContext, extension_settings } from '../../../extensions.js';
import { getThumbnailUrl, saveSettingsDebounced } from '../../../../script.js';
import { getMessageTimeStamp } from '../../../RossAscends-mods.js';
import { uuidv4 } from '../../../utils.js';
import { MODULE_NAME, EXT_NAME, FOLDER_NAME } from './constants.js';
import { collectFilterAndSummarize } from './summarizer.js';
import { getSettings } from './index.js';
import {
    addMemoryEntry,
    deleteMemoryEntry,
    ghostMMInteraction,
    saveMemories,
    getCharMemories,
    setMarker,
    getMarkers,
    clearMarkers,
    setLastSummarizedAt,
    clearLastSummarizedAt,
    reassignMemoryEntry,
    deleteCharMemories,
} from './memory-manager.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { loadWorldInfo, createWorldInfoEntry, saveWorldInfo, createNewWorldInfo, world_names, world_info_position } from '../../../world-info.js';
import { dmmLog } from './logger.js';

// ── Interaction state ────────────────────────────────────────────────────────

/** @type {{ mmMsgIndices: number[], charName: string|null, rangeMode: string|null, rangeStr: string, startIndex: number|null, endIndex: number|null, lifespan: number }|null} */
let state = null;

function initState() {
    const s = extension_settings[MODULE_NAME];
    state = {
        mmMsgIndices:      [],
        charName:          null,
        rangeMode:         null,
        rangeStr:          '',
        startIndex:        null,
        endIndex:          null,
        lifespan:          s?.defaultLifespan ?? 20,
        injectionOverride: null,  // { position, depth, role } or null = use global
    };
}

let _mmCooldownUntil = 0;

function resetState() {
    state = null;
    // Give deferred CHARACTER_MESSAGE_RENDERED events (from ghostMMInteraction's
    // addOneMessage re-render) a short window to fire without ticking lifespans.
    _mmCooldownUntil = Date.now() + 500;
}

// ── MM identity ──────────────────────────────────────────────────────────────

function getMMIdentity() {
    const s = extension_settings[MODULE_NAME];
    const name = s?.mmName || 'Memories Manager';
    let avatar;
    if (s?.mmAvatarDataUrl) {
        avatar = s.mmAvatarDataUrl;
    } else if (s?.mmAvatar) {
        avatar = getThumbnailUrl('avatar', s.mmAvatar);
    } else {
        avatar = `scripts/extensions/third-party/${FOLDER_NAME}/assets/default-avatar.png`;
    }
    return { name, avatar };
}

// ── Message helpers ──────────────────────────────────────────────────────────

/**
 * Post a message from the MM character into the ST chat.
 * Tracks the index in state.mmMsgIndices.
 * Returns { idx, $el }.
 */
async function postMMMessage(text) {
    const ctx = getContext();
    const { name, avatar } = getMMIdentity();

    const msg = {
        name,
        is_user:      false,
        is_system:    false,
        force_avatar: avatar,
        send_date:    getMessageTimeStamp(),
        mes:          text,
        extra:        { scene_memory_ghost: true },
        swipes:       [text],
        swipe_id:     0,
    };

    ctx.chat.push(msg);
    const idx = ctx.chat.length - 1;
    ctx.addOneMessage(msg);

    if (state) state.mmMsgIndices.push(idx);

    return { idx, $el: getMsgEl(idx) };
}

/** jQuery element for a rendered message by chat index. */
function getMsgEl(idx) {
    return $(`#chat .mes[mesid="${idx}"]`);
}

/**
 * Update the text of an existing MM message and re-render its mes_text.
 * Controls appended to .mes_block (outside .mes_text) are preserved.
 */
function updateMMMessage(idx, newText) {
    const ctx = getContext();
    ctx.chat[idx].mes      = newText;
    ctx.chat[idx].swipes   = [newText];
    ctx.addOneMessage(ctx.chat[idx], { type: 'swipe', forceId: idx });
}

// ── Step 2: Character selector ───────────────────────────────────────────────

/**
 * Returns true if any recent message carries Presence extension data.
 * Used to decide whether char selection and presence filtering make sense.
 */
function isPresenceActive() {
    const ctx = getContext();
    return ctx.chat.slice(-30).some(msg => Array.isArray(msg.present) && msg.present.length > 0);
}

async function showCharSelector() {
    const ctx = getContext();

    // Non-group chat, or group chat without Presence data: auto-select
    if (!ctx.groupId || !isPresenceActive()) {
        let char = null;
        if (ctx.groupId) {
            // Group chat but no Presence — pick the last non-user, non-ghost AI message's char
            const group  = ctx.groups.find(g => g.id === ctx.groupId);
            const lastAI = [...ctx.chat].reverse().find(m => !m.is_user && !m.extra?.scene_memory_ghost && m.name);
            const name   = lastAI?.name;
            char = (group?.members ?? [])
                .map(av => ctx.characters.find(c => c.avatar === av))
                .find(c => c?.name === name)
                ?? ctx.characters.find(c =>
                    (group?.members ?? []).includes(c.avatar));
            if (char) toastr.info(`Presence not detected — creating memory for ${char.name}.`, EXT_NAME);
        } else {
            char = ctx.characters[ctx.characterId];
        }
        if (!char) {
            toastr.error('No active character found.', EXT_NAME);
            resetState();
            return;
        }
        state.charName = char.name;
        dmmLog('Char auto-selected (no group or no Presence data)', { char: char.name, isGroup: !!ctx.groupId });
        await showRangeSelector();
        return;
    }

    // Group chat with Presence: show avatar selector
    const group = ctx.groups.find(g => g.id === ctx.groupId);
    const chars = (group?.members ?? [])
        .map(av => ctx.characters.find(c => c.avatar === av))
        .filter(Boolean);

    if (!chars.length) {
        toastr.error('No characters found in this group.', EXT_NAME);
        resetState();
        return;
    }

    const { idx: selectorMsgIdx, $el } = await postMMMessage('Create memory for which character?');
    const $row    = $('<div class="dmm-char-selector flex-container flexGap10 flexWrap">');

    chars.forEach(char => {
        const avatarUrl = getThumbnailUrl('avatar', char.avatar);
        const $btn = $(`
            <button class="dmm-char-btn menu_button interactable" tabindex="0">
                <img src="${avatarUrl}" class="dmm-char-avatar"
                     onerror="this.style.display='none'" />
                <span>${char.name}</span>
            </button>
        `);
        $btn.on('click', async () => {
            $row.find('.dmm-char-btn').prop('disabled', true).removeClass('dmm-selected');
            $btn.addClass('dmm-selected');
            state.charName = char.name;
            dmmLog('Char selected by user', { char: char.name });
            await ctx.saveChat();
            await showRangeSelector();
        });
        $row.append($btn);
    });

    const $bulkRow = $('<div class="flex-container flexFlowColumn flexGap5 mt5">');
    $bulkRow.append('<div class="opacity50p" style="text-align:center;font-size:0.85em;border-top:1px solid var(--SmartThemeBorderColor);padding-top:5px">— or —</div>');
    const $bulkBtn = $('<button class="menu_button interactable" title="Generate a memory for every character in this chat using all available messages. The first result is saved automatically with default settings — a quick baseline to review later.">All Remember All</button>');
    $bulkBtn.on('click', async () => {
        $row.find('.dmm-char-btn').prop('disabled', true);
        $bulkBtn.prop('disabled', true);
        $cancelRow.find('button').prop('disabled', true);
        await runBulkMemories(chars, selectorMsgIdx);
    });
    $bulkRow.append($bulkBtn);

    const $cancelRow = $('<div class="flex-container mt5">');
    const $cancelBtn = $('<button class="menu_button interactable">Cancel</button>');
    $cancelBtn.on('click', cancelFlow);
    $cancelRow.append($cancelBtn);

    $el.find('.mes_block').append($row, $bulkRow, $cancelRow);
}

// ── Bulk flow: generate memories for all group chars at once ─────────────────

async function runBulkMemories(chars, selectorMsgIdx) {
    const ctx      = getContext();
    const settings = getSettings();

    // Capture the last real message index before any MM messages were added.
    // state.mmMsgIndices[0] is the char-selector message itself.
    const lastRealIdx = (state.mmMsgIndices[0] ?? ctx.chat.length) - 1;

    const saved   = [];
    const skipped = [];
    const total   = chars.length;

    for (let i = 0; i < total; i++) {
        const charName = chars[i].name;

        updateMMMessage(
            selectorMsgIdx,
            `**All Remember All** — generating memories…\n\n` +
            `Processing ${i + 1} / ${total}: **${charName}**`,
        );

        try {
            // Always use the full chat range — "All Remember All" is a baseline
            // tool, not an incremental one.  This avoids stale _lastSummarizedAt
            // values silently producing an empty range.
            const fullRange = `0-${ctx.chat.length - 1}`;
            const { summary, startIndex, endIndex } = await collectFilterAndSummarize(
                charName, 'manual', fullRange, settings,
            );

            const entry = {
                id:                 uuidv4(),
                summary,
                created_at_message: lastRealIdx,
                message_range:      `${startIndex}-${endIndex}`,
                lifespan:           settings?.defaultLifespan ?? 20,
                char_message_count: 0,
                active:             true,
                format_template:    'plist',
                injectionPosition:  null,
                injectionDepth:     null,
                injectionRole:      null,
            };

            addMemoryEntry(charName, entry);
            setLastSummarizedAt(charName, endIndex);
            saved.push(charName);
            dmmLog(`Bulk memory saved for "${charName}"`, { range: entry.message_range });
        } catch (err) {
            console.warn(`[${EXT_NAME}] Bulk memory skipped for "${charName}":`, err.message);
            skipped.push(charName);
        }
    }

    await ghostMMInteraction(state.mmMsgIndices);
    await ctx.saveChat();

    if (saved.length > 0) {
        const skipNote = skipped.length ? ` | Skipped: ${skipped.join(', ')}` : '';
        toastr.success(`Memories saved: ${saved.join(', ')}${skipNote}`, EXT_NAME);
    } else {
        toastr.warning(
            'No memories could be generated. Check that messages exist and the Presence extension is active.',
            EXT_NAME,
        );
    }

    dmmLog('Bulk flow complete', { saved, skipped });
    resetState();
}

// ── Step 3: Range selector ───────────────────────────────────────────────────

async function showRangeSelector() {
    const ctx = getContext();
    const { $el } = await postMMMessage(
        `Which messages should I summarize for **${state.charName}**?`,
    );

    const $container = $('<div class="dmm-range-selector flex-container flexFlowColumn flexGap5">');

    // ── Manual range ────────────────────────────────────────────────────────
    const $manualRow     = $('<div class="flex-container flexGap5 alignItemsCenter flexWrap">');
    const $manualBtn     = $('<button class="dmm-range-btn menu_button interactable" tabindex="0">Manual Range</button>');
    const $manualInput   = $('<input type="text" class="text_pole dmm-range-input" placeholder="e.g. 23–67" style="display:none;width:110px">');
    const $manualConfirm = $('<button class="menu_button interactable" style="display:none">Confirm</button>');

    $manualBtn.on('click', () => {
        $manualInput.toggle();
        $manualConfirm.toggle();
        if ($manualInput.is(':visible')) $manualInput.focus();
    });

    $manualConfirm.on('click', async () => {
        const val = $manualInput.val().trim();
        if (!val) { toastr.warning('Enter a range like 23-67.', EXT_NAME); return; }
        state.rangeMode = 'manual';
        state.rangeStr  = val;
        dmmLog('Range mode: manual', { range: val, char: state.charName });
        lockRangeBtns($container);
        await ctx.saveChat();
        await runGeneration();
    });

    $manualRow.append($manualBtn, $manualInput, $manualConfirm);

    // ── From last summary ───────────────────────────────────────────────────
    const $lastBtn = $('<button class="dmm-range-btn menu_button interactable" tabindex="0">From Last Summary</button>');
    $lastBtn.on('click', async () => {
        state.rangeMode = 'last_summary';
        dmmLog('Range mode: last_summary', { char: state.charName, chatLength: ctx.chat.length });
        lockRangeBtns($container);
        await ctx.saveChat();
        await runGeneration();
    });

    // ── Markers ─────────────────────────────────────────────────────────────
    const $markersBtn = $('<button class="dmm-range-btn menu_button interactable" tabindex="0">Set Markers</button>');
    $markersBtn.on('click', async () => {
        lockRangeBtns($container);
        await ctx.saveChat();
        await enterMarkerMode();
    });

    const $cancelBtn = $('<button class="menu_button interactable">Cancel</button>');
    $cancelBtn.on('click', cancelFlow);

    $container.append($manualRow, $lastBtn, $markersBtn, $cancelBtn);
    $el.find('.mes_block').append($container);
}

function lockRangeBtns($container) {
    $container.find('.dmm-range-btn').prop('disabled', true);
}

// ── Step 3b: Marker mode ─────────────────────────────────────────────────────

async function enterMarkerMode() {
    const ctx = getContext();
    clearMarkers(state.charName);

    const { idx: guideIdx } = await postMMMessage(
        `Click a message to set the **START** of the range for ${state.charName}.`,
    );

    let phase = 'start'; // 'start' | 'end' | 'confirm'

    function attachHandlers() {
        $('#chat .mes').each(function () {
            const $mes   = $(this);
            const mesIdx = parseInt($mes.attr('mesid'), 10);
            if (state.mmMsgIndices.includes(mesIdx)) return; // skip MM messages

            $mes.addClass('dmm-marker-target');
            $mes.on('click.dmmMarker', async function (e) {
                // Ignore clicks on action buttons or avatar
                if ($(e.target).closest('.mes_buttons, .avatar, button, input').length) return;

                if (phase === 'start') {
                    $('#chat .mes.dmm-marker-start').removeClass('dmm-marker-start');
                    $mes.addClass('dmm-marker-start');
                    setMarker(state.charName, 'start', mesIdx);
                    phase = 'end';
                    updateMMMessage(
                        guideIdx,
                        `**START** set at message #${mesIdx}. Now click a message to set the **END**.`,
                    );

                } else if (phase === 'end') {
                    const markers = getMarkers(state.charName);
                    if (mesIdx < markers.start) {
                        toastr.warning('END marker must come after START.', EXT_NAME);
                        return;
                    }
                    phase = 'confirm';
                    $('#chat .mes.dmm-marker-end').removeClass('dmm-marker-end');
                    $mes.addClass('dmm-marker-end');
                    setMarker(state.charName, 'end', mesIdx);
                    detachHandlers();
                    showMarkerConfirm(guideIdx, markers.start, mesIdx);
                }
            });
        });
    }

    function detachHandlers() {
        $('#chat .mes')
            .removeClass('dmm-marker-target')
            .off('click.dmmMarker');
    }

    function showMarkerConfirm(guideIdx, startIdx, endIdx) {
        updateMMMessage(
            guideIdx,
            `Range **${startIdx}–${endIdx}** selected. Generate memory?`,
        );

        const $guide  = getMsgEl(guideIdx);
        const $row    = $('<div class="flex-container flexGap5 mt5">');
        const $genBtn = $('<button class="menu_button interactable">Generate Memory</button>');
        const $resetBtn = $('<button class="menu_button interactable">Reset</button>');

        $genBtn.on('click', async () => {
            state.rangeMode = 'markers';
            dmmLog('Range mode: markers', { char: state.charName, start: startIdx, end: endIdx });
            $('#chat .mes').removeClass('dmm-marker-start dmm-marker-end');
            $row.remove();
            await ctx.saveChat();
            await runGeneration();
        });

        $resetBtn.on('click', () => {
            clearMarkers(state.charName);
            $('#chat .mes').removeClass('dmm-marker-start dmm-marker-end');
            updateMMMessage(guideIdx, `Click a message to set the **START** of the range.`);
            phase = 'start';
            $row.remove();
            attachHandlers();
        });

        $row.append($genBtn, $resetBtn);
        $guide.find('.mes_block').append($row);
    }

    attachHandlers();
}

// ── Step 4: Generation ────────────────────────────────────────────────────────

async function runGeneration() {
    let cancelled = false;

    dmmLog('Generation started', { char: state.charName, mode: state.rangeMode, rangeStr: state.rangeStr });

    const { idx: loadingIdx, $el: $loadingEl } = await postMMMessage(
        `Generating memory for **${state.charName}**…`,
    );

    // Clear the initial swipes array so setSwipe's first call triggers a full re-render
    // (which causes ST to build the ◄ ► swipe arrow container).
    getContext().chat[loadingIdx].swipes = [];

    // Spinner + cancel live in .mes_block outside .mes_text so they survive swipe re-renders
    const $spinner   = $('<span class="dmm-spinner"><i class="fa-solid fa-spinner fa-spin"></i> Generating…</span>');
    const $cancelBtn = $('<button class="menu_button interactable dmm-cancel-gen-btn">Cancel</button>');
    const $row       = $('<div class="flex-container flexGap5 alignItemsCenter mt5">');
    $row.append($spinner, $cancelBtn);
    $loadingEl.find('.mes_block').append($row);

    $cancelBtn.on('click', () => {
        cancelled = true;
        $cancelBtn.prop('disabled', true);
        $spinner.html('<i class="fa-solid fa-spinner fa-spin"></i> Cancelling…');
    });

    try {
        const { summary, startIndex, endIndex, messageCount } =
            await collectFilterAndSummarize(state.charName, state.rangeMode, state.rangeStr, getSettings());

        if (cancelled) { dmmLog('Generation cancelled (after completion)'); cancelFlow(); return; }

        state.startIndex = startIndex;
        state.endIndex   = endIndex;

        dmmLog('Generation succeeded', { char: state.charName, startIndex, endIndex, messageCount });

        $row.remove();

        // Full re-render on first summary (swipes was cleared above) so ST
        // builds the ◄ ► arrow container; regens will append-only after this.
        await setSwipe(loadingIdx, summary);

        const $reviewEl = getMsgEl(loadingIdx);
        showReviewControls($reviewEl, loadingIdx, startIndex, endIndex, messageCount);

    } catch (err) {
        if (cancelled) { dmmLog('Generation cancelled (on error)'); cancelFlow(); return; }

        console.error(`[${EXT_NAME}] Generation error:`, err);
        dmmLog('Generation failed', { char: state.charName, error: err.message });
        $row.remove();
        updateMMMessage(loadingIdx, `⚠ Generation failed: ${err.message}`);

        const $failRow   = $('<div class="flex-container flexGap5 mt5">');
        const $retryBtn  = $('<button class="menu_button interactable">Retry</button>');
        const $abortBtn  = $('<button class="menu_button interactable">Cancel</button>');
        $retryBtn.on('click', () => { $failRow.remove(); runGeneration(); });
        $abortBtn.on('click', cancelFlow);
        $failRow.append($retryBtn, $abortBtn);
        getMsgEl(loadingIdx).find('.mes_block').append($failRow);
    }
}

/**
 * Place `text` as a swipe on message at `idx` and re-render.
 *
 * First call (swipes is empty):
 *   Removes the existing DOM element and does a full addOneMessage re-render.
 *   Because the message is still at ctx.chat[length-1] during the review phase,
 *   ST builds the ◄ ► swipe arrow container so native cycling works.
 *
 * Subsequent calls (regens):
 *   Appends the new text to msg.swipes, advances swipe_id, and uses the
 *   in-place { type:'swipe' } path so .mes_block controls are preserved.
 */
async function setSwipe(idx, text) {
    const ctx = getContext();
    const msg = ctx.chat[idx];

    msg.mes = text;

    if (!Array.isArray(msg.swipes) || msg.swipes.length === 0) {
        // First summary — full render so ST adds the .swipes arrow container.
        msg.swipes   = [text];
        msg.swipe_id = 0;
        $(`#chat .mes[mesid="${idx}"]`).remove();
        await ctx.addOneMessage(msg);
    } else {
        // Regen — append and update in-place; controls in .mes_block are preserved.
        msg.swipes.push(text);
        msg.swipe_id = msg.swipes.length - 1;
        ctx.addOneMessage(msg, { type: 'swipe', forceId: idx });
    }
}

// ── Step 5: Review controls ───────────────────────────────────────────────────

function showReviewControls($msgEl, msgIdx, startIndex, endIndex, messageCount) {
    const cbId = `dmm_custom_intensity_${msgIdx}`;
    const $controls = $(`
        <div class="dmm-review-controls flex-container flexFlowColumn flexGap5">
            <div class="dmm-review-meta opacity50p">
                Messages ${startIndex}–${endIndex} &bull; ${messageCount} after presence filter
                &bull; ${state.charName}
            </div>
            <div class="flex-container flexGap5 alignItemsCenter">
                <label>Lifespan:</label>
                <input type="number" class="text_pole dmm-lifespan-input"
                    min="1" max="999" value="${state.lifespan}" style="width:70px" />
                <small class="opacity50p">char messages before expiry</small>
            </div>
            <div class="flex-container flexGap5 alignItemsCenter">
                <input type="checkbox" id="${cbId}" class="dmm-custom-intensity-cb" />
                <label for="${cbId}">Custom intensity</label>
            </div>
            <div class="dmm-intensity-override flex-container flexFlowColumn flexGap5" style="display:none;padding-left:20px">
                <div class="flex-container flexGap5 alignItemsCenter flexWrap">
                    <label>Position:</label>
                    <select class="text_pole dmm-intensity-pos" style="flex:1;min-width:130px">
                        <option value="after_world_info">After World Info</option>
                        <option value="before_world_info">Before World Info</option>
                        <option value="after_system">After System Prompt</option>
                        <option value="after_char_desc">After Char Description</option>
                        <option value="before_chat">Just Before Chat</option>
                        <option value="at_depth">At Depth</option>
                    </select>
                </div>
                <div class="dmm-intensity-depth-row flex-container flexGap5 alignItemsCenter" style="display:none">
                    <label>Depth:</label>
                    <input type="number" class="text_pole dmm-intensity-depth"
                        min="0" max="100" style="width:60px" value="5" />
                    <label>Role:</label>
                    <select class="text_pole dmm-intensity-role" style="width:110px">
                        <option value="system">System</option>
                        <option value="user">User</option>
                        <option value="assistant">Assistant</option>
                    </select>
                </div>
            </div>
            <div class="flex-container flexGap5 alignItemsCenter">
                <button class="menu_button interactable dmm-save-btn"> Save</button>
                <button class="menu_button interactable dmm-regen-btn"> Regenerate</button>
                <button class="menu_button interactable dmm-cancel-btn"> Cancel</button>
            </div>
            <small class="opacity50p">Tip: click the pencil icon on this message to edit before saving. Use ◄ ► arrows to cycle between generations.</small>
        </div>
    `);

    // ── Lifespan ──────────────────────────────────────────────────────────────
    $controls.find('.dmm-lifespan-input').on('input', function () {
        state.lifespan = Math.max(1, parseInt($(this).val(), 10) || state.lifespan);
    });

    // ── Custom intensity ──────────────────────────────────────────────────────
    const $override  = $controls.find('.dmm-intensity-override');
    const $posSelect = $controls.find('.dmm-intensity-pos');
    const $depthRow  = $controls.find('.dmm-intensity-depth-row');

    function syncOverrideToState() {
        const pos = $posSelect.val();
        state.injectionOverride = (pos === 'at_depth') ? {
            position: pos,
            depth:    parseInt($controls.find('.dmm-intensity-depth').val()) || 5,
            role:     $controls.find('.dmm-intensity-role').val() || 'system',
        } : { position: pos, depth: null, role: null };
    }

    $controls.find('.dmm-custom-intensity-cb').on('change', function () {
        if ($(this).prop('checked')) {
            // Pre-populate from global settings so user tweaks from the default
            const s = getSettings();
            const globalPos = s.injectionPosition || 'after_world_info';
            $posSelect.val(globalPos);
            $depthRow.toggle(globalPos === 'at_depth');
            if (globalPos === 'at_depth') {
                $controls.find('.dmm-intensity-depth').val(s.injectionDepth ?? 5);
                $controls.find('.dmm-intensity-role').val(s.injectionRole || 'system');
            }
            $override.show();
            syncOverrideToState();
        } else {
            $override.hide();
            state.injectionOverride = null;
        }
    });

    $posSelect.on('change', function () {
        $depthRow.toggle($(this).val() === 'at_depth');
        syncOverrideToState();
    });

    $controls.find('.dmm-intensity-depth, .dmm-intensity-role').on('change input', syncOverrideToState);

    // ── Action buttons ────────────────────────────────────────────────────────
    $controls.find('.dmm-save-btn').on('click', () => saveMemory(msgIdx));

    $controls.find('.dmm-regen-btn').on('click', async () => {
        const $btn     = $controls.find('.dmm-regen-btn');
        const $spinner = $('<span class="dmm-regen-spinner"><i class="fa-solid fa-spinner fa-spin"></i></span>');
        $btn.prop('disabled', true).after($spinner);

        // Pin the range to what was used for the first generation.
        // Re-running state.rangeMode (e.g. 'last_summary') would re-calculate
        // against the current chat state, which may have shifted since then.
        const pinnedRange = `${state.startIndex}-${state.endIndex}`;
        dmmLog('Regenerating summary', { char: state.charName, range: pinnedRange });

        try {
            const { summary } = await collectFilterAndSummarize(
                state.charName, 'manual', pinnedRange, getSettings(),
            );
            await setSwipe(msgIdx, summary);
            // Controls survive because they're in .mes_block outside .mes_text
        } catch (err) {
            console.error(`[${EXT_NAME}] Regeneration error:`, err);
            toastr.error(`Regeneration failed: ${err.message}`, EXT_NAME);
        } finally {
            $spinner.remove();
            $btn.prop('disabled', false);
        }
    });

    $controls.find('.dmm-cancel-btn').on('click', cancelFlow);

    $msgEl.find('.mes_block').append($controls);
}

// ── Step 6: Save & ghost ──────────────────────────────────────────────────────

async function saveMemory(reviewMsgIdx) {
    const ctx = getContext();

    // Read from chat array — captures any native edits the user made
    const summary = ctx.chat[reviewMsgIdx]?.mes || '';

    // created_at_message: index of the last REAL message (the one just before
    // the first MM message).  Ghost messages are about to be removed, so
    // ctx.chat.length - 1 would point at a ghost index.
    const lastRealIdx = state.mmMsgIndices.length > 0
        ? state.mmMsgIndices[0] - 1
        : ctx.chat.length - 1;

    const entry = {
        id:                 uuidv4(),
        summary,
        created_at_message: lastRealIdx,
        message_range:      `${state.startIndex}-${state.endIndex}`,
        lifespan:           state.lifespan,
        char_message_count: 0,
        active:             true,
        format_template:    'plist',
        // Per-memory injection override (null = use global settings)
        injectionPosition:  state.injectionOverride?.position ?? null,
        injectionDepth:     state.injectionOverride?.depth    ?? null,
        injectionRole:      state.injectionOverride?.role     ?? null,
    };

    dmmLog('Saving memory', {
        char:        state.charName,
        range:       entry.message_range,
        lifespan:    entry.lifespan,
        mmMsgCount:  state.mmMsgIndices.length,
        chatLength:  ctx.chat.length,
    });

    addMemoryEntry(state.charName, entry);
    setLastSummarizedAt(state.charName, state.endIndex);

    await ghostMMInteraction(state.mmMsgIndices);
    await ctx.saveChat();
    toastr.success(`Memory saved for ${state.charName}.`, EXT_NAME);
    resetState();
}

// ── Cancel ────────────────────────────────────────────────────────────────────

async function cancelFlow() {
    const ctx = getContext();

    dmmLog('Flow cancelled', {
        char:       state?.charName || null,
        mmMsgCount: state?.mmMsgIndices?.length ?? 0,
        chatLength: ctx.chat.length,
    });

    // Clean up marker UI
    if (state?.charName) clearMarkers(state.charName);
    $('#chat .mes')
        .removeClass('dmm-marker-target dmm-marker-start dmm-marker-end')
        .off('click.dmmMarker');

    if (state?.mmMsgIndices?.length) {
        await ghostMMInteraction(state.mmMsgIndices);
        await ctx.saveChat();
    }

    toastr.info('Memory creation cancelled.', EXT_NAME);
    resetState();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * True while the MM create-memory flow is running OR during a short cooldown
 * after it ends (to absorb deferred CHARACTER_MESSAGE_RENDERED events).
 * Used by index.js to suppress lifespan ticks.
 */
export function isMMFlowActive() {
    return state !== null || Date.now() < _mmCooldownUntil;
}

export async function startMMFlow() {
    if (state) {
        toastr.warning('A memory creation is already in progress.', EXT_NAME);
        return;
    }

    const ctx = getContext();
    if (!ctx.chat?.length) {
        toastr.error('No chat is open.', EXT_NAME);
        return;
    }

    initState();
    dmmLog('MM flow started', {
        chatLength:  ctx.chat.length,
        lastMsgIdx:  ctx.chat.length - 1,
        groupId:     ctx.groupId || null,
    });
    await showCharSelector();
}

// ── Step 9: Memory Manager panel ─────────────────────────────────────────────

export async function showManagerPanel() {
    const ctx = getContext();

    // Collect character names: current group/char first, then any with existing memories
    const store   = ctx.chatMetadata?.scene_memory ?? {};
    const withMem = Object.keys(store).filter(k => k !== '_markers' && Array.isArray(store[k]) && store[k].length > 0);

    let current = [];
    if (ctx.groupId) {
        const group = ctx.groups.find(g => g.id === ctx.groupId);
        current = (group?.members ?? [])
            .map(av => ctx.characters.find(c => c.avatar === av)?.name)
            .filter(Boolean);
    } else if (ctx.characters[ctx.characterId]) {
        current = [ctx.characters[ctx.characterId].name];
    }

    const allChars = [...new Set([...current, ...withMem])];

    if (allChars.length === 0) {
        toastr.info('Open a chat first.', EXT_NAME);
        return;
    }

    // ── Build panel DOM ──────────────────────────────────────────────────────
    const $panel = $('<div class="dmm-manager-panel flex-container flexFlowColumn flexGap10">');

    // Character selector row
    const $charSelect = $('<select class="text_pole dmm-manager-char-select" style="flex:1;min-width:0" title="Switch between characters to view and manage their memories">');
    allChars.forEach(name => $charSelect.append(`<option value="${name}">${name}</option>`));

    const $resetRangeBtn = $('<button class="menu_button interactable" title="Reset the \'From Last Summary\' range pointer for this character. The next summary using that mode will start from message 0 again." style="flex-shrink:0;padding:4px 8px">↺ Reset range</button>');
    const $deleteCharBtn = $('<button class="menu_button interactable dmm-btn-danger" title="Permanently delete ALL stored memories for this character. The character itself is not affected — only the memory log is cleared." style="flex-shrink:0;padding:4px 8px">✕</button>');
    const $selectorRow = $('<div class="flex-container flexGap10 alignItemsCenter" style="flex-wrap:nowrap">');
    $selectorRow.append('<label style="flex-shrink:0">Character:</label>', $charSelect, $resetRangeBtn, $deleteCharBtn);
    $panel.append($selectorRow);

    $resetRangeBtn.on('click', () => {
        const charName = $charSelect.val();
        if (!charName) return;
        clearLastSummarizedAt(charName);
        toastr.success(`Range tracking reset for "${charName}". Next "From Last Summary" will start from message 0.`, EXT_NAME);
    });

    $deleteCharBtn.on('click', async () => {
        const charName = $charSelect.val();
        if (!charName) return;
        const confirmed = await Popup.show.confirm(
            'Delete all memories?',
            `This will permanently remove all stored memories for "${charName}". This cannot be undone.`,
        );
        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) return;

        deleteCharMemories(charName);
        toastr.success(`All memories for "${charName}" deleted.`, EXT_NAME);

        // Remove from dropdown and show the next available char
        $charSelect.find(`option[value="${charName}"]`).remove();
        const next = $charSelect.val();
        if (next) {
            renderList(next);
        } else {
            $list.empty();
            $list.append('<div class="opacity50p" style="padding:8px">No characters with memories.</div>');
        }
    });

    // Memory list container
    const $list = $('<div class="dmm-manager-list flex-container flexFlowColumn flexGap8">');
    $panel.append($list);

    // Create New Memory button
    const $createBtn = $('<button class="menu_button interactable dmm-create-new-btn" title="Start the memory creation flow: choose a character, select a message range, and generate a new memory summary">+ Create New Memory</button>');
    $panel.append($createBtn);

    // ── Render list ──────────────────────────────────────────────────────────
    function renderList(charName) {
        $list.empty();
        const memories = getCharMemories(charName);

        if (memories.length === 0) {
            $list.append('<div class="opacity50p" style="padding:8px">No memories for this character yet.</div>');
            return;
        }

        // Active first, then by creation order descending
        const sorted = [...memories].sort((a, b) => {
            if (a.active !== b.active) return a.active ? -1 : 1;
            return b.created_at_message - a.created_at_message;
        });

        sorted.forEach(entry => {
            $list.append(buildMemoryCard(charName, entry, () => renderList(charName)));
        });
    }

    $charSelect.on('change', () => renderList($charSelect.val()));
    renderList(allChars[0]);

    // ── Open popup ───────────────────────────────────────────────────────────
    let popupRef = null;

    $createBtn.on('click', () => {
        popupRef?.complete(POPUP_RESULT.CANCELLED);
        setTimeout(() => startMMFlow(), 150);
    });

    popupRef = new Popup($panel, POPUP_TYPE.DISPLAY, '', {
        wide:                  true,
        allowVerticalScrolling: true,
    });
    await popupRef.show();
}

// ── Step 11: Lorebook export ──────────────────────────────────────────────────

const ROLE_TO_WI = { system: 0, user: 1, assistant: 2 };

/**
 * Map a DMM injection position string to a world_info_position value.
 * Returns { position, depth, role } ready to assign to a WI entry.
 */
function dmmPosToWI(entry, settings) {
    const pos   = entry.injectionPosition ?? settings?.injectionPosition ?? 'after_world_info';
    const depth = entry.injectionDepth    ?? settings?.injectionDepth    ?? 5;
    const role  = entry.injectionRole     ?? settings?.injectionRole     ?? 'system';

    switch (pos) {
        case 'before_world_info': return { position: world_info_position.before,    depth: null, role: null };
        case 'after_char_desc':   return { position: world_info_position.after,     depth: null, role: null };
        case 'after_system':      return { position: world_info_position.ANBottom,  depth: null, role: null };
        case 'before_chat':       return { position: world_info_position.ANTop,     depth: null, role: null };
        case 'at_depth':          return { position: world_info_position.atDepth,   depth, role: ROLE_TO_WI[role] ?? 0 };
        case 'after_world_info':
        default:                  return { position: world_info_position.EMTop,     depth: null, role: null };
    }
}

async function exportMemoryToLorebook(charName, entry) {
    const s = extension_settings[MODULE_NAME];

    // Build popup DOM: existing lorebook dropdown + optional "create new" row
    const $form = $('<div class="flex-container flexFlowColumn flexGap8" style="min-width:300px">');

    const $selectLabel = $('<label>Export to lorebook:</label>');
    const $select = $('<select class="text_pole" style="width:100%">');

    const knownBooks = Array.isArray(world_names) ? world_names : [];
    if (knownBooks.length === 0) {
        $select.append('<option value="">— no lorebooks found —</option>');
    } else {
        knownBooks.forEach(n => $select.append(`<option value="${n}">${n}</option>`));
    }

    // Pre-select last used lorebook for this char if still present
    const lastUsed = s?.lastLorebookPerChar?.[charName];
    if (lastUsed && knownBooks.includes(lastUsed)) {
        $select.val(lastUsed);
    }

    const $createToggle = $('<button class="menu_button interactable" style="align-self:flex-start">+ Create new lorebook</button>');
    const $createRow    = $('<div class="flex-container flexGap5 alignItemsCenter" style="display:none">');
    const $createInput  = $('<input type="text" class="text_pole" placeholder="New lorebook name" style="flex:1">');
    $createRow.append('<span class="opacity50p" style="white-space:nowrap">Name:</span>', $createInput);

    let useCreate = false;
    $createToggle.on('click', () => {
        useCreate = !useCreate;
        $createRow.toggle(useCreate);
        if (useCreate) $createInput.focus();
    });

    $form.append($selectLabel, $select, $createToggle, $createRow);

    const $wrapper = $('<div class="flex-container flexFlowColumn flexGap5"><strong>Export to Lorebook</strong></div>');
    $wrapper.append($form);
    const popup = new Popup($wrapper, POPUP_TYPE.CONFIRM, '', {});
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    // Determine target lorebook name — capture values before DOM is detached
    let name = '';
    if (useCreate && $createInput.val().trim()) {
        name = $createInput.val().trim();
    } else {
        name = $select.val()?.trim() ?? '';
    }
    if (!name) {
        toastr.warning('No lorebook selected or entered.', EXT_NAME);
        return;
    }

    try {
        let lorebookData = await loadWorldInfo(name);

        if (!lorebookData) {
            const created = await createNewWorldInfo(name, { interactive: false });
            if (!created) {
                toastr.error(`Failed to create lorebook "${name}".`, EXT_NAME);
                return;
            }
            lorebookData = await loadWorldInfo(name);
            if (!lorebookData) {
                toastr.error(`Failed to load lorebook "${name}".`, EXT_NAME);
                return;
            }
        }

        const wiEntry = createWorldInfoEntry(name, lorebookData);
        wiEntry.key             = [`${charName} memory`, `${charName} past`];
        wiEntry.content         = entry.summary;
        wiEntry.comment         = `Scene Memory — ${charName}, messages ${entry.message_range}`;
        wiEntry.selective       = true;
        wiEntry.characterFilter = { isExclude: false, names: [charName] };

        const wiPos = dmmPosToWI(entry, getSettings());
        wiEntry.position = wiPos.position;
        if (wiPos.depth !== null) wiEntry.depth = wiPos.depth;
        if (wiPos.role  !== null) wiEntry.role  = wiPos.role;

        await saveWorldInfo(name, lorebookData, true);

        // Remember last-used lorebook for this char
        if (!s.lastLorebookPerChar) s.lastLorebookPerChar = {};
        s.lastLorebookPerChar[charName] = name;
        saveSettingsDebounced();

        toastr.success(`Exported to lorebook "${name}".`, EXT_NAME);
        dmmLog(`Exported memory for "${charName}" to lorebook "${name}"`);
    } catch (err) {
        console.error(`[${EXT_NAME}] Lorebook export error:`, err);
        toastr.error(`Export failed: ${err.message}`, EXT_NAME);
    }
}

/**
 * Build the intensity (injection position override) controls for a memory card.
 * Reads/writes entry.injectionPosition/Depth/Role directly and calls saveMemories().
 */
function buildCardIntensitySection(entry) {
    const $section = $(`
        <div class="dmm-card-intensity flex-container flexFlowColumn flexGap5">
            <div class="flex-container flexGap5 alignItemsCenter flexWrap">
                <span class="opacity50p" style="white-space:nowrap">Intensity:</span>
                <select class="text_pole dmm-card-intensity-pos" style="flex:1;min-width:120px">
                    <option value="">Global default</option>
                    <option value="after_world_info">After World Info</option>
                    <option value="before_world_info">Before World Info</option>
                    <option value="after_system">After System Prompt</option>
                    <option value="after_char_desc">After Char Description</option>
                    <option value="before_chat">Just Before Chat</option>
                    <option value="at_depth">At Depth</option>
                </select>
            </div>
            <div class="dmm-card-intensity-depth-row flex-container flexGap5 alignItemsCenter" style="display:none;padding-left:20px">
                <label>Depth:</label>
                <input type="number" class="text_pole dmm-card-intensity-depth"
                    min="0" max="100" style="width:60px" />
                <label>Role:</label>
                <select class="text_pole dmm-card-intensity-role" style="width:110px">
                    <option value="system">System</option>
                    <option value="user">User</option>
                    <option value="assistant">Assistant</option>
                </select>
            </div>
        </div>
    `);

    const $posSelect = $section.find('.dmm-card-intensity-pos');
    const $depthRow  = $section.find('.dmm-card-intensity-depth-row');
    const $depth     = $section.find('.dmm-card-intensity-depth');
    const $role      = $section.find('.dmm-card-intensity-role');

    $posSelect.attr('title', 'Where in the prompt this memory is injected. "Global default" uses the position set in Extension Settings. Higher positions (closer to the chat) make the memory more prominent to the model.');
    $depth.attr('title', 'How many messages from the end of the chat history to insert this memory. 0 = just before the last message. Higher = further back.');
    $role.attr('title', 'The speaker role this memory appears as in the prompt. "System" is recommended for most models.');

    // Set initial values from entry
    $posSelect.val(entry.injectionPosition || '');
    if (entry.injectionPosition === 'at_depth') {
        $depthRow.show();
        $depth.val(entry.injectionDepth ?? 5);
        $role.val(entry.injectionRole || 'system');
    }

    $posSelect.on('change', function () {
        const pos = $(this).val();
        $depthRow.toggle(pos === 'at_depth');
        entry.injectionPosition = pos || null;
        if (pos !== 'at_depth') {
            entry.injectionDepth = null;
            entry.injectionRole  = null;
        } else {
            entry.injectionDepth = parseInt($depth.val()) || 5;
            entry.injectionRole  = $role.val() || 'system';
        }
        saveMemories();
    });

    $depth.on('change input', function () {
        entry.injectionDepth = parseInt($(this).val()) || 5;
        saveMemories();
    });

    $role.on('change', function () {
        entry.injectionRole = $(this).val() || 'system';
        saveMemories();
    });

    return $section;
}

function buildMemoryCard(charName, entry, onRefresh) {
    const isActive  = entry.active;
    const remaining = Math.max(0, entry.lifespan - entry.char_message_count);

    const preview = entry.summary.length > 150
        ? entry.summary.slice(0, 150) + '…'
        : entry.summary;

    const $card = $(`
        <div class="dmm-memory-card ${isActive ? 'dmm-card-active' : 'dmm-card-inactive'}">
            <div class="dmm-card-header flex-container flexGap8 alignItemsCenter">
                <span class="dmm-status-badge ${isActive ? 'dmm-badge-active' : 'dmm-badge-inactive'}">
                    ${isActive ? '● Active' : '○ Inactive'}
                </span>
                <span class="opacity50p">Messages ${entry.message_range} &bull; created at msg #${entry.created_at_message}</span>
            </div>
            <div class="dmm-card-preview">${preview}</div>
            <div class="dmm-card-lifespan flex-container flexGap5 alignItemsCenter">
                <span class="opacity50p">Lifespan:</span>
                <input type="number" class="text_pole dmm-lifespan-edit" min="1" max="999"
                    value="${entry.lifespan}" style="width:64px"
                    title="How many of this character's own messages this memory stays active for. Editing this resets the countdown from now." />
                <span class="opacity50p dmm-lifespan-remaining">(${remaining} remaining)</span>
            </div>
            <div class="dmm-card-actions flex-container flexGap5 flexWrap"></div>
        </div>
    `);

    const $actions = $card.find('.dmm-card-actions');

    // Intensity (injection position override)
    $card.find('.dmm-card-lifespan').after(buildCardIntensitySection(entry));

    // Lifespan edit
    $card.find('.dmm-lifespan-edit').on('change', function () {
        const newVal = Math.max(1, parseInt($(this).val(), 10) || entry.lifespan);
        $(this).val(newVal);
        entry.lifespan = newVal;
        entry.char_message_count = 0;   // reset: "X more messages from now"
        $card.find('.dmm-lifespan-remaining').text(`(${newVal} remaining)`);
        saveMemories();
    });

    // Toggle active / inactive
    if (isActive) {
        const $btn = $('<button class="menu_button interactable" title="Stop injecting this memory into the prompt. The memory is kept and can be reactivated later.">Deactivate</button>');
        $btn.on('click', () => {
            entry.active = false;
            saveMemories();
            onRefresh();
        });
        $actions.append($btn);
    } else {
        const $btn = $('<button class="menu_button interactable" title="Re-enable this memory so it is injected into the prompt again. Resets the lifespan countdown.">Reactivate</button>');
        $btn.on('click', () => {
            entry.active               = true;
            entry.char_message_count   = 0;
            saveMemories();
            onRefresh();
        });
        $actions.append($btn);
    }

    // Edit summary
    const $editBtn = $('<button class="menu_button interactable" title="Manually edit the text of this memory. Useful for correcting AI mistakes or trimming irrelevant details.">Edit</button>');
    $editBtn.on('click', async () => {
        const updated = await Popup.show.input(
            'Edit Memory',
            `Editing memory for ${charName} (messages ${entry.message_range})`,
            entry.summary,
            { rows: 12, wide: true },
        );
        if (updated !== null) {
            entry.summary = updated.trim() || entry.summary;
            saveMemories();
            onRefresh();
        }
    });
    $actions.append($editBtn);

    // Export to lorebook
    const $exportBtn = $('<button class="menu_button interactable" title="Copy this memory into a World Info lorebook as a permanent entry. The injection position and depth are preserved. The memory stays active here too.">Export → Lorebook</button>');
    $exportBtn.on('click', () => exportMemoryToLorebook(charName, entry));
    $actions.append($exportBtn);

    // Reassign to…
    const $reassignBtn = $('<button class="menu_button interactable" title="Move this memory to a different character. Useful if you accidentally created it under the wrong name.">Reassign to…</button>');
    $actions.append($reassignBtn);

    // Inline reassign section (hidden until button clicked)
    const $reassignSection = $('<div class="flex-container flexGap5 alignItemsCenter flexWrap dmm-intensity-override" style="display:none;margin-top:4px">');
    const $toSelect       = $('<select class="text_pole" style="flex:1;min-width:130px" title="Select the character to move this memory to">');
    const $confirmBtn     = $('<button class="menu_button interactable" title="Confirm moving this memory to the selected character">Confirm</button>');
    const $cancelBtn2     = $('<button class="menu_button interactable" title="Cancel reassign">Cancel</button>');
    $reassignSection.append('<span class="opacity50p" style="white-space:nowrap">→ Move to:</span>', $toSelect, $confirmBtn, $cancelBtn2);
    $card.append($reassignSection);

    $reassignBtn.on('click', () => {
        if ($reassignSection.is(':visible')) { $reassignSection.hide(); return; }

        // Populate target dropdown: all known chars except current
        const ctx2  = getContext();
        const store2 = ctx2.chatMetadata?.scene_memory ?? {};
        const withMem2 = Object.keys(store2).filter(k => k !== '_markers' && k !== '_lastSummarizedAt' && Array.isArray(store2[k]));
        let groupChars2 = [];
        if (ctx2.groupId) {
            const g = ctx2.groups.find(x => x.id === ctx2.groupId);
            groupChars2 = (g?.members ?? [])
                .map(av => ctx2.characters.find(c => c.avatar === av)?.name)
                .filter(Boolean);
        }
        const allTargets = [...new Set([...groupChars2, ...withMem2])].filter(n => n !== charName);

        $toSelect.empty();
        if (allTargets.length === 0) {
            $toSelect.append('<option value="">— no other characters —</option>');
            $confirmBtn.prop('disabled', true);
        } else {
            allTargets.forEach(n => $toSelect.append(`<option value="${n}">${n}</option>`));
            $confirmBtn.prop('disabled', false);
        }

        $reassignSection.show();
    });

    $cancelBtn2.on('click', () => $reassignSection.hide());

    $confirmBtn.on('click', () => {
        const toName = $toSelect.val();
        if (!toName) return;
        const moved = reassignMemoryEntry(charName, entry.id, toName);
        if (moved) {
            toastr.success(`Memory moved to "${toName}".`, EXT_NAME);
            onRefresh();
        } else {
            toastr.error('Reassign failed — entry not found.', EXT_NAME);
        }
    });

    // Delete
    const $deleteBtn = $('<button class="menu_button interactable dmm-btn-danger" title="Permanently delete this memory entry. This cannot be undone.">✕ Delete</button>');
    $deleteBtn.on('click', async () => {
        const confirmed = await Popup.show.confirm(
            'Delete memory?',
            `Messages ${entry.message_range} for ${charName}. This cannot be undone.`,
        );
        if (confirmed === POPUP_RESULT.AFFIRMATIVE) {
            deleteMemoryEntry(charName, entry.id);
            onRefresh();
        }
    });
    $actions.append($deleteBtn);

    return $card;
}
