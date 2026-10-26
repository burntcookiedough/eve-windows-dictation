import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { CaptureSession } from '../src/main/services/capture-session';
import { IPC_CHANNELS } from '../src/shared/constants';

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
    isPerfTraceEnabled: () => false, updateRecordingState: () => {},
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
