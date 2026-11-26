import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CaptureSession } from '../src/main/services/capture-session';
import { IPC_CHANNELS } from '../src/shared/constants';

test('recording snapshots auto-paste and captures the foreground only when enabled at start', async () => {
  const source = ts.createSourceFile('index.ts', readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const start = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'startRecording');
  const script = ts.transpileModule(start!.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;

  for (const [source, initial, updated, autoCopy] of [
    ['normal', false, true, true], // Copy-only at start.
    ['normal', false, false, false], // History-only.
    ['normal', true, false, false], // Auto-paste at start.
    ['lab', true, true, false],
  ] as const) {
    let autoPaste: boolean = initial;
    let captures = 0;
    const events: string[] = [];
    let output: { autoPaste: boolean; autoCopy: boolean; target: number | null } | undefined;
    let onFinal!: (frame: { text: string }) => Promise<void>;
    const context = {
      IPC_CHANNELS, app: { isPackaged: false }, serverManager: null, mainWindow: null,
      overlayWindow: { webContents: { send: () => {} } },
      isRecording: false, isStopping: false, recordingPerfTraceId: undefined,
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
      getForegroundWindowHandle: async () => { captures++; events.push('foreground'); return 12345; },
      updateConnectionState: () => {}, sendOverlayRecordingState: () => {},
      positionOverlayOnActiveDisplay: () => {}, showOverlay: () => events.push('overlay'),
      TranscriptionService: class {
        onRecordingState() {}
        onConnectionState() {}
        onTranscription() {}
        onStatus() {}
        onClose() {}
        onFinal(callback: typeof onFinal) { onFinal = callback; }
        async connect() {}
      },
      CaptureSession: class { canCommit = true; close() {} },
      processFinalTranscription: async (_frame: unknown, settings: { autoPaste: boolean; autoCopy: boolean },
        _history: unknown, _mode: unknown, target: number | null) => {
        output = { autoPaste: settings.autoPaste, autoCopy: settings.autoCopy, target };
      },
    };
    await runInNewContext(script + `\nstartRecording('${source}');`, context);
    expect(events).toEqual(source === 'normal' && initial
      ? ['foreground', 'settings', 'overlay']
      : ['settings', 'overlay']);
    autoPaste = updated;
    await onFinal({ text: 'Synthetic final text' });
    expect(captures).toBe(source === 'normal' && initial ? 1 : 0);
    expect(output).toEqual(source === 'lab' ? undefined : {
      autoPaste: initial, autoCopy, target: initial ? 12345 : null,
    });
  }
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
