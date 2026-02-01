# Not Yet Implemented Features

This file tracks UI elements that are built but not yet connected to backend functionality.

## Settings - Activation Section
- [ ] **Hotkey capture**: UI shows current hotkey but clicking doesn't open capture dialog. Needs: hotkey capture modal, IPC to update hotkey, re-register with hotkey service.
- [ ] **Activation Mode (hold/toggle)**: UI toggles state but doesn't persist. Needs: settings persistence + hotkey service mode change.

## Settings - Audio Section
- [ ] **Input Device dropdown**: Shows hardcoded options. Needs: device enumeration API, settings persistence.
- [ ] **Silence Timeout**: UI works but doesn't persist. Needs: settings persistence.

## Settings - Behavior Section
- [ ] **Auto-copy**: Toggle works locally but doesn't persist. Needs: settings persistence.
- [ ] **Auto-paste**: Toggle works locally but doesn't persist. Needs: settings persistence.
- [ ] **Launch on boot**: Toggle works locally but doesn't do anything. Needs: electron `app.setLoginItemSettings()` + settings persistence.
- [ ] **Start minimized**: Toggle works locally but doesn't do anything. Needs: main window logic + settings persistence.

## Settings - Server Section
- [ ] **Server URL**: Input works locally but doesn't persist. Needs: settings persistence.

## History View
- [ ] **History data**: Shows empty state. Needs: SQLite history service, IPC to fetch history.
- [ ] **Copy from history**: Button exists but needs history data first.
- [ ] **Delete from history**: Button exists but needs history data + IPC to delete.
- [ ] **Search**: Works on local state but needs history data.

## Test View
- [ ] **Manual recording**: Big button exists but not connected. Needs: IPC to trigger start/stop recording from main window.
- [ ] **Final result display**: Placeholder text. Needs: IPC subscription to transcription state.
- [ ] **Partial results stream**: Shows static mock data. Needs: IPC subscription to transcription state.

## Status Indicators (Header)
- [ ] **Recording status**: Shows static "Idle". Needs: IPC subscription to recording state.
- [ ] **Connection status**: Shows static "Connected". Needs: IPC subscription to connection state.

---
Last updated: 2026-02-01
