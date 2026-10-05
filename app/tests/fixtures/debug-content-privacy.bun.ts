import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import type { TextFrameFinal } from '../../src/shared/protocol.js';
import type { Settings } from '../../src/shared/types.js';
import type { LogEntry } from '../../src/main/lib/logger.js';

const clipboardWrites: string[] = [];

mock.module('electron', () => ({
  BrowserWindow: class {},
  app: { getPath: () => process.env.TEMP ?? '.' },
  clipboard: {
    readText: async () => '',
    read: async () => [{ types: ['text/plain'] }],
    writeText: async (text: string) => { clipboardWrites.push(text); },
  },
}));

mock.module('child_process', () => ({
  execFile: mock(() => {}),
  spawn: mock(() => {}),
}));

mock.module('ws', () => ({
  WebSocket: class {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = 0;
    on() {}
    send() {}
    close() {}
  },
}));

process.env.MURMUR_DEBUG = '1';
const { addTransport } = await import('../../src/main/lib/logger.js');
const logEntries: LogEntry[] = [];
addTransport((entry) => logEntries.push(entry));
const { processFinalTranscription } = await import('../../src/main/services/pipeline.js');
const { TranscriptionService } = await import('../../src/main/services/transcription.js');

function captureProcessOutput() {
  const output: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const capture = (chunk: string | Uint8Array) => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };

  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  return {
    read: () => output.join(''),
    restore: () => {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    },
  };
}

const marker = 'EVE_ALPHA7_SYNTHETIC_PRIVATE_MARKER_92bf';
const frame: TextFrameFinal = {
  frame: 'text',
  type: 'final',
  text: `private marker ${marker}`,
  confidence: 0.99,
  transcription_time: 0.2,
  audio_duration: 1,
};
const settings = {
  autoPaste: false,
  autoCopy: true,
  appendPeriod: true,
  appendSpace: false,
  dictationMode: 'clean_prompt',
} as Settings;
const expectedOutput = `Private marker ${marker}.`;
const malformedFrame = `not-json:${marker}`;
const capturedOutput = captureProcessOutput();

try {
  const result = await processFinalTranscription(frame, settings, null);
  const connection = new TranscriptionService('ws://127.0.0.1:8765', 15, {} as never);
  const handleMessage = (connection as unknown as {
    handleMessage(data: string): void;
  }).handleMessage;
  handleMessage.call(connection, malformedFrame);

  assert.equal(result.entry.text, expectedOutput);
  assert.deepEqual(clipboardWrites, [expectedOutput]);
} finally {
  capturedOutput.restore();
}

assert.ok(logEntries.some((entry) =>
  entry.context === 'Pipeline' && entry.level === 'debug' && entry.message === 'Post-processing' &&
  entry.data?.inputLength === frame.text.length,
));
assert.ok(logEntries.some((entry) =>
  entry.context === 'Pipeline' && entry.level === 'debug' && entry.message === 'Post-processing complete' &&
  entry.data?.outputLength === expectedOutput.length,
));
assert.ok(logEntries.some((entry) =>
  entry.context === 'Clipboard' && entry.level === 'debug' && entry.message === 'Writing text' &&
  entry.data?.length === expectedOutput.length,
));
assert.ok(logEntries.some((entry) =>
  entry.context === 'Transcription' && entry.level === 'warn' && entry.message === 'Failed to parse server frame' &&
  entry.data?.dataLength === malformedFrame.length,
));

const contentAbsentFromTransport = !JSON.stringify(logEntries).includes(marker);
const contentAbsentFromConsole = !capturedOutput.read().includes(marker);
assert.ok(contentAbsentFromTransport);
assert.ok(contentAbsentFromConsole);
process.stdout.write(JSON.stringify({
  processedOutput: expectedOutput,
  clipboardWrite: clipboardWrites[0],
  inputLength: frame.text.length,
  outputLength: expectedOutput.length,
  clipboardLength: expectedOutput.length,
  malformedDataLength: malformedFrame.length,
  contentAbsentFromTransport,
  contentAbsentFromConsole,
}) + '\n');
