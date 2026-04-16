# Changelog

All notable changes to Dragon Memories Manager will be documented here.

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
