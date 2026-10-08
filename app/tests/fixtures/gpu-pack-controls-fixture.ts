import { describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { IPC_CHANNELS } from '../../src/shared/constants.js';
import type { GpuPackState } from '../../src/shared/types.js';
import type {
  RuntimeLease,
  ValidatedGpuRuntime,
  ServerManagerDeps,
  GpuPackManager,
} from '../../src/main/services/server-manager.js';

(process as any).resourcesPath = process.cwd();

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const electronMock = {
  app: {
    getPath: () => tmpdir(),
    getVersion: () => '1.0.0-test',
    isPackaged: true,
    on: () => {},
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  clipboard: {
    writeText: () => {},
    readText: () => '',
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  },
  shell: {
    openPath: async () => '',
  },
  screen: {},
  nativeImage: {
    createFromPath: () => ({}),
  },
  Tray: class {},
  Menu: {
    buildFromTemplate: () => ({}),
  },
  nativeTheme: {
    shouldUseDarkColors: true,
  },
  contextBridge: {},
  ipcRenderer: {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    },
    on: () => {},
    removeListener: () => {},
    _getHandlers: () => handlers,
    _clear: () => handlers.clear(),
  },
};

mock.module('electron', () => ({
  ...electronMock,
  default: electronMock,
}));

const { setupIpcHandlers } = await import('../../src/main/ipc/handlers.js');
const { ServerManager } = await import('../../src/main/services/server-manager.js');
const { ipcMain } = await import('electron');

class MockChildProcess extends EventEmitter {
  pid: number | undefined;
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed = false;
  killSignals: string[] = [];

  constructor(pid?: number) {
    super();
    this.pid = pid;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(String(signal));
    return true;
  }
}

describe('B6 GPU Pack Controls & Server Runtime Lease', () => {
  describe('IPC Channel contracts and handler registrations', () => {
    test('defines required IPC channels for GPU pack lifecycle', () => {
      expect(IPC_CHANNELS.GPU_PACK_GET_STATE).toBe('gpu-pack:get-state');
      expect(IPC_CHANNELS.GPU_PACK_INSTALL).toBe('gpu-pack:install');
      expect(IPC_CHANNELS.GPU_PACK_REPAIR).toBe('gpu-pack:repair');
      expect(IPC_CHANNELS.GPU_PACK_REMOVE).toBe('gpu-pack:remove');
    });

    test('returns unavailable state when GpuPackManager is not supplied', async () => {
      (ipcMain as any)._clear();
      setupIpcHandlers(undefined, undefined, undefined);

      const registeredHandlers = (ipcMain as any)._getHandlers();
      expect(registeredHandlers.has(IPC_CHANNELS.GPU_PACK_GET_STATE)).toBeTrue();
      expect(registeredHandlers.has(IPC_CHANNELS.GPU_PACK_INSTALL)).toBeTrue();
      expect(registeredHandlers.has(IPC_CHANNELS.GPU_PACK_REPAIR)).toBeTrue();
      expect(registeredHandlers.has(IPC_CHANNELS.GPU_PACK_REMOVE)).toBeTrue();

      const stateResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_GET_STATE)();
      expect(stateResult).toEqual({ status: 'unavailable', code: 'descriptor_missing' });

      const installResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_INSTALL)();
      expect(installResult).toEqual({ status: 'unavailable', code: 'descriptor_missing' });

      const repairResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_REPAIR)();
      expect(repairResult).toEqual({ status: 'unavailable', code: 'descriptor_missing' });

      const removeResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_REMOVE)();
      expect(removeResult).toEqual({ status: 'unavailable', code: 'descriptor_missing' });
    });

    test('registers all 4 GPU IPC handlers and routes to GpuPackManager', async () => {
      const recordedCalls: string[] = [];
      const mockState: GpuPackState = {
        status: 'ready',
        packId: 'test-pack-sha256',
        restartRequired: false,
      };

      const mockGpuPackManager = {
        getState: async () => {
          recordedCalls.push('getState');
          return mockState;
        },
        install: async () => {
          recordedCalls.push('install');
          return mockState;
        },
        repair: async () => {
          recordedCalls.push('repair');
          return mockState;
        },
        remove: async () => {
          recordedCalls.push('remove');
          return { status: 'missing' as const, packId: mockState.packId, downloadBytes: 0 };
        },
        onStateChange: () => () => {},
      };

      (ipcMain as any)._clear();
      setupIpcHandlers(undefined, undefined, mockGpuPackManager as any);

      const registeredHandlers = (ipcMain as any)._getHandlers();

      const stateResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_GET_STATE)();
      expect(stateResult).toEqual(mockState);
      expect(recordedCalls).toContain('getState');

      const installResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_INSTALL)();
      expect(installResult).toEqual(mockState);
      expect(recordedCalls).toContain('install');

      const repairResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_REPAIR)();
      expect(repairResult).toEqual(mockState);
      expect(recordedCalls).toContain('repair');

      const removeResult = await registeredHandlers.get(IPC_CHANNELS.GPU_PACK_REMOVE)();
      expect(removeResult.status).toBe('missing');
      expect(recordedCalls).toContain('remove');
    });
  });

  describe('ServerManager mock ChildProcess EventEmitter runtime lifecycle', () => {
    test('ServerManager falls back to CPU and strips GPU env vars when acquireRuntime returns null', async () => {
      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      const mockChild = new MockChildProcess(101);

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => null,
        // A pack can validate while concurrent manager ownership prevents leasing.
        getValidatedRuntime: async () => ({ directory: 'E:/packs/valid', packId: 'valid-but-busy' }) as ValidatedGpuRuntime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => pid === 101,
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: ((_cmd: string, _args: string[], options: any) => {
          spawnedEnv = options.env;
          return mockChild as any;
        }) as any,
        waitForPidFile: async () => ({
          pid: 101,
          port: 9001,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: null,
          },
        }),
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(manager.getState().status).toBe('running');
      expect(spawnedEnv).toBeDefined();
      expect(spawnedEnv?.MURMUR_GPU_RUNTIME_DIR).toBeUndefined();
      expect(spawnedEnv?.MURMUR_GPU_PACK_ID).toBeUndefined();
      expect(manager.getState().runtime?.pack_id).toBeNull();
    });

    test('ServerManager falls back to CPU and strips GPU env vars when acquireRuntime throws', async () => {
      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      const mockChild = new MockChildProcess(102);

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => {
          throw new Error('Lock acquisition failed');
        },
        getValidatedRuntime: async () => null,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => pid === 102,
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: ((_cmd: string, _args: string[], options: any) => {
          spawnedEnv = options.env;
          return mockChild as any;
        }) as any,
        waitForPidFile: async () => ({
          pid: 102,
          port: 9002,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: null,
          },
        }),
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(manager.getState().status).toBe('running');
      expect(spawnedEnv?.MURMUR_GPU_RUNTIME_DIR).toBeUndefined();
      expect(spawnedEnv?.MURMUR_GPU_PACK_ID).toBeUndefined();
    });

    test('ServerManager bind failure stops its wrapper and retains protection for an undiscovered daemon', async () => {
      const mockChild = new MockChildProcess(103);
      let leaseReleased = false;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-103',
        },
        bindServerPid: async () => {
          throw new Error('Durable lease write denied: ENOSPC / lock contention');
        },
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      let childAlive = true;
      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => (pid === 103 ? childAlive : false),
        waitForProcessExit: async (_pid, _ms) => {
          childAlive = false;
          mockChild.emit('exit', 0, null);
          return true;
        },
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(mockChild.killed).toBeTrue();
      expect(mockChild.killSignals).toContain('SIGTERM');
      expect(manager.getState().status).toBe('error');
      // Generic error message without OS ENOSPC or path leakage
      expect(manager.getState().error).toBe('Failed to bind runtime lease to server process');
      expect(leaseReleased).toBeFalse();
    });

    test('ServerManager living process error retains childProcess reference and does not release lease', async () => {
      const mockChild = new MockChildProcess(104);
      let leaseReleased = false;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-104',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      let processAlive = true;
      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => (pid === 104 ? processAlive : false),
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => ({
          pid: 104,
          port: 9004,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-test-104',
          },
        }),
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();
      expect(manager.getState().status).toBe('running');

      // Process emits error while STILL ALIVE
      mockChild.emit('error', new Error('ChildProcess pipe failure'));

      // Process is still live, so childProcess ref and active lease MUST be retained!
      expect((manager as any).childProcess).toBe(mockChild);
      expect(leaseReleased).toBeFalse();
      expect((manager as any).activeRuntimeLease).toBe(mockLease);
      expect(manager.getState().status).toBe('error');
      expect(manager.getState().error).toBe('Server process error');

      // Now process exits confirmed dead
      processAlive = false;
      mockChild.emit('exit', 1, null);
      await new Promise((r) => setTimeout(r, 20));

      expect((manager as any).childProcess).toBeNull();
      expect(leaseReleased).toBeTrue();
    });

    test('Wrapper PID difference does not release lease or clear server state while server is still alive', async () => {
      const mockWrapperChild = new MockChildProcess(1001);
      let leaseReleased = false;
      const boundPids: number[] = [];

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-wrapper',
        },
        bindServerPid: async (pid) => {
          boundPids.push(pid);
        },
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      let wrapperAlive = true;
      let daemonAlive = true;

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => {
          if (pid === 1001) return wrapperAlive;
          if (pid === 2002) return daemonAlive;
          return false;
        },
        isOwnedServerProcess: async (pid) => pid === 2002 || pid === 1001,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockWrapperChild as any) as any,
        waitForPidFile: async () => ({
          pid: 2002, // Server daemon PID differs from wrapper PID 1001
          port: 9005,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => {
          // Exit before startup completes, after the owned daemon is discovered.
          wrapperAlive = false;
          mockWrapperChild.emit('exit', 0, null);
          return { healthy: true, version: '1.0.0-test', runtime: {
            app_build: '1.0.0-test', server_build: '1.0.0-test', pack_id: 'gpu-pack-test-wrapper',
          } };
        },
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(boundPids).toContain(1001);
      expect(boundPids).toContain(2002);
      expect(manager.getState().status).toBe('running');
      expect(manager.getState().pid).toBe(2002);

      // Wrapper process exits (e.g. launcher terminates after starting daemon)
      wrapperAlive = false;
      mockWrapperChild.emit('exit', 0, null);

      // Daemon PID 2002 is still alive! Lease must NOT be released, pidFile retained
      expect(leaseReleased).toBeFalse();
      expect(manager.getState().status).toBe('running');
      expect(manager.getState().pid).toBe(2002);
      expect((manager as any).activeRuntimeLease).toBe(mockLease);
    });

    test('Manager lease.bind writes are serialized with release and never recreate lease after release', async () => {
      let leaseReleased = false;
      let boundAfterRelease = false;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-serial',
        },
        bindServerPid: async () => {
          if (leaseReleased) {
            boundAfterRelease = true;
          }
        },
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const mockChild = new MockChildProcess(105);
      let childAlive = true;

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: () => childAlive,
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => ({
          pid: 105,
          port: 9005,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-test-serial',
          },
        }),
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      childAlive = false;
      mockChild.emit('exit', 0, null);
      await new Promise((r) => setTimeout(r, 20));

      expect(leaseReleased).toBeTrue();
      expect(boundAfterRelease).toBeFalse();
    });

    test('Existing server adoption preserves lease during termination of unhealthy server until confirmed death', async () => {
      let leaseReleased = false;
      let leaseReleasedWhileAlive = false;
      let existingProcessAlive = true;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-existing',
        },
        bindServerPid: async () => {
          throw new Error('bind failed');
        },
        release: async () => {
          leaseReleased = true;
          if (existingProcessAlive) {
            leaseReleasedWhileAlive = true;
          }
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        readPidFile: () => ({
          pid: 5001,
          port: 9051,
          startedAt: Date.now() - 10000,
          appBuildId: '1.0.0-test',
        }),
        isProcessAlive: (pid) => (pid === 5001 ? existingProcessAlive : false),
        isOwnedServerProcess: async () => true,
        getHealthState: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-test-existing',
          },
        }),
        waitForProcessExit: async (pid) => {
          if (pid === 5001) {
            existingProcessAlive = false;
            return true;
          }
          return true;
        },
        getServerCommand: () => null,
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(leaseReleasedWhileAlive).toBeFalse();
      expect(leaseReleased).toBeTrue();
    });

    test('detectExisting fails closed without killing externally owned process when GPU lease cannot be acquired', async () => {
      let killedPid = false;

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => null, // Lease cannot be acquired
        getValidatedRuntime: async () => null,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        readPidFile: () => ({
          pid: 6001,
          port: 9061,
          startedAt: Date.now() - 5000,
          appBuildId: '1.0.0-test',
        }),
        isProcessAlive: (pid) => pid === 6001,
        isOwnedServerProcess: async () => true,
        getHealthState: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'some-gpu-pack',
          },
        }),
        waitForProcessExit: async () => {
          killedPid = true;
          return true;
        },
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      const result = await manager.detectExisting();

      // Fails closed
      expect(result).toBeFalse();
      expect(manager.getState().status).toBe('error');
      // Externally owned process was NOT killed
      expect(killedPid).toBeFalse();
    });

    test('Confirmed stop terminates process, verifies exit, and releases lease', async () => {
      const mockChild = new MockChildProcess(106);
      let leaseReleased = false;
      let processAlive = true;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-stop',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => (pid === 106 ? processAlive : false),
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => ({
          pid: 106,
          port: 9006,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-test-stop',
          },
        }),
        waitForProcessExit: async (_pid) => {
          processAlive = false;
          return true;
        },
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();
      expect(manager.getState().status).toBe('running');

      await (manager as any).stopOnce();

      expect(manager.getState().status).toBe('stopped');
      expect(leaseReleased).toBeTrue();
      expect((manager as any).activeRuntimeLease).toBeNull();
    });

    test('Failed stop does not release lease and sets actionable generic error without PID', async () => {
      const mockChild = new MockChildProcess(107);
      let leaseReleased = false;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-test-stop-fail',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: () => true, // Process remains alive
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => ({
          pid: 107,
          port: 9007,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-test-stop-fail',
          },
        }),
        waitForProcessExit: async () => false, // Process does not exit
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();
      expect(manager.getState().status).toBe('running');

      await (manager as any).stopOnce();

      expect(manager.getState().status).toBe('error');
      // Generic actionable message with NO PID and NO path
      expect(manager.getState().error).toBe('Failed to stop: server process is still running');
      expect(manager.getState().error).not.toContain('107');
      expect(manager.getState().error).not.toContain('PID');
      // Lease must NOT be released!
      expect(leaseReleased).toBeFalse();
      expect((manager as any).activeRuntimeLease).toBe(mockLease);
    });

    test('Dual-PID graceful shutdown exits daemon, force stop terminates wrapper, releases lease only after both are dead', async () => {
      const mockWrapper = new MockChildProcess(3001);
      let leaseReleased = false;
      let daemonAlive = true;
      let wrapperAlive = true;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-dual-graceful',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (String(url).includes('/shutdown')) {
          daemonAlive = false;
          return new Response(JSON.stringify({ ok: true }));
        }
        return originalFetch(url);
      }) as typeof fetch;

      try {
        const deps: ServerManagerDeps = {
          isPackaged: true,
          appVersion: '1.0.0-test',
          isProcessAlive: (pid) => {
            if (pid === 3001) return wrapperAlive;
            if (pid === 3002) return daemonAlive;
            return false;
          },
          isOwnedServerProcess: async () => true,
          readPidFile: () => null,
          getServerCommand: (gpuRuntime) => ({
            command: 'python.exe',
            args: ['main.py'],
            cwd: 'C:/mock-server',
            env: {
              MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
              MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
            },
          }),
          spawn: (() => mockWrapper as any) as any,
          waitForPidFile: async () => ({
            pid: 3002,
            port: 9302,
            startedAt: Date.now(),
            appBuildId: '1.0.0-test',
          }),
          waitForHealth: async () => ({
            healthy: true,
            version: '1.0.0-test',
            runtime: {
              app_build: '1.0.0-test',
              server_build: '1.0.0-test',
              pack_id: 'gpu-pack-dual-graceful',
            },
          }),
          waitForProcessExit: async (pid) => {
            if (pid === 3001) {
              if (mockWrapper.killSignals.length > 0) {
                wrapperAlive = false;
                return true;
              }
              return false;
            }
            if (pid === 3002) {
              return !daemonAlive;
            }
            return true;
          },
        };

        const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
        await (manager as any).startOnce();
        expect(manager.getState().status).toBe('running');

        await (manager as any).stopOnce();

        expect(mockWrapper.killSignals).toContain('SIGTERM');
        expect(wrapperAlive).toBeFalse();
        expect(daemonAlive).toBeFalse();
        expect(leaseReleased).toBeTrue();
        expect(manager.getState().status).toBe('stopped');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test('Dual-PID force stop fails closed if wrapper fails to exit (lease retained)', async () => {
      const mockWrapper = new MockChildProcess(3101);
      let leaseReleased = false;
      let wrapperAlive = true;
      let daemonAlive = true;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-dual-fail-wrapper',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => {
          if (pid === 3101) return wrapperAlive;
          if (pid === 3102) return daemonAlive;
          return false;
        },
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockWrapper as any) as any,
        waitForPidFile: async () => ({
          pid: 3102,
          port: 9312,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-dual-fail-wrapper',
          },
        }),
        waitForProcessExit: async (pid) => {
          if (pid === 3101) return false;
          daemonAlive = false;
          return true;
        },
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();
      expect(manager.getState().status).toBe('running');

      await (manager as any).stopOnce();

      expect(manager.getState().status).toBe('error');
      expect(manager.getState().error).toBe('Failed to stop: server process is still running');
      expect(leaseReleased).toBeFalse();
      expect((manager as any).activeRuntimeLease).toBe(mockLease);
    });

    test('Dual-PID force stop fails closed if daemon fails to exit (lease retained)', async () => {
      const mockWrapper = new MockChildProcess(3201);
      let leaseReleased = false;
      let wrapperAlive = true;
      let daemonAlive = true;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-dual-fail-daemon',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => {
          if (pid === 3201) return wrapperAlive;
          if (pid === 3202) return daemonAlive;
          return false;
        },
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockWrapper as any) as any,
        waitForPidFile: async () => ({
          pid: 3202,
          port: 9322,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-dual-fail-daemon',
          },
        }),
        waitForProcessExit: async (pid) => {
          if (pid === 3202) return false;
          wrapperAlive = false;
          return true;
        },
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();
      expect(manager.getState().status).toBe('running');

      await (manager as any).stopOnce();

      expect(manager.getState().status).toBe('error');
      expect(manager.getState().error).toBe('Failed to stop: server process is still running');
      expect(leaseReleased).toBeFalse();
      expect((manager as any).activeRuntimeLease).toBe(mockLease);
    });

    test('Never kill unverified or foreign daemon PID during force stop', async () => {
      const mockWrapper = new MockChildProcess(4001);
      const killedPids: number[] = [];

      const originalKill = process.kill;
      (process as any).kill = (pid: number, sig?: string | number) => {
        killedPids.push(pid);
        return true;
      };

      try {
        const mockLease: RuntimeLease = {
          runtime: {
            directory: 'E:/test-packs/gpu-pack',
            packId: 'gpu-pack-foreign-daemon',
          },
          bindServerPid: async () => {},
          release: async () => {},
        };

        const mockGpuManager: Partial<GpuPackManager> = {
          acquireRuntime: async () => mockLease,
          getValidatedRuntime: async () => mockLease.runtime,
        };

        const deps: ServerManagerDeps = {
          isPackaged: true,
          appVersion: '1.0.0-test',
          isProcessAlive: () => false,
          isOwnedServerProcess: async (pid) => pid === 4001,
          readPidFile: () => null,
          getServerCommand: () => null,
          waitForProcessExit: async () => true,
        };

        const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
        (manager as any).status = 'running';
        (manager as any).managed = true;
        (manager as any).childProcess = mockWrapper;
        (manager as any).pidFile = { pid: 4002, port: 9402, startedAt: Date.now() };
        (manager as any).activeRuntimeLease = mockLease;

        await (manager as any).stopOnce();

        expect(killedPids).not.toContain(4002);
        expect(mockWrapper.killSignals).toContain('SIGTERM');
      } finally {
        process.kill = originalKill;
      }
    });

    test('startup fails and stops its child when no PID file appears', async () => {
      const mockChild = new MockChildProcess(5101);

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-premature-release',
        },
        bindServerPid: async () => {},
        release: async () => {},
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => {
          await mockLease.release();
          return mockLease;
        },
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: () => false,
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => null,
        waitForProcessExit: async () => true,
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(manager.getState().status).toBe('error');
      expect(mockChild.killed).toBeTrue();
    });

    test('Liveness check aborts startup if process died before running mark', async () => {
      const mockChild = new MockChildProcess(6001);
      let isAlive = true;
      let leaseReleased = false;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-dead-on-start',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: () => isAlive,
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => ({
          pid: 6001,
          port: 9601,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => {
          isAlive = false;
          return {
            healthy: true,
            version: '1.0.0-test',
            runtime: {
              app_build: '1.0.0-test',
              server_build: '1.0.0-test',
              pack_id: 'gpu-pack-dead-on-start',
            },
          };
        },
        waitForProcessExit: async () => true,
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();

      expect(manager.getState().status).toBe('error');
      expect(leaseReleased).toBeTrue();
      expect((manager as any).activeRuntimeLease).toBeNull();
    });

    test('Old child exit or error does not clear newly adopted server state or another lease', async () => {
      const oldChild = new MockChildProcess(7001);
      let adopted = false;
      let oldAlive = true;
      let leaseBReleased = false;

      const leaseB: RuntimeLease = {
        runtime: { directory: 'E:/packs/b', packId: 'pack-b' },
        bindServerPid: async () => {},
        release: async () => { leaseBReleased = true; },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => adopted ? leaseB : { ...leaseB, runtime: { ...leaseB.runtime, packId: 'pack-a' }, release: async () => {} },
        getValidatedRuntime: async () => ({ ...leaseB.runtime, packId: adopted ? 'pack-b' : 'pack-a' }),
      };

      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: (pid) => pid === 7002 || (pid === 7001 && oldAlive),
        isOwnedServerProcess: async () => true,
        readPidFile: () => adopted ? ({
          pid: 7002,
          port: 9702,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }) : null,
        getHealthState: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: { app_build: '1.0.0-test', server_build: '1.0.0-test', pack_id: 'pack-b' },
        }),
        getServerCommand: () => ({ command: 'python.exe', args: ['main.py'], cwd: 'C:/fixture', env: {} }),
        spawn: (() => oldChild as any) as any,
        waitForPidFile: async () => ({ pid: 7001, port: 9701, startedAt: Date.now(), appBuildId: '1.0.0-test' }),
        waitForHealth: async () => ({ healthy: true, runtime: { app_build: '1.0.0-test', server_build: '1.0.0-test', pack_id: 'pack-a' } }),
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await manager.start();
      expect(manager.getState().pid).toBe(7001);
      oldAlive = false;
      adopted = true;
      await manager.detectExisting();
      expect(manager.getState().status).toBe('running');
      expect(manager.getState().pid).toBe(7002);
      expect((manager as any).activeRuntimeLease).toBe(leaseB);

      oldChild.emit('error', new Error('stale error'));
      oldChild.emit('exit', 0, null);

      expect(manager.getState().status).toBe('running');
      expect(manager.getState().pid).toBe(7002);
      expect((manager as any).activeRuntimeLease).toBe(leaseB);
      expect(leaseBReleased).toBeFalse();
      (manager as any).stopHealthPolling();
    });

    test('Health polling retains lease during health failure while alive; releases lease after confirmed death', async () => {
      const mockChild = new MockChildProcess(8001);
      let isAlive = true;
      let leaseReleased = false;

      const mockLease: RuntimeLease = {
        runtime: {
          directory: 'E:/test-packs/gpu-pack',
          packId: 'gpu-pack-health-retain',
        },
        bindServerPid: async () => {},
        release: async () => {
          leaseReleased = true;
        },
      };

      const mockGpuManager: Partial<GpuPackManager> = {
        acquireRuntime: async () => mockLease,
        getValidatedRuntime: async () => mockLease.runtime,
      };

      let healthHealthy = true;
      const deps: ServerManagerDeps = {
        isPackaged: true,
        appVersion: '1.0.0-test',
        isProcessAlive: () => isAlive,
        isOwnedServerProcess: async () => true,
        readPidFile: () => null,
        getServerCommand: (gpuRuntime) => ({
          command: 'python.exe',
          args: ['main.py'],
          cwd: 'C:/mock-server',
          env: {
            MURMUR_GPU_RUNTIME_DIR: gpuRuntime?.directory,
            MURMUR_GPU_PACK_ID: gpuRuntime?.packId,
          },
        }),
        spawn: (() => mockChild as any) as any,
        waitForPidFile: async () => ({
          pid: 8001,
          port: 9801,
          startedAt: Date.now(),
          appBuildId: '1.0.0-test',
        }),
        waitForHealth: async () => ({
          healthy: true,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-health-retain',
          },
        }),
        getHealthState: async () => ({
          healthy: healthHealthy,
          version: '1.0.0-test',
          runtime: {
            app_build: '1.0.0-test',
            server_build: '1.0.0-test',
            pack_id: 'gpu-pack-health-retain',
          },
        }),
      };

      const manager = new ServerManager(mockGpuManager as GpuPackManager, deps);
      await (manager as any).startOnce();
      expect(manager.getState().status).toBe('running');

      healthHealthy = false;
      const originalSetInterval = globalThis.setInterval;
      let tick: (() => Promise<void>) | undefined;
      globalThis.setInterval = ((callback: () => Promise<void>) => {
        tick = callback;
        return originalSetInterval(() => {}, 60000);
      }) as typeof setInterval;
      try {
        (manager as any).startHealthPolling(9801);
      } finally { globalThis.setInterval = originalSetInterval; }
      if (!tick) throw new Error('Health poll not registered');
      await tick();

      expect(leaseReleased).toBeFalse();
      expect(manager.getState().status).toBe('error');

      isAlive = false;
      await tick();

      expect(leaseReleased).toBeTrue();
      (manager as any).stopHealthPolling();
    });
  });
});
