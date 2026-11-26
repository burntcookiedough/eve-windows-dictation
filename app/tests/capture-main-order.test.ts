import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CaptureSession } from '../src/main/services/capture-session';
import { isPasteWarmingUp } from '../src/main/services/paste-helper';
import { IPC_CHANNELS } from '../src/shared/constants';

for (const startupAutoPaste of [true, false]) {
  test(`hotkeys are live before Ready and auto-paste toggles never gate them (auto-paste at startup: ${startupAutoPaste})`, async () => {
    const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const start = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startApplication');
    const script = ts.transpileModule(start!.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const server = Promise.withResolvers<void>();
    const serverStarted = Promise.withResolvers<void>();
    const events: string[] = [];
    let changeAutoPaste: ((value: boolean) => void) | undefined;
    let reportReadiness: ((readiness: string) => void) | undefined;
    const context = {
      log: { info: (message: string) => events.push(message), debug: () => {} },
      autoPasteEnabled: startupAutoPaste,
      getSetting: () => false,
      onAutoPasteChange: (callback: typeof changeAutoPaste) => { changeAutoPaste = callback; },
      // Warm-up never settles here: startup, hotkeys and Ready must not wait for it.
      pasteHelper: {
        setAutoPaste: (enabled: boolean) => events.push(`autoPaste:${enabled}`),
        readiness: () => startupAutoPaste ? 'warming' : 'off',
        onReadinessChange: (callback: typeof reportReadiness) => { reportReadiness = callback; },
      },
      historyService: null, gpuPackManager: null, serverManager: null, mainWindow: null, overlayWindow: null,
      HistoryService: class { initialize() {} },
      createGpuPackManager: () => ({}), resolveGpuPackStorageRoot: () => '',
      PINNED_GPU_PACK_DESCRIPTOR: null, GPU_PACK_CTRANSLATE2_BUILD_ID: null,
      ServerManager: class {
        setMainWindow() {}
        setPasteReadiness(readiness: string) { events.push(`paste:${readiness}`); }
        detectExisting() { events.push('server'); serverStarted.resolve(); return server.promise; }
        getState() { return { status: 'running' }; }
      },
      setupIpcHandlers: () => {}, setupAudioHandler: () => {}, setupMainWindowHandlers: () => {},
      setupDisplayChangeHandlers: () => {}, setupTray: () => {}, secondInstanceShowRequested: false,
      createMainWindow: async () => ({}), createOverlayWindow: async () => ({}),
      setupHotkeyService: () => events.push('hotkeys'),
      app: { isPackaged: false, on: () => {} },
      process: { platform: 'win32', arch: 'x64', argv: [], env: {} },
    };
    const startup = runInNewContext(script + '\nstartApplication();', context);
    await serverStarted.promise;
    // The server cannot publish running/engine-ready before the dictation hook exists.
    expect(events.indexOf('hotkeys')).toBeGreaterThan(-1);
    expect(events.indexOf('hotkeys')).toBeLessThan(events.indexOf('server'));
    expect(events.indexOf(`autoPaste:${startupAutoPaste}`)).toBeLessThan(events.indexOf('hotkeys'));
    const initialReadiness = events.indexOf(startupAutoPaste ? 'paste:warming' : 'paste:off');
    expect(initialReadiness).toBeGreaterThanOrEqual(0);
    expect(initialReadiness).toBeLessThan(events.indexOf('server'));
    server.resolve();
    await startup;
    expect(events.at(-1)).toBe('Eve ready');
    changeAutoPaste?.(!startupAutoPaste);
    changeAutoPaste?.(startupAutoPaste);
    expect(events.slice(-2)).toEqual([`autoPaste:${!startupAutoPaste}`, `autoPaste:${startupAutoPaste}`]);
    reportReadiness?.('ready');
    expect(events.at(-1)).toBe('paste:ready');
  });
}

test('recording snapshots auto-paste and captures the foreground only when enabled at start', async () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const start = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startRecording');
  const script = ts.transpileModule(start!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  for (const [source, initial, updated, autoCopy, failure, queued] of [
    ['normal', false, true, true], // Copy-only at start.
    ['normal', false, false, false], // History-only.
    ['normal', true, false, false], // Auto-paste at start.
    ['lab', true, true, false],
    ['normal', true, true, false, 'no_outputs'],
    ['normal', true, true, true, 'history_failed'],
    ['normal', true, true, true, 'copied_not_pasted'],
    ['normal', false, false, true, 'timeout'],
    ['normal', true, true, true, 'warming'],
    ['normal', true, true, false, undefined, true], // Keep the queued keydown target.
    ['normal', false, false, true, undefined, true], // Disabled before queued Long starts.
    ['normal', true, false, true, undefined, true], // Disabled before queued Long delivers.
  ] as const) {
    let autoPaste: boolean = initial;
    let captures = 0;
    const events: string[] = [];
    const warnings: unknown[] = [];
    const keydownTicks: unknown[] = [];
    let output: { autoPaste: boolean; autoCopy: boolean; target: number | null } | undefined;
    let onFinal!: (frame: { text: string }) => Promise<string | undefined>;
    let onClose!: () => void;
    let onTranscription!: (payload: { type: 'final'; text: string }) => void;
    const timedOut = Promise.withResolvers<void>();
    const context = {
      IPC_CHANNELS, app: { isPackaged: false }, serverManager: null, mainWindow: null,
      overlayWindow: {
        isDestroyed: () => false,
        webContents: { send: (channel: string, payload: unknown) => {
          if (channel === IPC_CHANNELS.STATE_WARNING) warnings.push(payload);
        } },
      },
      isRecording: false, isStopping: false, startLongAfterStop: null, recordingPerfTraceId: undefined,
      currentRecordingState: { state: 'processing' },
      recordingTerminalOverride: null, recordingSource: null, recordingSessionMode: 'quick',
      transcriptionService: null, captureSession: null, latestTranscription: null, latestStatus: null,
      historyService: null, LOCAL_SERVER_URL: 'ws://localhost',
      beginOverlaySession: () => 1,
      isPerfTraceEnabled: () => false,
      perfTraceManager: { startTrace: () => null, mark: () => {}, server: () => {}, completeTrace: () => {} },
      get autoPasteEnabled() { return autoPaste; },
      getSettings: () => {
        events.push('settings');
        return { autoPaste, autoCopy, hotwordsEnabled: false };
      },
      getSetting: () => false,
      pasteHelper: { foreground: async (keydownTick: unknown) => {
        captures++;
        events.push('foreground');
        keydownTicks.push(keydownTick);
        return failure === 'no_outputs' ? { reason: 'helper_absent' }
          : failure === 'warming' ? { reason: 'helper_unready' }
          : { handle: 12345 };
      } },
      isPasteWarmingUp,
      updateConnectionState: () => {}, sendOverlayRecordingState: () => {},
      updateRecordingState: () => {}, scheduleOverlayDismiss: () => {},
      updateTranscription: (payload: typeof context.latestTranscription) => { context.latestTranscription = payload; },
      positionOverlayOnActiveDisplay: () => {}, showOverlay: () => events.push('overlay'),
      TranscriptionService: class {
        onRecordingState() {}
        onConnectionState() {}
        onTranscription(callback: typeof onTranscription) { onTranscription = callback; }
        onStatus() {}
        onClose(callback: typeof onClose) { onClose = callback; }
        onFinal(callback: typeof onFinal) { onFinal = callback; }
        async connect() {}
      },
      CaptureSession: class { canCommit = true; close() {} },
      processFinalTranscription: async (_frame: unknown, settings: { autoPaste: boolean; autoCopy: boolean },
        _history: unknown, _mode: unknown, target: Promise<{ handle?: number }> | null) => {
        output = { autoPaste: settings.autoPaste, autoCopy: settings.autoCopy, target: (await target)?.handle ?? null };
        if (failure === 'no_outputs') {
          return { delivery: { kind: 'skipped_unsafe', reason: 'no_target', copied: false }, entryWithGroup: null, historyFailed: true };
        }
        if (failure === 'warming') {
          return { delivery: { kind: 'skipped_unsafe', reason: 'no_target', copied: true }, entryWithGroup: {} };
        }
        if (failure === 'history_failed' || failure === 'copied_not_pasted') {
          return {
            delivery: { kind: 'skipped_unsafe', reason: 'foreground_changed', copied: true },
            historyFailed: failure === 'history_failed',
          };
        }
        if (failure === 'timeout') {
          await timedOut.promise;
          return { delivery: { kind: 'failed' } };
        }
        return { delivery: { kind: 'pasted' } };
      },
    };
    const queuedTarget = queued ? ', Promise.resolve({ handle: 23456 })' : '';
    await runInNewContext(script + `\nstartRecording('${source}', '${queued ? 'long' : 'quick'}', undefined, 777${queuedTarget});`, context);
    const shouldCapture = source === 'normal' && initial && !queued;
    expect(events).toEqual(shouldCapture
      ? ['foreground', 'settings', 'overlay']
      : ['settings', 'overlay']);
    // The capture is bound to the keydown that started this session.
    expect(keydownTicks).toEqual(shouldCapture ? [777] : []);
    await Promise.resolve();
    // Both helper_unready and helper_absent mean the helpers are still starting.
    expect(warnings).toEqual(failure === 'warming' || (failure === 'no_outputs' && source === 'normal')
      ? [{ code: 'paste_warming_up', message: 'Paste warming up' }] : []);
    autoPaste = updated;
    const payload = { type: 'final', text: 'Synthetic final text' } as const;
    onTranscription(payload);
    const finalizing = onFinal({ text: 'Synthetic final text' });
    if (failure === 'timeout') {
      await runInNewContext('startRecording("normal");', context);
      expect(context.isRecording).toBe(false);
      expect(context.isStopping).toBe(true);
      timedOut.resolve();
    }
    const terminal = await finalizing;
    expect(captures).toBe(shouldCapture ? 1 : 0);
    expect(output).toEqual(source === 'lab' ? undefined : {
      autoPaste: initial && (!queued || updated),
      autoCopy,
      target: initial && failure !== 'no_outputs' && failure !== 'warming' ? (queued ? 23456 : 12345) : null,
    });
    if (failure) {
      expect(terminal).toBe(failure === 'no_outputs' || failure === 'timeout' ? 'failed'
        : failure === 'warming' ? 'copied_not_pasted' : failure);
    }
    if (failure === 'no_outputs' || failure === 'timeout') {
      context.currentRecordingState.state = 'error';
      onClose();
      expect(context.isStopping).toBe(false);
      expect(context.latestTranscription).toEqual(payload);
      await runInNewContext(script + '\nstartRecording("normal");', context);
      expect(context.isRecording).toBe(true);
      expect(context.latestTranscription).toBeNull();
    }
  }
});

test('hotkeys signal Busy during finalization and retain startup timestamps when accepted', () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['showRecordingBusy', 'toggleLongRecording'].includes(node.name?.text ?? ''));
  expect(functions).toHaveLength(2);
  let onHoldStart: ts.Expression | undefined;
  function findHotkeySetup(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'setupHotkeyService') {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const property = options.properties.find(prop => prop.name?.getText(source) === 'onHoldStart');
        if (property && ts.isPropertyAssignment(property)) onHoldStart = property.initializer;
      }
    }
    ts.forEachChild(node, findHotkeySetup);
  }
  findHotkeySetup(source);
  const script = ts.transpileModule([
    ...functions.map(node => node.getText(source)),
    `const quickHotkey = ${onHoldStart!.getText(source)};`,
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const events: unknown[] = [];
  const context = {
    isStopping: true, isRecording: false, recordingSessionMode: 'quick', IPC_CHANNELS,
    overlayWindow: { isDestroyed: () => false, webContents: { send: (...args: unknown[]) => events.push(args) } },
    queueLongRecordingAfterStop: (hotkeyAt: number, keydownTick: number) => events.push(['queued', hotkeyAt, keydownTick]),
    startRecording: (...args: unknown[]) => events.push(['started', ...args]),
    stopRecording: () => events.push('stopped'),
    log: { info: () => {} },
    getSetting: () => false,
  };

  const rejected = runInNewContext(script + '\n[quickHotkey(10), toggleLongRecording(20)];', context);
  const pulse = [IPC_CHANNELS.STATE_WARNING, { code: 'recording_busy', message: 'Busy' }];
  expect(events).toEqual([pulse, pulse]);
  expect(rejected).toEqual([false, false]);

  events.length = 0;
  context.isStopping = false;
  runInNewContext(script + '\nquickHotkey(30, 301); toggleLongRecording(40, 401);', context);
  expect(events).toEqual([['started', 'normal', 'quick', 30, 301], ['started', 'normal', 'long', 40, 401]]);

  events.length = 0;
  context.isRecording = true;
  runInNewContext(script + '\ntoggleLongRecording(50, 501);', context);
  expect(events).toEqual([['queued', 50, 501], 'stopped']);
});

test('a queued Long dictation uses the target sampled at its own hotkey', async () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const queue = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'queueLongRecordingAfterStop');
  const script = ts.transpileModule(queue!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let focused = 12345;
  const keydownTicks: number[] = [];
  const context = {
    autoPasteEnabled: true,
    startLongAfterStop: null as { hotkeyAt: number; pasteTarget: Promise<{ handle: number }> } | null,
    pasteHelper: { foreground: async (keydownTick: number) => {
      keydownTicks.push(keydownTick);
      return { handle: focused };
    } },
  };
  runInNewContext(script + '\nqueueLongRecordingAfterStop(50, 501);', context);
  focused = 23456;
  expect(context.startLongAfterStop?.hotkeyAt).toBe(50);
  expect(keydownTicks).toEqual([501]);
  expect(await context.startLongAfterStop?.pasteTarget).toEqual({ handle: 12345 });
});

for (const outcome of ['drained', 'failed', 'superseded'] as const) {
test(`actual main stop/audio IPC handlers preserve queued PCM and ${outcome} provenance`, async () => {
  // Compile the actual coordinator functions without booting Electron, hooks or a microphone.
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const functions = source.statements.filter(node => ts.isFunctionDeclaration(node)
    && ['stopRecording', 'setupAudioHandler'].includes(node.name?.text ?? ''));
  expect(functions.length).toBe(2);
  const script = ts.transpileModule(functions.map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const events: string[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const webContents = { id: 3, send: () => events.push('forced stop') };
  const service = { sendAudioBuffer: () => events.push('audio'), stop: () => events.push('stop'), abort: () => events.push('abort') };
  const capture = new CaptureSession(7, buffer => service.sendAudioBuffer(), () => events.push('drain'));
  const context = {
    IPC_CHANNELS, ArrayBuffer, isRecording: true, isStopping: false,
    recordingTerminalOverride: null,
    recordingSessionMode: 'quick', captureSession: capture, transcriptionService: service,
    overlayWindow: { isDestroyed: () => false, webContents },
    ipcMain: { on: (channel: string, fn: (...args: any[]) => void) => listeners.set(channel, fn) },
    isPerfTraceEnabled: () => false, sendOverlayRecordingState: () => {},
    getAudioFrameLevel: () => 0, broadcastRecordingState: () => {},
  };
  runInNewContext(script + '\nsetupAudioHandler();', context);
  const stopped = runInNewContext('stopRecording()', context);
  listeners.get(IPC_CHANNELS.AUDIO_DATA)?.({ sender: webContents }, new ArrayBuffer(8), 7);
  listeners.get(IPC_CHANNELS.AUDIO_DATA)?.({ sender: webContents }, new ArrayBuffer(8), 6);
  expect(events).toEqual(['drain', 'audio']);
  listeners.get(IPC_CHANNELS.AUDIO_CAPTURE_STOPPED)?.({ sender: { id: 999 } }, 7, true);
  listeners.get(IPC_CHANNELS.AUDIO_CAPTURE_STOPPED)?.({ sender: webContents }, 6, true);
  expect(events).toEqual(['drain', 'audio']);
  if (outcome === 'superseded') context.transcriptionService = { ...service };
  listeners.get(IPC_CHANNELS.AUDIO_CAPTURE_STOPPED)?.({ sender: webContents }, 7, outcome !== 'failed');
  await stopped;
  expect(events).toEqual(outcome === 'superseded' ? ['drain', 'audio'] : ['drain', 'audio', outcome === 'drained' ? 'stop' : 'abort']);
  capture.close();
});
}
