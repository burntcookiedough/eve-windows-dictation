# Server Management — Architecture Decisions

## Context

The application uses a client-server architecture where both run on the same Windows PC. The frontend is an Electron app; the backend is a Python server. During development these are started separately, but the production app needs integrated server lifecycle management.

---

## Decisions

### 1. Process Spawning

**Decision**: Use Node.js `child_process.spawn()` from the Electron **main process**.

Spawning from the main process ensures the server lifecycle is tied to the app, not to any individual window. The main process handles start, stop, restart, and cleanup on `app.quit()`.

Electron's `UtilityProcess` API was considered but is designed for Node.js child scripts, not arbitrary executables.

### 2. Preventing Double-Start (PID File)

**Decision**: Use a PID file to guard against running multiple server instances.

The server writes its PID to a known location on startup and removes it on shutdown. Before spawning, the Electron main process checks the PID file:

- If absent → start normally.
- If present → check if that PID is actually alive (stale PID from a crash). If alive, reuse it. If dead, clean up the file and start fresh.

This is important because the server reserves significant resources and double-starting would be harmful.

### 3. Port Discovery

**Decision**: The server binds to port `0` (OS-assigned) and reports the actual port via stdout.

The Python server prints a structured line (e.g. `SERVER_PORT=54321`) as its first output. The Electron main process parses this from the stdout stream and uses it for all subsequent communication. No hardcoded ports, no conflicts.

The PID file can also store the port alongside the PID for the reuse/reconnect case.

### 4. Health Check

**Decision**: The server exposes a `GET /health` endpoint.

The Electron app polls this endpoint at a regular interval (e.g. every 3–5 seconds) to derive server status. This is more reliable than inferring status from the process being alive — the process could be running but the server stuck or unresponsive.

Status states: **starting** (spawned, health not yet responding) → **running** (health OK) → **stopped** / **error**.

### 5. Graceful Shutdown

**Decision**: The server exposes a `POST /shutdown` endpoint. Force-kill is the fallback.

On Windows, `SIGTERM` is not supported — `child.kill()` calls `TerminateProcess()` immediately with no cleanup. Instead:

1. Call `POST /shutdown` on the server.
2. Wait for the process `exit` event (with a timeout, e.g. 5 seconds).
3. If the server hasn't exited, force-kill via `child.kill()`.

Restart = shutdown sequence → spawn again.

### 6. Log Streaming

**Decision**: Capture `stdout` and `stderr` from the child process and forward to the renderer via Electron IPC.

The main process attaches listeners to `child.stdout` and `child.stderr`, buffers lines, and sends them to the renderer through `ipcMain`. The renderer displays them in a collapsible/expandable log panel (advanced/debug view). Consider differentiating log levels if the server outputs structured logs.

### 7. UI

**Decision**: Server management lives in a collapsible panel in the Electron UI.

Visible by default: a status indicator (starting / running / stopped / error) and start/stop/restart controls.

Expandable: log viewer, PID, port, uptime — debug-level detail.

### 8. Python Packaging (Deferred)

**Status**: Not yet decided.

The Python server needs to be distributed without requiring uv, pip, or a Python installation on the end user's machine. Options include PyInstaller, Nuitka, or an embedded Python distribution. This decision is deferred until the overall installer strategy (bundling Electron + server + dependencies into a single installer) is worked out.

For now, development continues with the Python source and uv.

---

## Implementation Priority

1. PID file logic + spawn from Electron main process
2. `/health` and `/shutdown` endpoints on the Python server
3. Port discovery via stdout
4. IPC bridge (main ↔ renderer) for status and controls
5. Log streaming
6. Management UI panel
7. Packaging and installer (later)
