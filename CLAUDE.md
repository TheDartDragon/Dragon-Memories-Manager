# Dragon Memories Manager — SillyTavern Extension
## Claude Code Project Reference

---

## Project Overview

**Dragon Memories Manager (DMM)** is a SillyTavern extension that generates per-character episodic memory summaries from group chat scenes, filtered by character presence, stored in the chat file, and injected into each character's context at generation time.

Primary use case: **multi-character group RP** where characters have isolated knowledge — they only remember events they personally witnessed.

- **Repo:** https://github.com/TheDartDragon/Dragon-Memories-Manager
- **Current version:** 0.2.7
- **Status:** Feature-complete for v1 scope. Ongoing: QOL, tester-reported bug fixes.

---

## Technical Environment

- **ST backend:** KoboldCPP, text completion mode (primary)
- **Also supports:** Chat completion (OpenAI-compatible)
- **Local LLM:** user-configured, typically Gemma/Qwen class models
- **ST version:** current public release
- **Group chat:** primary use case. Single char chats: secondary
- **Other relevant extensions:** Presence (tracks which characters are active per message), qvink (medium-term memory summarization — DMM integrates via globalThis bridge)

---

## Extension File Structure

```
Dragon-Memories-Manager/          ← repo root, also the ST extension folder
├── manifest.json
├── index.js                      ← entry point, event wiring, globalThis bridges
├── ui.js                         ← all DOM / panel / MM flow UI
├── memory-manager.js             ← CRUD, lifespan ticking, presence filter
├── summarizer.js                 ← generateRaw call, profile/preset swap, cleanSummary
├── injector.js                   ← context injection, position logic
├── constants.js
├── logger.js                     ← dmmLog (ring buffer), dmmDevLog (dev only)
├── settings.html
├── style.css
└── assets/
    └── default-avatar.png
```

---

## manifest.json

```json
{
  "display_name": "Dragon Memories Manager",
  "version": "0.2.7",
  "js": "index.js",
  "css": "style.css",
  "author": "DartDragon",
  "description": "Per-character episodic memory for group RP",
  "generate_interceptor": "hideMessagesInterceptor"
}
```

`generate_interceptor` tells ST to call `globalThis.hideMessagesInterceptor(chat)` with an **ephemeral** copy of the chat array before prompt assembly. Mutations to that array never touch the real chat — no restore step needed.

---

## Data Model

### Storage Location
`ctx.chatMetadata.scene_memory` — written and read via `ctx.saveChat()` and `ctx.chatMetadata`.

Do NOT use lorebook/world info for primary storage. Lorebook export is a separate optional action only.

### Schema

```javascript
// ctx.chatMetadata.scene_memory
{
  "Ivrene": [
    {
      "id": "uuid-v4",
      "summary": "[Role: Ivrene's memory | Time: evening | ...]",
      "created_at_message": 44,    // global message index when created
      "message_range": "23-44",    // range that was summarized
      "lifespan": 20,              // expires after this many of THIS CHAR's messages
      "char_message_count": 0,     // increments only on Ivrene's generation turns
      "active": true,              // false = expired or manually disabled
      "format_template": "plist",  // which injection template was used
      "token_count": 142           // computed at save time via getTokenCount()
    }
  ],
  "Ker": [],
  "_markers": {                    // temporary range markers (cleared after generation)
    "Ivrene": { "start": 10, "end": 30 }
  }
}
```

---

## Presence Filter — Critical Logic

Presence extension stores per-message data directly on each message object:

```javascript
// context.chat[n] — confirmed fields:
{
  mes: "...",
  name: "Ivrene",
  is_user: false,
  is_system: false,
  original_avatar: "Ivrene.png",       // AI char: use this for presence lookup
  force_avatar: "/thumbnail?...",       // user persona: full URL path
  present: ["Ivrene.png", "Maryeth.png"],  // avatar FILENAMES (not names)
  is_hidden: false,                    // manually hidden by user
  extra: { api: "koboldcpp", model: "...", ... },
}
```

### Filter Implementation

```javascript
function filterMessagesByPresence(messages, targetCharName) {
  const context = SillyTavern.getContext();
  const targetChar = context.characters.find(c => c.name === targetCharName);
  if (!targetChar) return messages;
  const targetAvatar = targetChar.avatar; // e.g. "Ivrene.png"

  return messages.filter(msg => {
    if (!msg.present || msg.present.length === 0) return true; // no data = include
    return msg.present.includes(targetAvatar);
  });
}
```

**User messages:** `is_user: true` messages list all currently active characters in `present`. The filter handles them correctly without special-casing.

**Group chats without Presence:** `present` will be empty/absent on messages — filter includes all (fallback to full transcript).

---

## Message Range Selection — Three Modes

### Mode 1: Manual Range
User types a range like `23-67`. Parse as `[startIndex, endIndex]` into `context.chat`.

### Mode 2: From Last Summary
Start = `message_range` end of most recent active memory + 1.
End = `context.chat.length - 1`.
If no previous memory exists, start from 0.

### Mode 3: Markers
Two buttons the user clicks on individual messages in chat to set START and END.
Stored in `ctx.chatMetadata.scene_memory._markers[charName] = { start: N, end: M }`.
Cleared after a summary is generated.

---

## Memory Lifespan

Lifespan is measured in **the target character's own message count**, not global messages.

### Swipe/regen detection

`tickMemoryLifespans(charName)` fires on `GENERATION_AFTER_COMMANDS`. To avoid ticking on swipes (where no new user turn exists), it tracks the **last user message index** at tick time per character:

```javascript
const _lastTickedAtUserMsgIdx = {};  // { charName: lastUserMsgIdx }

function tickMemoryLifespans(generatingCharName) {
  const ctx = getContext();
  let lastUserMsgIdx = -1;
  for (let i = ctx.chat.length - 1; i >= 0; i--) {
    if (ctx.chat[i]?.is_user) { lastUserMsgIdx = i; break; }
  }
  const lastTickedIdx = _lastTickedAtUserMsgIdx[generatingCharName] ?? -1;
  if (lastUserMsgIdx <= lastTickedIdx) return; // swipe or regen — skip
  // ...tick memories, mark expired...
  _lastTickedAtUserMsgIdx[generatingCharName] = lastUserMsgIdx;
}
```

`resetTickTracker()` clears the map on `CHAT_CHANGED`.

---

## Injection

### Hook
`GENERATION_AFTER_COMMANDS` — both injection and lifespan ticking happen here. This is more reliable than `GENERATE_BEFORE_COMBINE_PROMPTS`.

### Hide old messages — generate_interceptor approach

When `hideOldMessages` is enabled, DMM registers `globalThis.hideMessagesInterceptor(chat)`. ST calls this with an ephemeral chat array (already stripped of `is_system`/`is_hidden` messages) before prompt assembly.

DMM splices out messages covered by active memories. Because the ephemeral array is already missing hidden messages, we subtract them from the splice count to avoid over-splicing into visible messages:

```javascript
globalThis.getHiddenMessageCount = function (maxEnd) {
  // Counts is_system || is_hidden messages in real ctx.chat[0..maxEnd]
  // These are the messages ST already stripped from the ephemeral array.
};

globalThis.hideMessagesInterceptor = async function (chat) {
  // ...compute maxEnd from active memories...
  const hiddenCount = globalThis.getHiddenMessageCount(maxEnd);
  const originalCount = Math.min(maxEnd + 1, getContext().chat.length);
  const finalCount = Math.min(Math.max(0, originalCount - hiddenCount), chat.length);
  if (finalCount > 0) chat.splice(0, finalCount);
};
```

### qvink bridge

qvink evaluates message exclusion before `GENERATION_AFTER_COMMANDS` fires, so it can't see the interceptor's ephemeral changes. DMM exposes a bridge:

```javascript
globalThis.getHiddenMessageRangeEnd = function () {
  // Returns the highest message_range end index across all active memories
  // for the currently generating character, or -1 if hide is off / inapplicable.
  // qvink's check_message_exclusion calls this.
};
```

qvink's patched `check_message_exclusion` skips messages `<= getHiddenMessageRangeEnd()`.

### Three-layer stack (DMM + qvink + raw)

DMM hides messages 0–N (covered by active memories) → qvink naturally skips them (`include_system_messages: false`) → qvink summarizes medium-term messages → raw recent messages pass through. Confirmed working via `logLayerDiagnostic`.

### Position

User-selectable dropdown in extension settings:
- After World Info (default)
- Before World Info
- After system prompt
- After char description
- Just before chat history
- At depth (like World Info)

### Injection cap

`maxInjectionChars` setting (0 = unlimited). When the assembled injection exceeds the cap, oldest memories are dropped first until it fits.

### Format / wrapper

User-editable template with named presets (saved to extension settings). Default wrapper:
```
<memories>
{{summary}}
</memories>
```
`{{char}}` and `{{summary}}` are the available tokens.

---

## Memory Manager — In-Chat Character Flow

The Memory Manager manifests as a pseudo-character conducting guided dialogue in the ST chat to set up and generate memories.

### Identity Configuration
- **Name:** configurable text field, default `"Memories Manager"`
- **Avatar:** user can select from existing character cards (uses avatar only). Default: `assets/default-avatar.png`

### Conversation Flow

```
Step 1 — Trigger
  Wand menu → "Create Memory"  OR  Extension panel button

Step 2 — Character Selection (MM message in chat)
  Group chats: always shows avatar picker for all group members
  Single-char chats: auto-selects the only character
  Presence inactive: shows picker with toast; does not auto-select

Step 3 — Range Selection (MM message in chat)
  [Manual Range]      → text input "e.g. 23-67"
  [From Last Summary] → auto-calculates, shows preview "Messages 45–89"
  [Set Markers]       → prompts user to click START then END on chat messages
  [Remember All]      → uses full range 0–N for all characters

Step 4 — Generation
  MM: "Generating memory for [Char]..." (loading state)
  1. Collect messages in range
  2. Filter by presence (targetAvatar in msg.present)
  3. Swap to summarization Connection Profile / preset
  4. generateRaw with scribe prompt (+ optional lorebook context as systemPrompt)
  5. Restore previous profile / preset
  6. Post result as swipeable MM message

Step 5 — Review & Save
  User can swipe (alternative generation), edit text, adjust lifespan field
  [Save Memory]: cleanSummary → getTokenCount → write to chatMetadata → ghost MM messages
```

### Ghosting
MM interaction messages get `is_system = true` + `extra.scene_memory_ghost = true`. Ghosted messages are excluded from ST context and DMM injection. They remain in the chat log.

---

## Memory Manager Panel

Accessible from wand menu → "Memory Manager". Shows per-character memory log.

```
[Character dropdown ▼]

┌─────────────────────────────────────────────────────┐
│ Messages 23-44 | msg #44 | 142 tok ⚠ stale         │
│ "Time: evening | Location: dungeon..."              │
│ Lifespan: 12/20 messages remaining                  │
│ [Active ✓] [Edit] [Edit Range] [Reassign] [Export →Lorebook] [✕] │
├─────────────────────────────────────────────────────┤
│ Messages 0-22 | msg #22 | 98 tok                    │
│ Lifespan: EXPIRED                                   │
│ [Inactive] [Reactivate] [Edit] [Edit Range] [✕]    │
└─────────────────────────────────────────────────────┘
[+ Create New Memory]  [+ Blank Memory]
```

- **⚠ stale range** badge: shown when `endIndex >= ctx.chat.length` (range points past current chat)
- **Edit Range:** inline editor with start/end number inputs; validates and saves `entry.message_range`
- **Blank Memory:** creates an entry with empty summary, opens edit popup immediately; for manually tracking attire, wounds, relationships, etc.
- **Reassign:** move a memory entry to a different character

---

## Summarization

### Prompt

```
You are a memory scribe. You do not roleplay. Output only structured memory notes.

Write a memory entry for [CHAR NAME] in PList format. Include only events [CHAR NAME]
directly witnessed based on the transcript below. Structure: time of day, location,
entities present, key events, [CHAR NAME]'s emotional impression.

Transcript:
[FILTERED MESSAGES]

Memory entry:
```

`generateRaw({ prompt, systemPrompt })` — ST applies the active instruct template automatically. No chat history, no other extension injections bleed in.

### Lorebook context during summarization

Optional checkbox. Runs ST's WI key matching (`checkWorldInfo`) against the filtered transcript. Matched entries are fed as `systemPrompt` to `generateRaw`. Uses `setCharacterId` workaround for group chat compatibility. Lorebook exclusion blocklist tag UI lets user block specific lorebooks from the scribe's context.

### Summary cleaning (`cleanSummary`)

Applied at save time before token count:
1. **Strip reasoning blocks** — removes `prefix…suffix` regions using `power_user.reasoning.prefix/suffix` (ST's AI Response Formatting config)
2. **Strip literal strings** — user-defined tag list; removed literally

### Connection Profile / Preset swap

`withSummaryEnvironment(profile, preset, fn)` in summarizer.js:
1. Save current preset name (before profile swap — profile change reloads available presets)
2. Switch to summarization Connection Profile
3. Switch to summarization completion preset
4. Call `fn()` (generateRaw)
5. Restore profile, then restore preset

Uses `getPresetManager().getSelectedPresetName()` to read and `ctx.executeSlashCommandsWithOptions('/preset name')` to apply.

---

## Dev Logging

- `dmmLog(msg)` — always stored in a 500-entry ring buffer; displayed in the Debug panel in settings
- `dmmDevLog(msg)` — fires only when `localStorage.getItem('DMM_DEV')` is set; auto-flushes to `data/default-user/user/files/dmm_dev.log` via `POST /api/files/upload` with CSRF token

Enable dev log: `localStorage.setItem('DMM_DEV', '1')`
Disable: `localStorage.removeItem('DMM_DEV')` — do NOT use `setItem('DMM_DEV', '0')`, that is truthy.

Dev log path: `e:\SillyTavern-1.12.4\SillyTavern-Launcher\SillyTavern\data\default-user\user\files\dmm_dev.log`

---

## Key ST API Facts (verified against ST source)

```javascript
const ctx = SillyTavern.getContext();
ctx.chat              // message array (real, mutable)
ctx.chatMetadata      // per-chat metadata (read/write)
ctx.characters        // character list
ctx.groups            // group chat list
ctx.groupId           // null in single-char chats
ctx.characterId       // null in group chats — not reliable for identifying active char
ctx.saveChat()        // persist changes
ctx.eventSource       // event bus
ctx.event_types       // event name constants
```

- `GENERATION_AFTER_COMMANDS` — correct event for injection + tick
- `generate_interceptor` manifest field — ST passes ephemeral chat array to named global function
- `generateRaw({ prompt, systemPrompt })` — sends ONLY the prompt; no history, no lorebook bleed
- `checkWorldInfo(chatForWI, max_context, true)` → `allActivatedEntries` Map. Pass `string[]` reversed. Temporarily `setCharacterId(charIdx)` for group chat compatibility.
- WI entry `.world` = lorebook name without `.json` — matches `world_names` values exactly
- `getTokenCount(str)` from `../../../../scripts/tokenizers.js` — sync, current active tokenizer
- CSRF token required: `GET /csrf-token` → `{ token }` → `X-CSRF-Token` header
- Profile swap: `ctx.SlashCommandParser.commands['profile'].callback` — requires Connection Manager extension
- `ctx.chat[n].is_hidden` — true when user has manually hidden that message in ST
- `ctx.chat[n].is_system` — true for system messages, ghosted MM messages, etc.
- The ephemeral `chat` array passed to `generate_interceptor` has `is_system`/`is_hidden` messages already stripped

---

## UI Entry Points

### 1. Extensions Tab — Settings Panel
- Manager Character: name + avatar selector
- Memory Behavior: default lifespan, injection cap, hide old messages toggle
- Context Injection: position dropdown + depth controls + wrapper template + presets
- Summarization: connection profile, completion preset, scribe prompt, lorebook inclusion/exclusion, summary cleaning
- Debug: dev log toggle, log viewer, refresh/copy/clear

### 2. Magic Wand (⚡) Action Menu
- **"Create Memory"** → triggers MM in-chat flow
- **"Memory Manager"** → opens Memory Manager panel

---

## Lorebook Export (Per-Entry)

Each memory card has an "Export → Lorebook" button. Creates a WI entry in the character's primary lorebook with a character filter restricting it to that character only.

---

## Out of Scope (v1)

- User privacy mode (char's inner state hidden from user)
- Automatic summarize-the-summaries / memory compression (manual merge only)
- Automatic scene boundary detection (user-driven markers only)

---

## Notes

- **PList format** = chatbot community convention for compact attribute-value notation, e.g. `[Name: value | Attr: value]`. Not Python's plistlib.
- Extension must work in **text completion mode** — no assumptions about chat completion message structure in core generation path
- Presence filter is the critical correctness requirement — incorrect filtering breaks epistemic isolation
- When in doubt about ST internals, read source before guessing: `e:/SillyTavern-1.12.4/SillyTavern-Launcher/SillyTavern/public/scripts/`
