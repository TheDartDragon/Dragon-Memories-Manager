import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { getPresetManager } from '../../../../scripts/preset-manager.js';
import { saveSettingsDebounced, eventSource, event_types, getThumbnailUrl } from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { MODULE_NAME, EXT_NAME, FOLDER_NAME } from './constants.js';
import './summarizer.js'; // registers DMM.summarize / DMM.buildPrompt on window.DMM
import { startMMFlow, showManagerPanel, isMMFlowActive } from './ui.js';
import { rehideGhostMessages, tickMemoryLifespans } from './memory-manager.js';
import { onBeforeGenerate, clearInjection, hideMessagesUpToRange, restoreHiddenMessages, recoverTempHiddenMessages, logLayerDiagnostic } from './injector.js';
import { isSummarizing, DEFAULT_GENERATION_PROMPT } from './summarizer.js';
import { world_names } from '../../../world-info.js';
import { dmmLog, dmmDevLog, setDebugLogging, getLogText, clearLog } from './logger.js';

export { MODULE_NAME, EXT_NAME, FOLDER_NAME };

// ── Built-in presets ─────────────────────────────────────────────────────────

export const BUILTIN_PRESETS = {
    plist: {
        name: 'PList',
        generationPrompt:  DEFAULT_GENERATION_PROMPT,
        injectionTemplate: '{{summary}}',
        injectionPosition: 'at_depth',
        injectionDepth:    5,
        injectionRole:     'system',
    },
    summary: {
        name: 'Summary',
        generationPrompt:
            `Write a brief narrative summary from {{char}}'s perspective covering only the events {{char}} directly witnessed. ` +
            `Focus on key events, decisions, and outcomes. Write in the third person, past tense, 2–4 sentences.\n\n` +
            `Transcript:\n{{transcript}}\n\nSummary:`,
        injectionTemplate: '[Summary for {{char}}]\n{{summary}}',
        injectionPosition: 'after_world_info',
        injectionDepth:    4,
        injectionRole:     'system',
    },
    tracker: {
        name: 'Tracker',
        generationPrompt:
            `You are a memory scribe. You do not roleplay. Output only structured memory notes.\n\n` +
            `Write a detailed memory entry for {{char}}. Include only events {{char}} directly witnessed based on the transcript below.\n` +
            `Important: leave a blank line between the Events list and Character Impression. Put the closing ] on its own line.\n\n` +
            `Use exactly this format:\n` +
            `[{{char}}'s Memory\n` +
            `Time: <time of day>\n` +
            `Weather: <weather conditions>\n` +
            `Location: <location>\n` +
            `CharactersPresent: <names and brief descriptions>\n` +
            `Clothing: <what each character is wearing>\n` +
            `Events:\n- <event>\n(5–10 detailed bullet points)\n\n` +
            `Notable Quotes: "<quote>" — <speaker>\n\n` +
            `Character Impression: <{{char}}'s feelings, impressions, and internal state>\n` +
            `]\n\n` +
            `Transcript:\n{{transcript}}\n\nMemory entry:`,
        injectionTemplate: '{{summary}}',
        injectionPosition: 'at_depth',
        injectionDepth:    5,
        injectionRole:     'system',
    },
};

// ── Default settings ────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
    // Memory Manager pseudo-character identity
    mmName:         'Memories Manager',
    mmAvatar:       null,       // card filename, null = use default avatar
    mmAvatarDataUrl: null,      // uploaded image data URL (overrides mmAvatar)

    // Memory behavior
    defaultLifespan: 20,

    // Context injection
    injectionPosition: 'after_world_info',
    injectionDepth:    5,
    injectionRole:     'system',
    injectionTemplate: '{{summary}}',

    // Generation prompt
    generationPrompt: DEFAULT_GENERATION_PROMPT,

    // Summarization profile overrides
    summaryConnectionProfile: '',
    summaryCompletionPreset: '',
    includeLorebooksDuringSum: false,
    excludedLorebooks: [],          // blocklist of lorebook filenames; empty = include all

    // Summary cleaning (applied at save time)
    stripReasoningBlocks: true,     // strip prefix…suffix blocks using ST's reasoning config
    stripStrings: [],               // literal strings to remove from summary before saving
    maxInjectionChars: 0,           // 0 = unlimited; oldest memories dropped first when over cap
    hideOldMessages: false,         // hide summarized messages from LLM context during generation

    // Format template presets (user-saved; built-ins live in BUILTIN_PRESETS)
    templatePresets: [],

    // Last lorebook used per character (char name → lorebook filename)
    lastLorebookPerChar: {},

    // Debug
    debugLogging: false,
};

// ── Settings helpers ─────────────────────────────────────────────────────────

export function getSettings() {
    return extension_settings[MODULE_NAME];
}

function loadSettings() {
    extension_settings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    setDebugLogging(extension_settings[MODULE_NAME].debugLogging);
    syncSettingsToUI();
}

function renderStripTags(tags) {
    const container = $('#dmm_strip_tags');
    container.empty();
    (tags ?? []).forEach((tag, i) => {
        const pill = $(`<span class="dmm-tag">${$('<span>').text(tag).html()} <span class="dmm-tag-remove fa-solid fa-xmark" data-index="${i}"></span></span>`);
        container.append(pill);
    });
}

function renderLorebookTags(tags) {
    const container = $('#dmm_lorebook_tags');
    container.empty();
    (tags ?? []).forEach((tag, i) => {
        const pill = $(`<span class="dmm-tag">${$('<span>').text(tag).html()} <span class="dmm-tag-remove fa-solid fa-xmark" data-index="${i}"></span></span>`);
        container.append(pill);
    });
}

function syncSettingsToUI() {
    const s = getSettings();
    $('#dmm_mm_name').val(s.mmName);
    updateAvatarPreview();
    $('#dmm_default_lifespan').val(s.defaultLifespan);
    $('#dmm_injection_position').val(s.injectionPosition);
    $('#dmm_injection_depth').val(s.injectionDepth ?? 4);
    $('#dmm_injection_role').val(s.injectionRole ?? 'system');
    syncInjectionDepthUI();
    $('#dmm_generation_prompt').val(s.generationPrompt);
    $('#dmm_injection_template').val(s.injectionTemplate);
    $('#dmm_max_injection_chars').val(s.maxInjectionChars ?? 0);
    $('#dmm_hide_old_messages').prop('checked', s.hideOldMessages ?? false);
    $('#dmm_strip_reasoning').prop('checked', s.stripReasoningBlocks ?? true);
    renderStripTags(s.stripStrings);
    $('#dmm_include_lorebooks').prop('checked', s.includeLorebooksDuringSum ?? false);
    renderLorebookTags(s.excludedLorebooks);
    $('#dmm_debug_logging').prop('checked', s.debugLogging);
    // Profile dropdown value set after population in populateSummaryProfileDropdown()
    populateTemplatePresetDropdown();
}

function onSettingChanged() {
    const s = getSettings();
    s.mmName                  = String($('#dmm_mm_name').val() || DEFAULT_SETTINGS.mmName);
    s.defaultLifespan         = Math.max(1, parseInt($('#dmm_default_lifespan').val()) || DEFAULT_SETTINGS.defaultLifespan);
    s.injectionPosition       = String($('#dmm_injection_position').val());
    s.injectionDepth          = Math.max(0, parseInt($('#dmm_injection_depth').val()) || 4);
    s.injectionRole           = String($('#dmm_injection_role').val() || 'system');
    s.injectionTemplate       = String($('#dmm_injection_template').val());
    s.generationPrompt        = String($('#dmm_generation_prompt').val());
    s.summaryConnectionProfile  = String($('#dmm_summary_profile').val() || '');
    s.summaryCompletionPreset   = String($('#dmm_summary_preset').val() || '');
    s.maxInjectionChars        = Math.max(0, parseInt($('#dmm_max_injection_chars').val()) || 0);
    s.hideOldMessages          = $('#dmm_hide_old_messages').prop('checked');
    s.stripReasoningBlocks     = $('#dmm_strip_reasoning').prop('checked');
    s.includeLorebooksDuringSum = $('#dmm_include_lorebooks').prop('checked');
    s.debugLogging              = $('#dmm_debug_logging').prop('checked');
    setDebugLogging(s.debugLogging);
    saveSettingsDebounced();
}

// ── Profile dropdown ─────────────────────────────────────────────────────────

function populateSummaryProfileDropdown() {
    const $select  = $('#dmm_summary_profile');
    const profiles = extension_settings.connectionManager?.profiles ?? [];

    $select.empty();
    $select.append('<option value="">(use current profile)</option>');

    if (profiles.length === 0) {
        $select.append('<option value="" disabled>— no Connection Profiles found —</option>');
    } else {
        profiles
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(p => $select.append(`<option value="${p.name}">${p.name}</option>`));
    }

    const saved = getSettings().summaryConnectionProfile;
    if (saved) $select.val(saved);
}

/**
 * Infer the completion API identifier from a connection profile object.
 * Mirrors qvink's CONNECT_API_MAP fallback logic.
 * Returns undefined if the profile can't be found — getPresetList(undefined)
 * falls back to the currently active API.
 */
function getSummaryProfileApi() {
    const profileName = String($('#dmm_summary_profile').val() || '');
    if (!profileName) return undefined;

    const profiles = extension_settings.connectionManager?.profiles ?? [];
    const profile  = profiles.find(p => p.name === profileName);
    if (!profile) return undefined;

    dmmDevLog('Summary profile object:', profile);

    // profile.api is the connection identifier (e.g. 'cohere', 'koboldcpp')
    // getPresetList uses preset-manager keys: all CC → 'openai', all TC → 'textgenerationwebui'
    if (profile.mode === 'cc') return 'openai';
    if (profile.mode === 'tc') return 'textgenerationwebui';
    return undefined;
}

function applyProfilePreset(profileName) {
    if (!profileName) return;
    const profiles = extension_settings.connectionManager?.profiles ?? [];
    const profile  = profiles.find(p => p.name === profileName);
    if (!profile?.preset) return;
    $('#dmm_summary_preset').val(profile.preset);
    getSettings().summaryCompletionPreset = profile.preset;
    saveSettingsDebounced();
}

function populateSummaryPresetDropdown() {
    const $select  = $('#dmm_summary_preset');
    const savedVal = $select.val() || getSettings().summaryCompletionPreset || '';
    $select.empty();
    $select.append('<option value="">(use current preset)</option>');

    try {
        const api = getSummaryProfileApi();
        const { preset_names } = getPresetManager().getPresetList(api);
        const names = Array.isArray(preset_names) ? preset_names : Object.keys(preset_names);
        names
            .slice()
            .sort((a, b) => a.localeCompare(b))
            .forEach(n => $select.append(`<option value="${n}">${n}</option>`));
        dmmDevLog(`Preset dropdown populated for api=${api ?? 'current'}: ${names.length} presets`);
    } catch (e) {
        $select.append('<option value="" disabled>— presets unavailable —</option>');
        console.warn(`[${EXT_NAME}] Could not populate preset dropdown:`, e);
    }

    if (savedVal) $select.val(savedVal);
}

// ── Avatar selector ──────────────────────────────────────────────────────────

function getDefaultAvatarUrl() {
    return `scripts/extensions/third-party/${FOLDER_NAME}/assets/default-avatar.png`;
}

function updateAvatarPreview() {
    const s = getSettings();
    let url;
    if (s?.mmAvatarDataUrl) {
        url = s.mmAvatarDataUrl;
    } else if (s?.mmAvatar) {
        url = getThumbnailUrl('avatar', s.mmAvatar);
    } else {
        url = getDefaultAvatarUrl();
    }
    $('#dmm_mm_avatar_preview').attr('src', url);
}

async function onSelectAvatar() {
    const ctx   = getContext();
    const chars = ctx.characters.filter(c => c.avatar).slice().sort((a, b) => a.name.localeCompare(b.name));
    if (!chars.length) { toastr.info('No character cards found.', EXT_NAME); return; }

    const $grid  = $('<div class="dmm-char-selector flex-container flexGap10 flexWrap" style="max-height:60vh;overflow-y:auto;padding:4px">');
    let resolved = null;
    const popup  = new Popup($grid, POPUP_TYPE.DISPLAY, '', { wide: true, allowVerticalScrolling: true });

    chars.forEach(char => {
        const avatarUrl = getThumbnailUrl('avatar', char.avatar);
        const $btn = $(`
            <button class="dmm-char-btn menu_button interactable" tabindex="0">
                <img src="${avatarUrl}" class="dmm-char-avatar"
                     onerror="this.style.display='none'" />
                <span>${char.name}</span>
            </button>
        `);
        $btn.on('click', () => {
            resolved = char.avatar;
            popup.complete(POPUP_RESULT.AFFIRMATIVE);
        });
        $grid.append($btn);
    });

    await popup.show();

    if (resolved) {
        const s = getSettings();
        s.mmAvatar        = resolved;
        s.mmAvatarDataUrl = null;
        updateAvatarPreview();
        saveSettingsDebounced();
    }
}

// ── Injection depth/role UI ───────────────────────────────────────────────────

function syncInjectionDepthUI() {
    if ($('#dmm_injection_position').val() === 'at_depth') {
        $('#dmm_depth_controls').show();
    } else {
        $('#dmm_depth_controls').hide();
    }
}

// ── Template presets ─────────────────────────────────────────────────────────

function populateTemplatePresetDropdown() {
    const $sel    = $('#dmm_template_preset_select');
    const current = $sel.val();
    $sel.empty().append('<option value="">— load preset —</option>');

    // Built-in presets (not deletable)
    Object.entries(BUILTIN_PRESETS).forEach(([key, preset]) => {
        $sel.append(`<option value="__builtin_${key}">${preset.name} (built-in)</option>`);
    });

    // User-saved presets
    const presets = getSettings().templatePresets ?? [];
    presets.forEach((p, i) => $sel.append(`<option value="${i}">${p.name}</option>`));

    // Restore selection if it still exists
    if (current !== '' && $sel.find(`option[value="${current}"]`).length) $sel.val(current);
}

// ── Settings panel ───────────────────────────────────────────────────────────

async function addSettingsPanel() {
    const html = await renderExtensionTemplateAsync(
        `third-party/${FOLDER_NAME}`,
        'settings',
    );
    $('#extensions_settings').append(html);

    // ── Avatar ───────────────────────────────────────────────────────────────
    $('#dmm_mm_name').on('input', onSettingChanged);

    $('#dmm_mm_avatar_upload').on('click', () => $('#dmm_mm_avatar_upload_input').trigger('click'));
    $('#dmm_mm_avatar_upload_input').on('change', function () {
        const file = this.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            const s = getSettings();
            s.mmAvatarDataUrl = e.target.result;
            s.mmAvatar        = null;
            updateAvatarPreview();
            saveSettingsDebounced();
        };
        reader.readAsDataURL(file);
        this.value = ''; // allow re-selecting the same file
    });

    $('#dmm_mm_avatar_select').on('click', onSelectAvatar);
    $('#dmm_mm_avatar_reset').on('click', () => {
        const s = getSettings();
        s.mmAvatar        = null;
        s.mmAvatarDataUrl = null;
        updateAvatarPreview();
        saveSettingsDebounced();
    });

    // ── Lifespan ─────────────────────────────────────────────────────────────
    $('#dmm_default_lifespan').on('input', onSettingChanged);

    // ── Injection position ───────────────────────────────────────────────────
    $('#dmm_injection_position').on('change', () => { syncInjectionDepthUI(); onSettingChanged(); });
    $('#dmm_injection_depth').on('input', onSettingChanged);
    $('#dmm_injection_role').on('change', onSettingChanged);

    // ── Format templates ─────────────────────────────────────────────────────
    $('#dmm_generation_prompt').on('input', onSettingChanged);
    $('#dmm_injection_template').on('input', onSettingChanged);
    $('#dmm_summary_profile').on('change', function () {
        onSettingChanged();
        populateSummaryPresetDropdown();
        // Always pull the preset stored in the selected profile
        applyProfilePreset(String($('#dmm_summary_profile').val() || ''));
    });
    $('#dmm_summary_preset').on('focus', populateSummaryPresetDropdown);
    $('#dmm_summary_preset').on('change', onSettingChanged);

    $('#dmm_template_preset_select').on('change', function () {
        const val = $(this).val();
        if (!val) return;

        let preset = null;
        if (val.startsWith('__builtin_')) {
            preset = BUILTIN_PRESETS[val.replace('__builtin_', '')];
        } else {
            const idx = parseInt(val, 10);
            preset = getSettings().templatePresets?.[idx];
        }

        if (preset) {
            if (preset.generationPrompt  !== undefined) $('#dmm_generation_prompt').val(preset.generationPrompt);
            if (preset.injectionTemplate !== undefined) $('#dmm_injection_template').val(preset.injectionTemplate);
            if (preset.injectionPosition !== undefined) {
                $('#dmm_injection_position').val(preset.injectionPosition);
                syncInjectionDepthUI();
            }
            if (preset.injectionDepth    !== undefined) $('#dmm_injection_depth').val(preset.injectionDepth);
            if (preset.injectionRole     !== undefined) $('#dmm_injection_role').val(preset.injectionRole);
            onSettingChanged();
        }
    });

    $('#dmm_template_preset_save').on('click', async () => {
        const name = await Popup.show.input('Save Template Preset', 'Preset name:', '');
        if (name === null || name.trim() === '') return;
        const s = getSettings();
        if (!Array.isArray(s.templatePresets)) s.templatePresets = [];
        const existing = s.templatePresets.findIndex(p => p.name === name.trim());
        const entry = {
            name:              name.trim(),
            generationPrompt:  String($('#dmm_generation_prompt').val()),
            injectionTemplate: String($('#dmm_injection_template').val()),
            injectionPosition: String($('#dmm_injection_position').val()),
            injectionDepth:    Math.max(0, parseInt($('#dmm_injection_depth').val()) || 5),
            injectionRole:     String($('#dmm_injection_role').val() || 'system'),
        };
        if (existing >= 0) {
            s.templatePresets[existing] = entry;
        } else {
            s.templatePresets.push(entry);
        }
        saveSettingsDebounced();
        populateTemplatePresetDropdown();
        toastr.success(`Preset "${name.trim()}" saved.`, EXT_NAME);
    });

    $('#dmm_template_preset_restore').on('click', () => {
        const preset = BUILTIN_PRESETS.plist;
        $('#dmm_generation_prompt').val(preset.generationPrompt);
        $('#dmm_injection_template').val(preset.injectionTemplate);
        $('#dmm_injection_position').val(preset.injectionPosition);
        syncInjectionDepthUI();
        $('#dmm_injection_depth').val(preset.injectionDepth);
        $('#dmm_injection_role').val(preset.injectionRole);
        $('#dmm_template_preset_select').val('');
        onSettingChanged();
        toastr.success('Restored PList defaults.', EXT_NAME);
    });

    $('#dmm_template_preset_delete').on('click', () => {
        const val = $('#dmm_template_preset_select').val();
        if (!val || val.startsWith('__builtin_')) {
            toastr.info('Select a user-saved preset to delete.', EXT_NAME);
            return;
        }
        const idx  = parseInt(val, 10);
        const s    = getSettings();
        const name = s.templatePresets?.[idx]?.name;
        if (!name) return;
        s.templatePresets.splice(idx, 1);
        saveSettingsDebounced();
        populateTemplatePresetDropdown();
        toastr.info(`Preset "${name}" deleted.`, EXT_NAME);
    });

    // ── Summarization lorebook inclusion ─────────────────────────────────────
    $('#dmm_max_injection_chars').on('input', onSettingChanged);
    $('#dmm_hide_old_messages').on('change', onSettingChanged);
    $('#dmm_strip_reasoning').on('change', onSettingChanged);

    $('#dmm_strip_input').on('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const val = $(this).val().trim();
        if (!val) return;
        const s = getSettings();
        s.stripStrings = s.stripStrings ?? [];
        if (!s.stripStrings.includes(val)) {
            s.stripStrings.push(val);
            renderStripTags(s.stripStrings);
            saveSettingsDebounced();
        }
        $(this).val('');
    });

    $('#dmm_strip_tags').on('click', '.dmm-tag-remove', function () {
        const idx = parseInt($(this).data('index'));
        const s = getSettings();
        s.stripStrings.splice(idx, 1);
        renderStripTags(s.stripStrings);
        saveSettingsDebounced();
    });

    $('#dmm_include_lorebooks').on('change', onSettingChanged);

    $('#dmm_lorebook_filter_select').on('focus', () => {
        const sel = $('#dmm_lorebook_filter_select');
        const prev = sel.val();
        sel.empty().append('<option value="">— select lorebook —</option>');
        (world_names ?? []).forEach(name => {
            sel.append($('<option>').val(name).text(name));
        });
        if (prev) sel.val(prev);
    });

    $('#dmm_lorebook_filter_add').on('click', () => {
        const val = $('#dmm_lorebook_filter_select').val();
        if (!val) return;
        const s = getSettings();
        s.excludedLorebooks = s.excludedLorebooks ?? [];
        if (!s.excludedLorebooks.includes(val)) {
            s.excludedLorebooks.push(val);
            renderLorebookTags(s.excludedLorebooks);
            saveSettingsDebounced();
        }
        $('#dmm_lorebook_filter_select').val('');
    });

    $('#dmm_lorebook_tags').on('click', '.dmm-tag-remove', function () {
        const idx = parseInt($(this).data('index'));
        const s = getSettings();
        s.excludedLorebooks.splice(idx, 1);
        renderLorebookTags(s.excludedLorebooks);
        saveSettingsDebounced();
    });

    // ── Debug ────────────────────────────────────────────────────────────────
    $('#dmm_debug_logging').on('change', onSettingChanged);

    $('#dmm_copy_log').on('click', () => {
        const text = getLogText();
        if (!text) { toastr.info('Log buffer is empty.', EXT_NAME); return; }
        navigator.clipboard.writeText(text)
            .then(() => toastr.success('Log copied to clipboard.', EXT_NAME))
            .catch(() => {
                const $ta = $('<textarea style="position:fixed;top:-9999px">').val(text).appendTo('body');
                $ta[0].select();
                document.execCommand('copy');
                $ta.remove();
                toastr.success('Log copied to clipboard.', EXT_NAME);
            });
    });

    $('#dmm_clear_log').on('click', () => {
        clearLog();
        toastr.info('Log buffer cleared.', EXT_NAME);
    });
}

// ── Wand menu items ──────────────────────────────────────────────────────────

function addWandMenuItems() {
    const createBtn = $(`
        <div id="dmm_wand_create" class="extension_container">
            <div class="list-group-item flex-container flexGap5 interactable" tabindex="0">
                <i class="fa-fw fa-solid fa-brain"></i>
                <span>Create Memory</span>
            </div>
        </div>
    `);

    const managerBtn = $(`
        <div id="dmm_wand_manager" class="extension_container">
            <div class="list-group-item flex-container flexGap5 interactable" tabindex="0">
                <i class="fa-fw fa-solid fa-book-open"></i>
                <span>Memories Manager</span>
            </div>
        </div>
    `);

    $('#extensionsMenu').append(createBtn).append(managerBtn);

    $('#dmm_wand_create').on('click', () => {
        $('#extensionsMenu').fadeOut(200);
        startMMFlow();
    });

    $('#dmm_wand_manager').on('click', () => {
        $('#extensionsMenu').fadeOut(200);
        showManagerPanel();
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────

jQuery(async function () {
    await addSettingsPanel();
    loadSettings();
    addWandMenuItems();
    populateSummaryProfileDropdown();
    populateSummaryPresetDropdown();
    applyProfilePreset(getSettings().summaryConnectionProfile);

    // Migrate legacy ghost messages and rebuild swipes after any chat load/switch.
    eventSource.on(event_types.CHAT_CHANGED, rehideGhostMessages);

    // Inject active memories and tick lifespans just before ST combines the prompt.
    eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
        if (isSummarizing > 0) {
            dmmLog('GENERATE_BEFORE_COMBINE_PROMPTS: skipping (isSummarizing)');
            clearInjection();
            return;
        }
        const ctx  = getContext();
        const char = ctx.characters[ctx.characterId];
        if (!isMMFlowActive()) {
            if (char?.name) tickMemoryLifespans(char.name);
        } else {
            dmmLog('GENERATE_BEFORE_COMBINE_PROMPTS: skipping tick (MM flow active)', { char: char?.name });
        }
        onBeforeGenerate(getSettings());

        if (getSettings().hideOldMessages && char?.name && !isMMFlowActive() && isSummarizing === 0) {
            hideMessagesUpToRange(char.name);
            logLayerDiagnostic(char.name);
        }
    });

    // Restore any messages hidden during context assembly, then clear stray injections.
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (data) => {
        try {
            restoreHiddenMessages();
        } catch (e) {
            console.error(`[${EXT_NAME}] Failed to restore hidden messages:`, e);
            toastr.warning('DMM: Could not restore hidden messages. Press F5 if the chat looks wrong.', 'Dragon Memories Manager');
        }

        if (isSummarizing > 0) {
            dmmLog('GENERATE_AFTER_COMBINE_PROMPTS: clearing stray injections (isSummarizing)');
            clearInjection();
        }
    });

    // Startup recovery — unhide any messages left over from a crashed/interrupted session.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        const recovered = recoverTempHiddenMessages();
        if (recovered > 0) {
            dmmLog(`Startup recovery: restored ${recovered} temporarily hidden messages`);
            toastr.info(`DMM restored ${recovered} temporarily hidden message${recovered > 1 ? 's' : ''} from a previous session. If the chat looks wrong, press F5.`, 'Dragon Memories Manager');
        }
    });

    fetch(`scripts/extensions/third-party/${FOLDER_NAME}/manifest.json`)
        .then(r => r.json())
        .then(m => {
            const v = m.version ?? 'unknown';
            dmmLog(`v${v} loaded`);
            console.log(`[${EXT_NAME}] v${v} loaded`);
        })
        .catch(() => {
            dmmLog('loaded (version unknown)');
        });
});
