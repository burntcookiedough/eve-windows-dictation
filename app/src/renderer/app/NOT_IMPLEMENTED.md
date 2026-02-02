# Not Yet Implemented Features

This file tracks UI elements that are built but not yet connected to backend functionality.

## When Implementing a Feature

When a feature is fully implemented:
1. **Tick off** the checkbox (change `- [ ]` to `- [x]`) - do NOT remove the line
2. **Remove the red border** from the UI by removing the `notImplemented` prop from the `<SettingsRow>` (or `border-red-900` class for custom elements)

## Settings - Activation Section
- [ ] **Hotkey capture**: UI shows current hotkey but clicking doesn't open capture dialog. Needs: hotkey capture modal, IPC to update hotkey, re-register with hotkey service.
- [x] **Activation Mode (hold/toggle)**: UI toggles state but doesn't persist. Needs: settings persistence + hotkey service mode change.

## Settings - Audio Section
- [ ] **Input Device dropdown**: Shows hardcoded options. Needs: device enumeration API, settings persistence.
- [ ] **Silence Timeout**: UI works but doesn't persist. Needs: settings persistence.

## Settings - Post-Processing Section
- [ ] **Append period**: Toggle works locally but doesn't persist or apply. Needs: settings persistence + transcription service to apply post-processing before copy/paste.
- [ ] **Append space**: Toggle works locally but doesn't persist or apply. Needs: settings persistence + transcription service to apply post-processing before copy/paste.

## Settings - Behavior Section
- [ ] **Auto-copy**: Toggle works locally but doesn't persist. Needs: settings persistence.
- [ ] **Auto-paste**: Toggle works locally but doesn't persist. Needs: settings persistence.
- [ ] **Launch on boot**: Toggle works locally but doesn't do anything. Needs: electron `app.setLoginItemSettings()` + settings persistence.
- [ ] **Start minimized**: Toggle works locally but doesn't do anything. Needs: main window logic + settings persistence.

## Settings - Server Section
- [ ] **Server URL**: Input works locally but doesn't persist. Needs: settings persistence.

## History View
- [x] **History data**: SQLite history service implemented with IPC to fetch entries.
- [x] **Copy from history**: Connected via IPC to clipboard service.
- [x] **Delete from history**: Connected with confirmation dialog.
- [x] **Search**: Full-text search on transcription text.
- [x] **Filters**: Date range, duration, confidence, edited-only filters.
- [x] **Infinite scroll**: Seamless loading with 30-entry batches.
- [x] **Real-time updates**: New transcriptions push to history when window is visible.
- [ ] **Disable delete confirmation setting**: Setting to skip confirmation dialog (not yet implemented).

## Test View
- [ ] **Manual recording**: Big button exists but not connected. Needs: IPC to trigger start/stop recording from main window.
- [ ] **Final result display**: Placeholder text. Needs: IPC subscription to transcription state.
- [ ] **Partial results stream**: Shows static mock data. Needs: IPC subscription to transcription state.

## Status Indicators (Header)
- [ ] **Recording status**: Shows static "Idle". Needs: IPC subscription to recording state.
- [ ] **Connection status**: Shows static "Connected". Needs: IPC subscription to connection state.

---
Last updated: 2026-02-02 (History View implemented)
