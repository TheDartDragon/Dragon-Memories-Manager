# Dragon Memories Manager

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension for per-character episodic memory in group roleplay.
Built with Claude Code (Anthropic)

Each character remembers only what they personally witnessed — based on the [Presence](https://github.com/leandrojofre/SillyTavern-Presence) extension's per-message tracking. Memories are stored in the chat file, injected into the correct character's prompt at generation time, and expire naturally as the character accumulates their own messages.

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Features](#features)
- [How Memory Works](#how-memory-works)
- [Settings Reference](#settings-reference)
- [Memory Manager Panel](#memory-manager-panel)
- [Injection Positions](#injection-positions)
- [Memory Intensity](#memory-intensity)
- [Lifespan](#lifespan)
- [Presets](#presets)
- [Lorebook Export](#lorebook-export)
- [qvink Integration](#qvink-integration)
- [Known Limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [File Structure](#file-structure)
- [Data Schema](#data-schema)
- [Console API](#console-api)
- [Debug Logging](#debug-logging)

---

## Requirements

- **SillyTavern** — current public release
- **[Presence extension](https://github.com/leandrojofre/SillyTavern-Presence)** — strongly recommended

> **Without Presence installed**, the extension cannot determine which characters witnessed which messages. All messages in the selected range will be included in every summary regardless of who was present, which defeats the purpose of per-character isolation. A warning banner appears in the extension panel if Presence is not detected.

---

## Installation

### Via SillyTavern Extension Installer (recommended)

1. In SillyTavern, open the **Extensions** tab.
2. Click **Install Extension**.
3. Paste this URL and confirm:
   ```
   https://github.com/TheDartDragon/Dragon-Memories-Manager
   ```

### Manual

1. Download or clone this repository.
2. Place the `Dragon-Memories-Manager` folder in:
   ```
   SillyTavern/public/extensions/third-party/
   ```
3. Reload SillyTavern and enable **Dragon Memories Manager** from the Extensions tab.

---

## Quick Start

### Full workflow (one character at a time)

1. Open a group chat and run a scene.
2. Click the **wand (⚡) menu** → **Create Memory**.
3. Select a character using the avatar buttons.
4. Choose a message range (manual, from last summary, or set markers).
5. Click **Generate Memory** and wait for the summary.
6. Review the result — swipe for alternatives, edit directly if needed.
7. Adjust lifespan if needed, then click **Save**.

The memory is now active. It will be injected into that character's context every time they generate a response, until it expires.

### Quick baseline (all characters at once)

1. Click the **wand (⚡) menu** → **Create Memory**.
2. Click **All Remember All** (below the character avatar buttons).

The extension generates and saves a full-history memory for every character in the group using default lifespan and injection settings. No review step — the first result is saved automatically. Use the Memory Manager panel afterward to inspect, edit, or adjust individual entries.

---

## Features

### Memory creation
- **Per-character isolation** — each character's memories are stored and injected separately; one character's memories never appear in another's context.
- **Presence filtering** — only messages where the target character was actually present are included in the summarization transcript.
- **Three range selection modes** — manual range input, automatic from last summary, or click-to-mark directly in the chat.
- **All Remember All** — one-click baseline: generates and saves a full-history memory for every character in the group with default settings.
- **In-chat MM flow** — the Memory Manager conducts the creation flow as a pseudo-character in the chat, using SillyTavern's native swipe and edit UI.
- **Lorebook context during summarization** — optionally runs ST's keyword matching against the transcript and feeds matched lorebook entries to the scribe as background context. Per-lorebook blocklist available.
- **Summary cleaning** — strips reasoning blocks (`<think>…</think>` or any ST-configured prefix/suffix) and custom literal strings from generated summaries at save time, before the token count is recorded.

### Memory injection
- **Lifespan** — memories expire automatically after a configurable number of the character's own generated messages.
- **Memory intensity** — per-memory injection position override, so a pivotal scene can inject deeper in the prompt than a routine one.
- **Injection cap** — optional character limit on total injected memory per character; oldest memories are dropped first when over the cap.
- **Hide summarized messages** — optionally hides raw messages already covered by active memories during generation, so the LLM sees the summary *instead of* the original messages. Enables a clean three-layer stack alongside [qvink MessageSummarize](#qvink-integration).

### Management
- **Memory Manager panel** — view, edit, reactivate, reassign, or export all memories for any character in the current chat.
- **Token count** — each saved memory records its token count at save time and displays it in the Manager panel.
- **Staleness warning** — memory cards show a badge when the summarized message range has been deleted or rolled back.
- **Lorebook export** — export any memory to a World Info lorebook with character filter and injection position preserved.

### Summarization settings
- **Connection profile swap** — switches to a dedicated connection profile before generating a summary, then restores the original. Requires Connection Manager.
- **Completion preset swap** — switches to a dedicated completion preset (sampler settings) for summarization, then restores. Auto-fills from the selected connection profile's stored preset.
- **Built-in presets** — PList, Summary, and Tracker prompt and injection presets out of the box.
- **Debug log** — a ring buffer captures all internal events; copy to clipboard for bug reports.

---

## How Memory Works

### Creation flow

```
Wand menu → Create Memory
  ↓
Character selector — avatar buttons for each group member
  ↓
Range selector — Manual / From Last Summary / Set Markers
  ↓
Collect messages → presence-filter → build prompt → generate
  ↓
Review: swipeable summary, editable text, lifespan input, intensity override
  ↓
Save: write to chat_metadata, remove MM messages from chat
```

After saving, the Memory Manager interaction messages are removed from the chat entirely.

### Presence filtering

The Presence extension stores a `present` array on each message — an array of avatar filenames for every character that was active at that moment. The filter resolves the target character's avatar filename, then keeps only messages where that filename appears in `present`. Messages with no `present` data (older messages or edge cases) are always included.

### Injection

On every `GENERATE_BEFORE_COMBINE_PROMPTS` event, all active memories for the currently generating character are grouped by their effective injection slot and injected using `setExtensionPrompt`. Injection is skipped entirely during the summarization pass so memories do not contaminate the scribe prompt.

### Lifespan ticking

After injection, the generating character's active memories are ticked: `char_message_count` is incremented for each active entry. When `char_message_count >= lifespan`, the entry is marked inactive. Ticking is suppressed while the MM creation flow is running to avoid counting the MM's own generation turn.

### Range modes

**Manual** — type a range like `23-67`. You can see message indices by hovering over any message in the chat.

**From Last Summary** — automatically starts from the message after the last completed summary for this character, up to the current end of chat. If no previous summary exists, starts from message 0.

**Set Markers** — click **Set Start Marker**, then click any message in chat to mark the start. Then **Set End Marker** and click another message. The selected range is highlighted before you confirm.

---

## Settings Reference

Found in the **Extensions** tab under **Dragon Memories Manager**.

**Memory Behavior**

| Setting | Description |
|---|---|
| **Default Lifespan** | How many of the character's own generated messages a new memory lives for. Default: 20. |
| **Injection cap** | Maximum total characters injected per character per generation. 0 = unlimited. Oldest memories are dropped first when over the cap. |
| **Hide summarized messages** | During generation, hides raw messages already covered by active memories so the LLM only sees the summary. Restored immediately after prompt assembly. See [qvink Integration](#qvink-integration). |

**Context Injection**

| Setting | Description |
|---|---|
| **Preset selector** | Load a built-in or user-saved preset (applies scribe prompt + context wrapper + injection settings at once). |
| **Save As / Delete / Restore Defaults** | Manage user presets. Built-in presets (PList, Summary, Tracker) cannot be deleted. |
| **Position in context** | Where memories are inserted in the prompt. See [Injection Positions](#injection-positions). |
| **Depth / Role** | Message depth and prompt role for the `At Depth` position. |
| **Context wrapper** | Template for each injected memory block. `{{summary}}` = memory text, `{{char}}` = character name. |

**Summarization**

| Setting | Description |
|---|---|
| **Connection profile** | Switch to a dedicated connection profile before generating a summary, then restore. Requires Connection Manager. Leave empty to use the current profile. |
| **Completion preset** | Switch to a dedicated completion preset (sampler settings) for summarization, then restore. Auto-fills from the selected connection profile's stored preset. |
| **Scribe prompt** | The prompt sent to the LLM to produce the memory. `{{char}}` and `{{transcript}}` are replaced at generation time. `{{memories}}` is replaced with the character's active memory summaries (empty if none exist). |
| **Include lorebook context** | Runs ST's keyword matching against the transcript and feeds matched entries to the scribe as background context. |
| **Exclude lorebooks** | Tag-based blocklist — lorebooks added here are filtered out from the scribe's context even when inclusion is enabled. |
| **Strip reasoning blocks** | Removes `prefix…suffix` blocks using ST's configured reasoning tags (AI Response Formatting → Reasoning prefix/suffix). Applied at save time. |
| **Strip strings** | Literal strings to remove from the summary before saving. Useful for stripping model-specific reply prefixes or stray tags. |

**Manager Character**

| Setting | Description |
|---|---|
| **Manager Name** | Display name for the Memory Manager pseudo-character. Default: `Memories Manager`. |
| **Manager Avatar** | Upload an image or select from existing character cards. Uses that card's name and avatar only — card content is ignored. |

**Debug**

| Setting | Description |
|---|---|
| **Debug Logging** | Print internal events to the browser console. |
| **Copy Log / Clear Log** | Copy or clear the internal ring buffer. The buffer retains 500 entries regardless of whether logging is enabled. |

---

## Memory Manager Panel

Accessible via **wand (⚡) menu → Memories Manager**.

Shows all stored memories for any character in the current chat. Characters with existing memories appear in the dropdown even if they are no longer in the group.

### Character selector row

| Control | Action |
|---|---|
| **Character dropdown** | Switch between characters. |
| **↺ Reset range** | Clears the "From Last Summary" range pointer for the selected character. The next summary using that mode will start from message 0. Useful after manually deleting memories and wanting to re-summarize from scratch. |
| **✕** (red, right of dropdown) | Delete all memories for the selected character. Asks for confirmation. Does not affect the character card or group membership. |

### Memory cards

Each card shows: active/inactive status, message range, creation message index, a 150-character preview, lifespan progress, intensity override, and action buttons.

| Control | Action |
|---|---|
| **Lifespan input** | Edit total lifespan. Saving resets `char_message_count` to 0 — the countdown restarts from now. |
| **Intensity dropdown** | Per-memory injection position override. See [Memory Intensity](#memory-intensity). |
| **Deactivate / Reactivate** | Toggle whether the memory is injected. Reactivating resets the countdown. |
| **Edit** | Open a full-text editor for the memory summary. |
| **Export → Lorebook** | Export to a World Info lorebook. See [Lorebook Export](#lorebook-export). |
| **Reassign to…** | Move this memory to a different character. Useful if it was created under the wrong name. |
| **✕ Delete** | Permanently delete this single memory entry. |

### + Create New Memory

Closes the panel and starts the MM creation flow.

---

## Injection Positions

| Position | Where in the prompt |
|---|---|
| **After World Info** *(default)* | Just after the World Info block, before the main chat history. |
| **Before World Info** | Before the World Info block, near the top of context. |
| **After System Prompt** | After the system/author's note prompt. |
| **After Char Description** | After the character description card. |
| **Just Before Chat** | Immediately before the chat history starts. |
| **At Depth** | At a specific message depth within the chat history, with a configurable role (System / User / Assistant). Depth 0 = just before the last message. |

The global setting applies to all memories that don't have a per-memory intensity override.

---

## Memory Intensity

Each memory entry can override the global injection position via the **Intensity** dropdown in the Manager panel or the review step of the creation flow.

Use this to make pivotal memories inject more prominently (e.g. `At Depth 1, System`) while routine ones sit further back (e.g. `After World Info`).

Available options mirror the global [Injection Positions](#injection-positions). Selecting **— use global —** removes the override and falls back to the extension setting.

---

## Lifespan

Lifespan counts **the target character's own generated messages**, not global chat messages. A lifespan of 20 means the memory stays active for 20 turns where that specific character generates a response. Other characters' turns do not count.

When a memory expires it becomes inactive — it stops injecting but is kept in the log. It can be reactivated manually from the Manager panel, which resets the countdown.

Editing the lifespan value in the Manager panel also resets `char_message_count` to 0, giving the memory a fresh countdown from that moment.

---

## Presets

Presets bundle a **generation prompt**, **injection template**, **injection position**, **depth**, and **role** into a single named entry.

### Built-in presets

| Preset | Style | Default Position |
|---|---|---|
| **PList** | Compact structured format: `[Char's Memory \| Time: … \| Location: … \| Topics: … \| Events: … \| Character Impression: …]` | At Depth 5, System |
| **Summary** | Short 2–4 sentence narrative in third person, past tense. | After World Info |
| **Tracker** | Detailed structured log with weather, clothing, notable quotes, and emotional impression. | At Depth 5, System |

### User presets

Save any combination of current settings as a named preset from the Extensions panel. Save with the same name to overwrite. Built-in presets cannot be deleted.

---

## Lorebook Export

Exports a single memory entry to a SillyTavern World Info lorebook.

- Choose from a dropdown of all existing lorebooks, or create a new one with the **+ Create new lorebook** toggle.
- The last-used lorebook per character is remembered and pre-selected next time.
- The exported WI entry is configured with:
  - **Keys:** `[char name] memory`, `[char name] past`
  - **Character filter:** restricted to the source character only
  - **Injection position:** mapped from the memory's effective position
  - **Depth / Role:** preserved for `At Depth` entries

The memory remains active in the chat after export — exporting does not deactivate it.

---

## qvink Integration

DMM works cleanly alongside [qvink MessageSummarize](https://github.com/qvink/SillyTavern-MessageSummarize) to create a three-layer memory stack per character:

```
[ DMM long-term memory   ]  ← injected before chat history; covers messages 0–N
[ qvink medium summaries ]  ← rolling summaries of messages N+1 to ~depth 6
[ Raw recent messages    ]  ← last few messages unsummarized
```

**How it works:** Enable **Hide summarized messages** in DMM. On each generation, DMM sets `is_system=true` on messages already covered by active memories. qvink skips system messages by default (`include_system_messages: false`), so it naturally picks up only from where DMM left off. No configuration coordination required — the layers compose automatically.

**Result:** The LLM sees a continuous timeline of decreasing detail — structured long-term memories, medium-term rolling summaries, and full recent messages — with no double-coverage or redundancy.

---

## Known Limitations

- **Presence is required for correct filtering.** Without it, every character gets an unfiltered summary of all messages in the range.
- **Memories are chat-scoped.** They live in the chat file and do not transfer to other chats. Use [Lorebook Export](#lorebook-export) for cross-campaign carry-over.
- **Character rename breaks memory lookup.** Memories are keyed by character name string. If a character is renamed mid-campaign, their old memories remain under the old name and both names appear in the Manager dropdown. Use **Reassign to…** to migrate individual entries.
- **Single-character chats.** The extension works in single-character chats but Presence filtering has no effect since there is only one character. The creation flow still works normally.
- **Summarization profile.** If no summarization Connection Profile is configured, the current active profile is used. At high temperature or with RP-tuned samplers, the summary may read as RP continuation rather than structured notes. Configuring a dedicated low-temperature profile is strongly recommended.

---

## Troubleshooting

**Summary generates but looks like a roleplay continuation, not structured notes.**

The model is receiving the summarization prompt without instruct formatting, or your active sampler settings are too creative. Fix: configure a dedicated Connection Profile with a lower temperature and assign it in **Summarization Profile**. If the model still ignores the format, check that the Generation Prompt contains explicit format instructions and try the Tracker preset.

**Memory doesn't appear to inject.**

Check in the Manager panel that the entry is **Active** and that `char_message_count` has not exceeded **lifespan**. Then check **Injection Position** — if set to `At Depth`, verify the depth value is not larger than your current chat history. Enable **Debug Logging** and check the browser console for injection events.

**All characters are getting the same memories.**

Presence is either not installed or not tracking correctly. Verify the Presence extension is enabled and generating `present` arrays on messages. You can check via the browser console: `SillyTavern.getContext().chat.at(-1).present` should return an array of avatar filenames, not `undefined`.

**Manager panel shows characters that are no longer in the group.**

This is expected — the panel shows all characters with stored memories in the current chat, past or present. Use the **✕** button next to the character dropdown to delete their memory log if it's no longer needed.

**Memory was created for the wrong character.**

Use **Reassign to…** on each affected entry in the Manager panel.

---

## File Structure

```
Dragon-Memories-Manager/
├── manifest.json          Extension metadata
├── index.js               Entry point: settings panel, event hooks, wand menu
├── ui.js                  MM in-chat creation flow + Manager panel
├── memory-manager.js      Storage, message collection, presence filter, lifespan
├── summarizer.js          Prompt building, generateRaw, environment swap (profile + preset)
├── injector.js            setExtensionPrompt integration, slot grouping
├── constants.js           MODULE_NAME, EXT_NAME, FOLDER_NAME
├── logger.js              Conditional debug logger with ring buffer
├── settings.html          Extension settings panel HTML template
├── style.css              All extension styles
└── assets/
    └── default-avatar.png Default MM avatar
```

---

## Data Schema

Stored in `chat_metadata.scene_memory` (persisted in the chat `.jsonl` file).

```javascript
{
  // Per-character memory arrays (keyed by character name string)
  "Ivrene": [
    {
      "id":                  "uuid-v4",
      "summary":             "Full memory text as generated or edited",
      "created_at_message":  44,
      "message_range":       "23-44",
      "lifespan":            20,
      "char_message_count":  7,
      "active":              true,
      "format_template":     "plist",
      "token_count":         312,        // recorded at save time using active tokenizer

      // Per-memory injection override (null = use global setting)
      "injectionPosition":   "at_depth",
      "injectionDepth":      3,
      "injectionRole":       "system"
    }
  ],

  "_lastSummarizedAt": {
    "Ivrene": 44
  },
  "_markers": {
    "Ivrene": { "start": 23, "end": 44 }
  }
}
```

`extension_settings.dragon_memory_manager` (persisted in ST's global settings):

```javascript
{
  "mmName":                   "Memories Manager",
  "mmAvatar":                 null,
  "mmAvatarDataUrl":          null,
  "defaultLifespan":          20,
  "injectionPosition":        "after_world_info",
  "injectionDepth":           5,
  "injectionRole":            "system",
  "injectionTemplate":        "{{summary}}",
  "generationPrompt":         "...",
  "summaryConnectionProfile": "",
  "summaryCompletionPreset":  "",
  "includeLorebooksDuringSum": false,
  "excludedLorebooks":        [],
  "maxInjectionChars":        0,
  "hideOldMessages":          false,
  "stripReasoningBlocks":     true,
  "stripStrings":             [],
  "templatePresets":          [],
  "lastLorebookPerChar":      {}
}
```

---

## Console API

Open the browser console during a chat to use the debug API directly:

```javascript
// Collect messages (no presence filter):
DMM.collectManual('Ivrene', '0-10')
DMM.collectLastSummary('Ivrene')
DMM.collectMarkers('Ivrene')          // requires markers set first

// Collect + presence filter:
DMM.collectFiltered('manual', 'Ivrene', '0-10')
DMM.collectFiltered('last_summary', 'Ivrene')

// Presence filter on an arbitrary array:
DMM.filterPresence(someMessages, 'Ivrene')

// Resolve a character's avatar filename:
DMM.resolveCharAvatar('Ivrene')       // → "Ivrene.png"

// Set / get / clear markers:
DMM.setMarker('Ivrene', 'start', 23)
DMM.setMarker('Ivrene', 'end', 44)
DMM.getMarkers('Ivrene')
DMM.clearMarkers('Ivrene')

// Full pipeline (collect → filter → summarize → log result):
DMM.summarize('Ivrene', 'manual', '0-10')
DMM.summarize('Ivrene', 'last_summary')
DMM.summarize('Ivrene', 'markers')

// Inspect the prompt without firing generation:
DMM.buildPrompt('Ivrene', messages)

// Read stored memories:
DMM.getCharMemories('Ivrene')
```

---

## Debug Logging

Enable **Debug Logging** in Extension Settings to print all internal events to the browser console. Events are always accumulated in an in-memory ring buffer (last 500 entries) regardless of whether logging is enabled — use **Copy Log** to grab the buffer for a bug report even if logging was off when the problem occurred.

---

## License

MIT — see [LICENSE](LICENSE).
