# Random Port & Server URL Setting

## Goal

In production, the managed server should bind to a random OS-assigned port instead of fixed 51717. The server URL setting should be hidden since the app discovers the port from the PID file.

## Current State

- Server always uses port 51717 (`server/src/config.py`: `port: int = 51717`)
- PID file already stores the port and `index.ts` already prefers `serverState.wsUrl` over the setting
- Server URL input in SettingsView is always visible
- `MURMUR_PORT` env var is supported by pydantic-settings but port 0 has never been tested

## What Needs to Change

### 1. Python server: support port 0 (random)

**Files**: `server/src/main.py`, `server/src/pidfile.py`

- When `port=0`, uvicorn binds to a random OS port — but `write_pid_file()` is called *before* `uvicorn.run()`, so it would write port 0 to the PID file instead of the actual port.
- Need to write the PID file *after* uvicorn has bound, or use a startup event/hook to discover the actual port and then write it.
- Options:
  - **A)** Use uvicorn programmatically (`uvicorn.Server` + `server.started` event) instead of `uvicorn.run()` so we can inspect `server.servers[0].sockets[0].getsockname()` after bind.
  - **B)** Use a FastAPI lifespan/startup event — but the ASGI app may not have direct access to the bound socket.
  - **C)** Bind the socket ourselves first (`sock = socket(); sock.bind(('', 0)); port = sock.getsockname()[1]`), then pass the socket to uvicorn. Simple and reliable.

Option C is probably simplest — bind a socket, get the port, write PID file, pass socket to uvicorn.

### 2. Electron server-manager: pass MURMUR_PORT=0

**File**: `app/src/main/services/server-manager.ts`

- Add `MURMUR_PORT: '0'` to the env when spawning the server process.
- The PID file reading already handles dynamic ports — `pidFile.port` flows into `wsUrl`.

### 3. Hide server URL setting in production

**File**: `app/src/renderer/app/views/SettingsView.svelte`

- Need to know whether the server is managed (production) or external (dev).
- Could expose `app.isPackaged` or the server managed state to the renderer via IPC/preload.
- When managed, hide the Server URL input (or show it read-only with the discovered URL).
- Keep it editable in dev mode for connecting to a manually-started server.

## Open Questions

- **Should port 51717 remain the default in dev mode?** Probably yes — devs run the server manually and expect a known port.
- **What if the user wants to connect to a remote server in prod?** Hiding the URL field entirely would prevent that. Maybe show it as an "advanced" option or only hide it when server status is `running`?
- **Conflict detection**: If something else is on the random port, the OS handles it (just picks another). But should we verify the PID file port matches a live server before trusting it?
