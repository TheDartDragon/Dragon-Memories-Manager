# Changelog

All notable changes to Dragon Memories Manager will be documented here.

## [0.1.1] — 2026-04-16

### Added
- **All Remember All** button in the character selector step — generates and saves a full-history memory for every character in the group with default settings in one click. No review step; first LLM result is saved automatically. Intended as a quick baseline before individual tweaking.
- **↺ Reset range** button in the Memory Manager panel character selector row — clears the "From Last Summary" range pointer for the selected character so the next summary starts from message 0. Useful after manually deleting memories.

### Fixed
- `getCharMemories` no longer writes an empty array to the store when called for a character with no memories. Previously, any generation event could silently create a phantom empty entry for the generating character, causing foreign characters to appear in the Memory Manager panel dropdown.
- Memory Manager panel now filters out empty character arrays from the store, cleaning up any phantom entries left by previous versions.

## [0.1.0] — 2025

### Initial release

- Per-character episodic memory storage in chat metadata
- Presence extension integration — characters only remember scenes they witnessed
- Three range selection modes: manual range, from last summary, marker-based
- In-chat Memory Manager flow with avatar character selector
- Swipeable, editable memory output using SillyTavern's native message UI
- Memory lifespan counted in target character's own generated messages
- Per-memory injection position override (Memory Intensity)
- Six injection positions including At Depth with configurable role
- Connection Profile swap before summarization, restored automatically after
- Three built-in presets: PList, Summary, Tracker
- User-saveable custom presets (prompt + template + injection settings)
- Memory Manager panel: view, edit, reactivate, reassign, delete memories
- Lorebook export with character filter and injection position preserved
- Console debug API (DMM.*) for testing and troubleshooting
- Ring buffer debug log (500 entries) with clipboard copy
