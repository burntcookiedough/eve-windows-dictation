import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { perfTraceManager } from '../src/main/services/perf-trace.js';
import { buildPersistentPasteScript, PasteAbortCode } from '../src/main/services/paste-helper-script.js';
import type { ClipboardCopyOutcome } from '../src/main/services/clipboard.js';
import { DEFAULT_SETTINGS } from '../src/shared/types.js';
import type { Settings, TranscriptionEntry } from '../src/shared/types.js';

class MockClipboardItem {
  readonly types: string[];
  private _items: Record<string, string | Blob | { title: string; url: string } | Promise<Blob | string>>;

  constructor(items: Record<string, string | Blob | { title: string; url: string } | Promise<Blob | string>>) {
    this._items = { ...items };
    this.types = Object.keys(items);
  }

  async getType(type: string): Promise<Blob | { title: string; url: string }> {
    if (!(type in this._items)) {
      throw new Error(`Failed to execute 'getType' on 'ClipboardItem': The type '${type}' was not found`);
    }
    const val = await this._items[type];
    if (typeof val === 'string') {
      return new Blob([val], { type });
    }
    return val as Blob | { title: string; url: string };
  }
}

let clipboardText = '';
let clipboardFormats: string[] = [];
let clipboardWrites: string[] = [];
let clipboardItems: MockClipboardItem[] = [];
let clipboardItemWrites: MockClipboardItem[][] = [];

const clipboardReadText = mock(async () => clipboardText);
const clipboardRead = mock(async () => {
  if (clipboardItems.length > 0) {
    const currentTypes = [...new Set(clipboardItems.flatMap((item) => item.types))].sort();
    const requestedTypes = [...clipboardFormats].sort();
    if (JSON.stringify(currentTypes) === JSON.stringify(requestedTypes)) {
      return clipboardItems;
    }
  }
  const record: Record<string, string> = {};
  for (const fmt of clipboardFormats) {
    record[fmt] = fmt === 'text/plain' ? clipboardText : `content for ${fmt}`;
  }
  return [new MockClipboardItem(record)];
});

const clipboardWriteText = mock(async (text: string) => {
  clipboardText = text;
  clipboardFormats = ['text/plain'];
  clipboardItems = [new MockClipboardItem({ 'text/plain': text })];
  clipboardWrites.push(text);
});

const clipboardWrite = mock(async (items: MockClipboardItem[]) => {
  clipboardItems = [...items];
  clipboardItemWrites.push([...items]);
  clipboardFormats = [...new Set(items.flatMap((item) => item.types))].sort();
  let foundText = false;
  for (const item of items) {
    if (item.types.includes('text/plain')) {
      const blob = await item.getType('text/plain');
      if (blob instanceof Blob) {
        clipboardText = await blob.text();
        foundText = true;
        break;
      }
    }
  }
  if (!foundText) {
    clipboardText = '';
  }
});

const clipboardClear = mock(() => {
  clipboardText = '';
  clipboardFormats = [];
  clipboardItems = [];
});

function execFileStub(
  command: string,
  args: string[],
  options: { windowsHide?: boolean; timeout?: number; signal?: AbortSignal } | ((error?: Error | null, stdout?: string) => void),
  callback?: (error?: Error | null, stdout?: string) => void
) {
  const done = typeof options === 'function' ? options : callback;
  done?.(null, '12345');
  return { kill: mock(() => {}) };
}
const execFile = mock(execFileStub);
const spawn = mock((_command?: string, _args?: string[], _options?: unknown): FakePasteHelper => {
  throw new Error('Simulated paste helper unavailable');
});

mock.module('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? '.',
  },
  ClipboardItem: MockClipboardItem,
  clipboard: {
    readText: clipboardReadText,
    read: clipboardRead,
    writeText: clipboardWriteText,
    write: clipboardWrite,
    clear: clipboardClear,
  },
}));

mock.module('child_process', () => ({
  execFile,
  spawn,
}));

function setSyntheticClipboard(items: MockClipboardItem[], text?: string) {
  clipboardItems = [...items];
  clipboardFormats = [...new Set(items.flatMap((item) => item.types))].sort();
  if (typeof text === 'string') {
    clipboardText = text;
  }
}

const {
  buildSendInputScriptContent,
  copyToClipboard,
  pasteText,
  readFromClipboard,
  resumeClipboardPaste,
  simulatePaste,
  suspendClipboardPaste,
} = await import('../src/main/services/clipboard.js');
const { PersistentPasteHelper, pasteHelper } = await import('../src/main/services/paste-helper.js');
const { processFinalTranscription } = await import('../src/main/services/pipeline.js');
const clipboardSequence = 77;
const KEYDOWN_TICK = 4242;
let sequenceRead: ReturnType<typeof spyOn>;
beforeEach(() => {
  sequenceRead = spyOn(pasteHelper, 'clipboardSequence').mockResolvedValue(clipboardSequence);
});
afterEach(() => sequenceRead.mockRestore());

interface HelperRequest {
  id: number;
  type: 'ready' | 'foreground' | 'sequence' | 'paste' | 'commit' | 'discard';
  targetWindowHandle?: number;
  clipboardSequence?: number;
  deadlineUnixMs?: number;
  keydownTick?: number;
}

class FakePasteHelper extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = mock(() => {});
  readonly requests: HelperRequest[] = [];

  constructor(handleRequest?: (request: HelperRequest, helper: FakePasteHelper) => void) {
    super();
    this.stdin.on('data', (data: Buffer) => {
      const request = JSON.parse(data.toString()) as HelperRequest;
      this.requests.push(request);
      if (handleRequest) handleRequest(request, this);
      else {
        if (request.type === 'discard') return;
        const type = { ready: 'ready', foreground: 'foreground', sequence: 'sequence', paste: 'prepared', commit: 'pasted' }[request.type];
        const data = request.type === 'foreground' ? { handle: 12345 }
          : request.type === 'sequence' ? { sequence: clipboardSequence } : {};
        this.reply(request, type, data);
      }
    });
  }

  reply(request: HelperRequest, type: string, extra = {}) {
    const line = JSON.stringify({ id: request.id, type, ...extra });
    this.stdout.write(line.slice(0, 5));
    this.stdout.write(line.slice(5) + '\r\n');
  }

  crash() {
    this.emit('close', 1);
  }
}

describe('pasteText', () => {
  beforeEach(() => {
    // These tests isolate clipboard behavior after helper readiness is established.
    Object.defineProperty(pasteHelper, 'pasteWarmup', { configurable: true, value: undefined });
    clipboardText = 'previous';
    clipboardFormats = ['text/plain'];
    clipboardWrites = [];
    clipboardItemWrites = [];
    clipboardItems = [new MockClipboardItem({ 'text/plain': 'previous' })];
    clipboardReadText.mockClear();
    clipboardReadText.mockImplementation(async () => clipboardText);
    clipboardRead.mockClear();
    clipboardRead.mockImplementation(async () => {
      if (clipboardItems.length > 0) {
        const currentTypes = [...new Set(clipboardItems.flatMap((item) => item.types))].sort();
        const requestedTypes = [...clipboardFormats].sort();
        if (JSON.stringify(currentTypes) === JSON.stringify(requestedTypes)) {
          return clipboardItems;
        }
      }
      const record: Record<string, string> = {};
      for (const fmt of clipboardFormats) {
        record[fmt] = fmt === 'text/plain' ? clipboardText : `content for ${fmt}`;
      }
      return [new MockClipboardItem(record)];
    });
    clipboardWriteText.mockClear();
    clipboardWriteText.mockImplementation(async (text: string) => {
      clipboardText = text;
      clipboardFormats = ['text/plain'];
      clipboardItems = [new MockClipboardItem({ 'text/plain': text })];
      clipboardWrites.push(text);
    });
    clipboardWrite.mockClear();
    clipboardWrite.mockImplementation(async (items: MockClipboardItem[]) => {
      clipboardItems = [...items];
      clipboardItemWrites.push([...items]);
      clipboardFormats = [...new Set(items.flatMap((item) => item.types))].sort();
      let foundText = false;
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          const blob = await item.getType('text/plain');
          if (blob instanceof Blob) {
            clipboardText = await blob.text();
            foundText = true;
            break;
          }
        }
      }
      if (!foundText) {
        clipboardText = '';
      }
    });
    clipboardClear.mockClear();
    execFile.mockClear();
  });

  afterEach(() => { Reflect.deleteProperty(pasteHelper, 'pasteWarmup'); });

  test('waits for Electron to finish a clipboard write before resolving copy', async () => {
    let finishWrite: (() => void) | undefined;
    clipboardWriteText.mockImplementationOnce((text: string) => new Promise((resolve) => {
      finishWrite = () => {
        clipboardText = text;
        clipboardFormats = ['text/plain'];
        clipboardWrites.push(text);
        resolve();
      };
    }));

    let copied = false;
    const copy = copyToClipboard('copied text').then(() => { copied = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(copied).toBe(false);
    expect(clipboardWrites).toEqual([]);
    finishWrite?.();
    await copy;

    expect(copied).toBe(true);
    expect(clipboardWrites).toEqual(['copied text']);
  });

  test('reports copy failure when Electron rejects the clipboard write', async () => {
    clipboardWriteText.mockImplementationOnce(async () => {
      throw new Error('synthetic write failure');
    });

    await expect(copyToClipboard('copied text')).resolves.toEqual({ kind: 'failed' });
    expect(clipboardWrites).toEqual([]);
  });

  test('reports copy failure when a resolved Electron write leaves the old clipboard intact', async () => {
    setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'Previous copy' })], 'Previous copy');
    clipboardWriteText.mockResolvedValueOnce(undefined);

    await expect(copyToClipboard('Synthetic dictation')).resolves.toEqual({ kind: 'failed' });
    expect(clipboardText).toBe('Previous copy');
  });

  test('does not report copied when the native clipboard owner changes during read-back', async () => {
    sequenceRead.mockResolvedValueOnce(clipboardSequence).mockResolvedValueOnce(clipboardSequence + 1);

    await expect(copyToClipboard('Synthetic dictation')).resolves.toEqual({ kind: 'failed' });
  });

  test('releases the copy queue when verification cannot read the clipboard', async () => {
    const stalledRead = Promise.withResolvers<string>();
    clipboardReadText.mockImplementationOnce(() => stalledRead.promise);

    try {
      await expect(copyToClipboard('Synthetic dictation')).resolves.toEqual({ kind: 'failed' });
      await expect(copyToClipboard('Next copy')).resolves.toEqual({ kind: 'copied' });
    } finally {
      stalledRead.resolve('Synthetic dictation');
    }
  });

  for (const stalled of ['read', 'write'] as const) {
    test(`saves History before a stalled clipboard ${stalled} and ignores its late completion`, async () => {
      const began = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const historyEntries: TranscriptionEntry[] = [];
      const announced: string[] = [];
      const fixture = {
        frame: 'text', type: 'final', text: 'Synthetic dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      } as const;
      const settings = { ...DEFAULT_SETTINGS, autoCopy: false, autoPaste: true, dictationMode: 'raw' } as const;
      if (stalled === 'read') {
        clipboardReadText.mockImplementationOnce(async () => {
          began.resolve();
          await release.promise;
          return clipboardText;
        });
      } else {
        clipboardWriteText.mockImplementationOnce(async () => {
          began.resolve();
          await release.promise;
        });
      }
      const history = { save: (entry: TranscriptionEntry) => historyEntries.push(entry) };
      const dispatch = processFinalTranscription(fixture, settings, history, 'quick', 12345, undefined, {
        clipboardTimeoutMs: 50,
        onHistorySaved: entry => { announced.push(entry.id); },
      });
      try {
        await began.promise;
        const entriesAtClipboardStart = historyEntries.map(entry => entry.text);
        const announcedAtClipboardStart = [...announced];
        const result = await Promise.race([
          dispatch,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Clipboard finalization did not return')), 250)),
        ]);
        expect(entriesAtClipboardStart).toEqual(['Synthetic dictation']);
        expect(announcedAtClipboardStart).toEqual([result.entry.id]);
        expect(result.entryWithGroup?.text).toBe('Synthetic dictation');
        expect(result.delivery.kind).toBe('failed');

        const next = copyToClipboard('Next dictation');
        if (stalled === 'write') release.resolve();
        expect(await next).toEqual({ kind: 'copied' });
        release.resolve();
        await new Promise(resolve => setTimeout(resolve, 140));
        expect(clipboardWrites).toEqual(['Next dictation']);
        expect(execFile).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await dispatch;
      }
    });
  }

  test('never submits an expired dictation write waiting behind a pending Electron write', async () => {
    const writeStarted = Promise.withResolvers<void>();
    const finishWrite = Promise.withResolvers<void>();
    clipboardWriteText.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await finishWrite.promise;
    });
    const pending = copyToClipboard('Previous write');
    try {
      await writeStarted.promise;
      const { delivery } = await processFinalTranscription({
        frame: 'text', type: 'final', text: 'Expired dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      }, { ...DEFAULT_SETTINGS, autoPaste: false, autoCopy: true }, null, 'quick', null, undefined, { clipboardTimeoutMs: 25 });
      expect(delivery.kind).toBe('failed');
    } finally {
      finishWrite.resolve();
      await pending;
    }
    expect(await copyToClipboard('Next write')).toEqual({ kind: 'copied' });
    expect(clipboardWrites).toEqual(['Next write']);
  });

  test.each([false, true])('checks the queued copy deadline before the timeout callback runs (auto-paste: %s)', async (autoPaste) => {
    const writeStarted = Promise.withResolvers<void>();
    const finishWrite = Promise.withResolvers<void>();
    clipboardWriteText.mockImplementationOnce(async () => {
      writeStarted.resolve();
      await finishWrite.promise;
      setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'Previous copy' })], 'Previous copy');
    });
    const previous = copyToClipboard('Previous copy');
    const clock = spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      await writeStarted.promise;
      const expired = processFinalTranscription({
        frame: 'text', type: 'final', text: 'Expired dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      }, { ...DEFAULT_SETTINGS, autoPaste, autoCopy: true }, null, 'quick', null, undefined, { clipboardTimeoutMs: 2000 });
      clock.mockReturnValue(102_001);
      finishWrite.resolve();
      expect((await expired).delivery).toEqual({ kind: 'failed' });
      expect(clipboardWrites).toEqual([]);
      expect(clipboardText).toBe('Previous copy');
    } finally {
      finishWrite.resolve();
      await previous;
      clock.mockRestore();
    }
  });

  test('returns Electron clipboard text asynchronously', async () => {
    clipboardText = 'synthetic clipboard text';

    await expect(readFromClipboard()).resolves.toBe('synthetic clipboard text');
  });

  test('handles a rejected delayed restore write without exposing its error', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    clipboardWriteText.mockImplementationOnce(async () => {
      throw new Error('synthetic restore failure');
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardWrites).toEqual(['new text']);
    expect(clipboardText).toBe('new text');
  });

  test('does not write or simulate paste when a clipboard read fails', async () => {
    clipboardReadText.mockImplementationOnce(async () => {
      throw new Error('synthetic read failure');
    });

    await expect(pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    })).resolves.toEqual({ kind: 'failed', clipboardWrite: 'not_attempted', dispatch: 'not_attempted' });

    expect(clipboardWrites).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('finishes a pending restore before a newer paste can write', async () => {
    await pasteText('first text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    let finishRead: ((text: string) => void) | undefined;
    clipboardReadText.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(finishRead).toBeDefined();

    const secondPaste = pasteText('second text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    finishRead?.('first text');
    await secondPaste;

    expect(clipboardWrites).toEqual(['first text', 'previous', 'second text']);
    expect(clipboardText).toBe('second text');
  });

  test('releases the write queue when the restore snapshot never completes', async () => {
    await pasteText('Dictation', {
      restoreClipboard: true, restoreDelayMs: 1, targetWindowHandle: 12345,
    });
    const readStarted = Promise.withResolvers<void>();
    const finishRead = Promise.withResolvers<string>();
    clipboardReadText.mockImplementationOnce(() => {
      readStarted.resolve();
      return finishRead.promise;
    });
    await readStarted.promise;
    const nextCopy = copyToClipboard('New copy');
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        nextCopy,
        new Promise(resolve => { watchdog = setTimeout(() => resolve('queue blocked'), 1500); }),
      ])).resolves.toEqual({ kind: 'copied' });
    } finally {
      clearTimeout(watchdog);
      finishRead.resolve('Dictation');
      await nextCopy;
    }
    expect(clipboardWrites).toEqual(['Dictation', 'New copy']);
  });

  test('checks the current owner after preparing the baseline text for restoration', async () => {
    setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'Baseline' })], 'Baseline');
    await pasteText('Dictation', {
      restoreClipboard: true, restoreDelayMs: 1, targetWindowHandle: 12345,
    });
    const getType = MockClipboardItem.prototype.getType;
    const clipboardReplaced = Promise.withResolvers<void>();
    const replaceDuringPreparation = spyOn(MockClipboardItem.prototype, 'getType').mockImplementation(async function (this: MockClipboardItem, type) {
      const data = await getType.call(this, type);
      if (data instanceof Blob && await data.text() === 'Baseline') {
        setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'New copy' })], 'New copy');
        clipboardReplaced.resolve();
      }
      return data;
    });
    try {
      await clipboardReplaced.promise;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(clipboardWrites).toEqual(['Dictation']);
      expect(clipboardText).toBe('New copy');
    } finally {
      replaceDuringPreparation.mockRestore();
    }
  });

  test.each([false, true])('retains the original restore after a failed successor snapshot (old timer fired: %s)', async (oldTimerFired) => {
    setSyntheticClipboard([
      new MockClipboardItem({ 'text/plain': 'baseline', 'text/html': '<b>baseline</b>' }),
    ], 'baseline');
    await pasteText('first text', {
      restoreClipboard: true, restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    let rejectRead: ((error: Error) => void) | undefined;
    clipboardRead.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject; }));
    const failure = pasteText('second text', {
      restoreClipboard: true, restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    await new Promise((resolve) => setTimeout(resolve, oldTimerFired ? 800 : 0));
    expect(rejectRead).toBeDefined();
    rejectRead?.(new Error('Synthetic successor snapshot failure'));
    expect(await failure).toEqual({ kind: 'failed', clipboardWrite: 'not_attempted', dispatch: 'not_attempted' });
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardWrites).toEqual(['first text']);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(clipboardText).toBe('baseline');
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    const html = await clipboardItems[0].getType('text/html') as Blob;
    expect(await html.text()).toBe('<b>baseline</b>');
  });

  test('does not restore over a manual clipboard change observed by an async read', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    let finishRead: ((text: string) => void) | undefined;
    clipboardReadText.mockImplementationOnce(() => new Promise((resolve) => {
      finishRead = resolve;
    }));
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(finishRead).toBeDefined();

    clipboardText = 'user text';
    clipboardFormats = ['text/plain', 'text/html'];
    finishRead?.(clipboardText);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(clipboardWrites).toEqual(['new text']);
    expect(clipboardText).toBe('user text');
  });

  test('keeps pasted text on the clipboard long enough before restoring', async () => {
    const startedAt = Date.now();

    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('-TargetWindowHandle');
    expect(execFile.mock.calls[0]?.[1]).toContain('12345');
    expect(execFile.mock.calls[0]?.[2]).toEqual({
      windowsHide: true, timeout: 5000, signal: expect.any(AbortSignal),
    });
    expect(clipboardText).toBe('new text');

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardText).toBe('previous');
  });

  test('does not restore over a user clipboard change', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    clipboardText = 'user text';
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardText).toBe('user text');
  });

  test('does not restore over rich clipboard content with the same text', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    clipboardFormats = ['text/plain', 'text/html'];
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardText).toBe('new text');
    expect(clipboardFormats).toEqual(['text/plain', 'text/html']);
  });

  test('does not let an older paste restore over a newer paste', async () => {
    const firstPaste = pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPaste = pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    await Promise.all([firstPaste, secondPaste]);
    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardText).toBe('previous');
    expect(clipboardWrites).toContain('previous');
  });

  test('does not paste a superseded operation', async () => {
    const firstPaste = pasteText('first text', {
      restoreClipboard: false,
      restoreDelayMs: 1,
      targetWindowHandle: 11111,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPaste = pasteText('second text', {
      restoreClipboard: false,
      restoreDelayMs: 1,
      targetWindowHandle: 22222,
    });

    await Promise.all([firstPaste, secondPaste]);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('22222');
    expect(execFile.mock.calls[0]?.[1]).not.toContain('11111');
    expect(clipboardWrites).toEqual(['first text', 'second text']);
  });

  test('serializes an in-flight paste and restores the original sequence baseline', async () => {
    let finishFirstSimulation: ((error?: Error | null, stdout?: string) => void) | undefined;
    execFile.mockImplementationOnce((_command, _args, options, callback) => {
      finishFirstSimulation = typeof options === 'function' ? options : callback;
      return { kill: mock(() => {}) };
    });

    const firstPaste = pasteText('first text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 11111,
    });
    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('11111');
    const secondPaste = pasteText('second text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 22222,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(clipboardText).toBe('first text');
    expect(execFile).toHaveBeenCalledTimes(1);

    finishFirstSimulation?.(null, '');
    await Promise.all([firstPaste, secondPaste]);

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1]?.[1]).toContain('22222');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardText).toBe('previous');
  });

  test('keeps the original baseline when a newer paste starts during settling', async () => {
    const firstPaste = pasteText('first text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 11111,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondPaste = pasteText('second text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 22222,
    });

    await Promise.all([firstPaste, secondPaste]);

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('22222');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardText).toBe('previous');
  });

  test('does not fall back to untargeted VBScript when targeted SendInput fails', async () => {
    execFile.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error('target activation failed'));
      return { kill: mock(() => {}) };
    });

    await expect(simulatePaste(12345, clipboardSequence)).rejects.toThrow('target activation failed');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('does not fall back to VBScript when the SendInput process fails', async () => {
    execFile.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error('sendinput failed'));
      return { kill: mock(() => {}) };
    });

    await expect(simulatePaste(12345, clipboardSequence)).rejects.toThrow('sendinput failed');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('keeps transcript on clipboard when restoreClipboard is disabled', async () => {
    await pasteText('final transcript', {
      restoreClipboard: false,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardText).toBe('final transcript');
  });

  test('restores rich clipboard content (text/html and text/plain) faithfully after paste', async () => {
    const htmlPayload = '<b>rich baseline</b>';
    const plainPayload = 'plain baseline';
    const initialItem = new MockClipboardItem({
      'text/plain': plainPayload,
      'text/html': htmlPayload,
    });
    setSyntheticClipboard([initialItem], plainPayload);

    await pasteText('transcription text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardItemWrites.length).toBeGreaterThanOrEqual(1);
    const lastWritten = clipboardItemWrites[clipboardItemWrites.length - 1];
    expect(lastWritten).toBeDefined();
    expect(lastWritten[0].types).toContain('text/html');
    expect(lastWritten[0].types).toContain('text/plain');
    const restoredHtmlBlob = (await lastWritten[0].getType('text/html')) as Blob;
    expect(await restoredHtmlBlob.text()).toBe(htmlPayload);
    const restoredTextBlob = (await lastWritten[0].getType('text/plain')) as Blob;
    expect(await restoredTextBlob.text()).toBe(plainPayload);
  });

  test('restores image/png binary payload faithfully after paste', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const initialItem = new MockClipboardItem({
      'image/png': new Blob([pngBytes], { type: 'image/png' }),
    });
    setSyntheticClipboard([initialItem], '');

    await pasteText('transcription text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardItemWrites.length).toBeGreaterThanOrEqual(1);
    const lastWritten = clipboardItemWrites[clipboardItemWrites.length - 1];
    expect(lastWritten).toBeDefined();
    expect(lastWritten[0].types).toEqual(['image/png']);
    const restoredBlob = (await lastWritten[0].getType('image/png')) as Blob;
    const restoredBytes = new Uint8Array(await restoredBlob.arrayBuffer());
    expect(restoredBytes).toEqual(pngBytes);
  });

  test('restores custom raw OS file-list format faithfully after paste', async () => {
    const fileListPayload = 'file:///C:/path/to/file1.txt\r\nfile:///C:/path/to/file2.txt';
    const names = 'C:\\synthetic\\first.txt\0C:\\synthetic\\second.txt\0\0';
    const fileListBytes = new Uint8Array(20 + names.length * 2);
    const header = new DataView(fileListBytes.buffer);
    header.setUint32(0, 20, true); // DROPFILES.pFiles
    header.setUint32(16, 1, true); // DROPFILES.fWide
    for (let index = 0; index < names.length; index += 1) {
      header.setUint16(20 + index * 2, names.charCodeAt(index), true);
    }
    const osClipboardFormat = 'electron application/osclipboard;format="CF_HDROP"';
    const initialItem = new MockClipboardItem({
      'text/uri-list': fileListPayload,
      [osClipboardFormat]: new Blob([fileListBytes], { type: osClipboardFormat }),
    });
    setSyntheticClipboard([initialItem], fileListPayload);

    await pasteText('transcription text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardItemWrites.length).toBeGreaterThanOrEqual(1);
    const lastWritten = clipboardItemWrites[clipboardItemWrites.length - 1];
    expect(lastWritten).toBeDefined();
    expect(lastWritten[0].types).toContain('text/uri-list');
    expect(lastWritten[0].types).toContain(osClipboardFormat);
    const restoredFiles = await lastWritten[0].getType(osClipboardFormat) as Blob;
    expect(new Uint8Array(await restoredFiles.arrayBuffer())).toEqual(fileListBytes);
    const restoredUris = await lastWritten[0].getType('text/uri-list') as Blob;
    expect(await restoredUris.text()).toBe(fileListPayload);
  });

  test('restores bookmark (electron application/bookmark) faithfully after paste', async () => {
    const bookmarkPayload = { title: 'Eve Voice', url: 'https://eve.local' };
    const initialItem = new MockClipboardItem({
      'electron application/bookmark': bookmarkPayload,
    });
    setSyntheticClipboard([initialItem], '');

    await pasteText('transcription text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    expect(clipboardItemWrites.length).toBeGreaterThanOrEqual(1);
    const lastWritten = clipboardItemWrites[clipboardItemWrites.length - 1];
    expect(lastWritten).toBeDefined();
    expect(lastWritten[0].types).toEqual(['electron application/bookmark']);
    const restoredBookmark = await lastWritten[0].getType('electron application/bookmark');
    expect(restoredBookmark).toEqual(bookmarkPayload);
  });

  test('preserves a newer payload when owned format names and plain text are unchanged', async () => {
    const pngA = new Uint8Array([137, 80, 78, 71, 1, 1, 1, 1]);
    const pngB = new Uint8Array([137, 80, 78, 71, 2, 2, 2, 2]);

    setSyntheticClipboard([
      new MockClipboardItem({
        'text/plain': 'shared text',
        'image/png': new Blob([pngA], { type: 'image/png' }),
      }),
    ], 'shared text');

    // Model an additional native format exposed alongside our plain-text write.
    // The user's subsequent update changes bytes without adding a format.
    clipboardWriteText.mockImplementationOnce(async (text: string) => {
      clipboardText = text;
      clipboardItems = [new MockClipboardItem({
        'text/plain': text,
        'image/png': new Blob([pngA], { type: 'image/png' }),
      })];
      clipboardFormats = ['text/plain', 'image/png'];
      clipboardWrites.push(text);
    });

    await pasteText('transcription text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    // While waiting for restore, user copies new image B with identical format names and text
    setSyntheticClipboard([
      new MockClipboardItem({
        'text/plain': 'transcription text',
        'image/png': new Blob([pngB], { type: 'image/png' }),
      }),
    ], 'transcription text');

    await new Promise((resolve) => setTimeout(resolve, 800));

    // Must NOT restore over user's new image B
    expect(clipboardItemWrites).toEqual([]);
    const currentItem = clipboardItems[0];
    const currentBlob = (await currentItem.getType('image/png')) as Blob;
    const currentBytes = new Uint8Array(await currentBlob.arrayBuffer());
    expect(currentBytes).toEqual(pngB);
  });

  test('does not inspect unreadable old payloads when clipboard restoration is disabled', async () => {
    const readUnknownPayload = mock(async () => { throw new Error('Unreadable baseline'); });
    clipboardItems = [{ types: ['custom/unreadable'], getType: readUnknownPayload } as unknown as MockClipboardItem];
    clipboardFormats = ['custom/unreadable'];

    await pasteText('explicitly replace clipboard', {
      restoreClipboard: false, restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });

    expect(readUnknownPayload).not.toHaveBeenCalled();
    expect(clipboardText).toBe('explicitly replace clipboard');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('restores an empty clipboard without inventing a text format', async () => {
    clipboardRead.mockImplementationOnce(async () => []);
    clipboardText = '';
    clipboardFormats = [];
    clipboardItems = [];
    await pasteText('temporary text', {
      restoreClipboard: true, restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardClear).toHaveBeenCalledTimes(1);
    expect(clipboardFormats).toEqual([]);
  });

  test('restores multiple items together in one native write', async () => {
    setSyntheticClipboard([
      new MockClipboardItem({ 'text/plain': 'first', 'text/html': '<b>first</b>' }),
      new MockClipboardItem({ 'image/png': new Blob([new Uint8Array([1, 2, 3])]) }),
    ], 'first');
    await pasteText('temporary text', {
      restoreClipboard: true, restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(clipboardItemWrites[0].length).toBe(2);
    const first = await clipboardItemWrites[0][0].getType('text/html') as Blob;
    const second = await clipboardItemWrites[0][1].getType('image/png') as Blob;
    expect(await first.text()).toBe('<b>first</b>');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('does not fall back to destructive text restore if atomic rich restore fails', async () => {
    setSyntheticClipboard([
      new MockClipboardItem({ 'text/plain': 'baseline', 'text/html': '<b>baseline</b>' }),
    ], 'baseline');
    clipboardWrite.mockImplementationOnce(async () => { throw new Error('Synthetic atomic write failure'); });
    await pasteText('temporary text', {
      restoreClipboard: true, restoreDelayMs: 1,
      targetWindowHandle: 12345,
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(clipboardWrites).toEqual(['temporary text']);
    expect(clipboardText).toBe('temporary text');
    expect(clipboardClear).not.toHaveBeenCalled();
  });

  test('aborts paste and preserves unknown clipboard when async snapshot getType fails for an unreadable format', async () => {
    const unreadableItem = {
      types: ['custom/unreadable'],
      getType: mock(async () => {
        throw new Error('OS format cannot be read');
      }),
    };
    clipboardItems = [unreadableItem as unknown as MockClipboardItem];
    clipboardFormats = ['custom/unreadable'];

    await expect(pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      targetWindowHandle: 12345,
    })).resolves.toEqual({ kind: 'failed', clipboardWrite: 'not_attempted', dispatch: 'not_attempted' });

    expect(clipboardWrites).toEqual([]);
    expect(clipboardItemWrites).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('persistent paste helper', () => {
  let children: FakePasteHelper[];
  let nextChild: number;

  function nextHelper(handleRequest?: ConstructorParameters<typeof FakePasteHelper>[0]) {
    const child = new FakePasteHelper(handleRequest);
    children.push(child);
    return child;
  }

  async function readyPasteHelper(handleRequest?: ConstructorParameters<typeof FakePasteHelper>[0]) {
    const paste = nextHelper(handleRequest && ((request, helper) => {
      if (request.type === 'ready') helper.reply(request, 'ready');
      else handleRequest(request, helper);
    }));
    nextHelper();
    await pasteHelper.warmUp();
    return paste;
  }

  beforeEach(() => {
    children = [];
    nextChild = 0;
    spawn.mockClear();
    spawn.mockImplementation(() => {
      const child = children[nextChild++];
      if (!child) throw new Error('Simulated paste helper unavailable');
      return child;
    });
    execFile.mockClear();
  });

  afterEach(() => {
    suspendClipboardPaste();
    spawn.mockImplementation(() => { throw new Error('Simulated paste helper unavailable'); });
    resumeClipboardPaste();
    execFile.mockImplementation(execFileStub);
  });

  for (const moved of [false, true]) {
    test(`routes a legacy VBScript profile through the guarded helper (focus moved: ${moved})`, async () => {
      setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'previous' })], 'previous');
      let foreground = 12345;
      const child = nextHelper((request, helper) => {
        if (request.type === 'ready') helper.reply(request, 'ready');
        if (request.type === 'paste') {
          expect(request.targetWindowHandle).toBe(12345);
          expect(request.clipboardSequence).toBe(clipboardSequence);
          if (moved) foreground = 23456;
          helper.reply(request, 'prepared');
        }
        if (request.type === 'commit') {
          if (foreground === 12345) helper.reply(request, 'pasted');
          else helper.reply(request, 'aborted', { code: PasteAbortCode.ForegroundChanged });
        }
      });
      const snapshot = nextHelper();
      await pasteHelper.warmUp();
      const target = await pasteHelper.foreground(KEYDOWN_TICK);
      const { delivery } = await processFinalTranscription({
        frame: 'text', type: 'final', text: 'Synthetic dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      }, { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true, pasteMethod: 'vbscript', dictationMode: 'raw' }, null, 'quick', target);
      expect(delivery).toEqual(moved
        ? { kind: 'skipped_unsafe', reason: 'foreground_changed', copied: true }
        : { kind: 'pasted' });
      expect(child.requests.map(({ type }) => type)).toEqual(['ready', 'paste', 'commit']);
      expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready', 'foreground']);
      expect(execFile).not.toHaveBeenCalled();
      expect(clipboardText).toBe('Synthetic dictation');
    });
  }

  test('reuses separate hidden PowerShell processes for foreground and several pastes', async () => {
    const child = nextHelper();
    const snapshot = nextHelper();
    await pasteHelper.warmUp();
    expect(await pasteHelper.foreground(KEYDOWN_TICK)).toEqual({ handle: 12345 });
    for (const target of [12345, 23456, 34567]) await simulatePaste(target, clipboardSequence);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledWith('powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    expect(child.requests.map(({ type }) => type)).toEqual([
      'ready', 'paste', 'commit', 'paste', 'commit', 'paste', 'commit',
    ]);
    expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready', 'foreground']);
    const preparations = child.requests.filter(({ type }) => type === 'paste');
    expect(preparations.map(({ targetWindowHandle }) => targetWindowHandle)).toEqual([12345, 23456, 34567]);
    expect(preparations.map(request => request.clipboardSequence)).toEqual([clipboardSequence, clipboardSequence, clipboardSequence]);
    expect(child.requests.filter(({ type }) => type === 'commit').map(({ id }) => id))
      .toEqual(preparations.map(({ id }) => id));
    expect(new Set(preparations.map(({ id }) => id)).size).toBe(3);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('preserves a newer copy when a dispatched paste loses its reply', async () => {
    setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'baseline' })], 'baseline');
    const child = await readyPasteHelper((request, helper) => {
      if (request.type === 'paste') helper.reply(request, 'prepared');
      if (request.type === 'commit') {
        setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'new copy' })], 'new copy');
        helper.crash();
      }
    });
    const { delivery } = await processFinalTranscription({
      frame: 'text', type: 'final', text: 'Synthetic dictation',
      confidence: 1, audio_duration: 1, transcription_time: 0.5,
    }, { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true, dictationMode: 'raw' }, null, 'quick', 12345);

    expect(child.requests.map(({ type }) => type)).toEqual(['ready', 'paste', 'commit']);
    expect(clipboardText).toBe('new copy');
    expect(delivery).toEqual({ kind: 'failed', clipboardWrite: 'written', dispatch: 'uncertain' });
  });

  test('checks whether the dictation is still copied when a foreground abort arrives', async () => {
    setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'baseline' })], 'baseline');
    await readyPasteHelper((request, helper) => {
      if (request.type === 'paste') helper.reply(request, 'prepared');
      if (request.type === 'commit') {
        setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'new copy' })], 'new copy');
        helper.reply(request, 'aborted', { code: PasteAbortCode.ForegroundChanged });
      }
    });

    const delivery = await pasteText('Synthetic dictation', {
      restoreClipboard: true, restoreDelayMs: 1, targetWindowHandle: 12345,
    });

    expect(clipboardText).toBe('new copy');
    expect(delivery).toEqual({ kind: 'skipped_unsafe', reason: 'foreground_changed', copied: false });
  });

  test('prewarms without capturing a window or sending keys', async () => {
    const child = nextHelper();
    const snapshot = nextHelper();
    const helper = new PersistentPasteHelper();
    expect(spawn).not.toHaveBeenCalled();
    try {
      await helper.warmUp();
      expect(child.requests.map(({ type }) => type)).toEqual(['ready']);
      expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready']);
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ handle: 12345 });
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      helper.shutdown();
    }
  });

  for (const expectedSequence of [clipboardSequence, 0]) {
    test(`samples the native clipboard sequence immediately after the write (${expectedSequence})`, async () => {
      sequenceRead.mockRestore();
      let clipboardAtSample = '';
      const child = nextHelper((request, helper) => {
        switch (request.type) {
          case 'ready': helper.reply(request, 'ready'); break;
          case 'sequence':
            clipboardAtSample = clipboardText;
            helper.reply(request, 'sequence', { sequence: expectedSequence });
            break;
          case 'paste': helper.reply(request, 'prepared'); break;
          case 'commit': helper.reply(request, 'pasted'); break;
        }
      });
      nextHelper();
      await pasteHelper.warmUp();
      const onDispatch = mock(() => {});
      const outcome = await pasteText('Synthetic dictation', {
        targetWindowHandle: 12345,
        restoreClipboard: false, restoreDelayMs: 750, onDispatch,
      });
      expect(clipboardAtSample).toBe('Synthetic dictation');
      expect(outcome).toEqual(expectedSequence
        ? { kind: 'pasted' }
        : { kind: 'skipped_unsafe', reason: 'clipboard_changed', copied: true });
      expect(clipboardText).toBe('Synthetic dictation');
      expect(child.requests.map(({ type }) => type)).toEqual(
        expectedSequence ? ['ready', 'sequence', 'paste', 'commit'] : ['ready', 'sequence']
      );
      if (expectedSequence) expect(child.requests[2]?.clipboardSequence).toBe(expectedSequence);
      expect(onDispatch).toHaveBeenCalledTimes(expectedSequence ? 1 : 0);
      expect(execFile).not.toHaveBeenCalled();
    });
  }

  for (const code of Object.values(PasteAbortCode)) {
    test(`persistent native abort ${code} never retries the paste`, async () => {
      const child = nextHelper((request, helper) => {
        if (request.type === 'paste') helper.reply(request, 'prepared');
        else if (request.type === 'commit') helper.reply(request, 'aborted', { code });
      });
      await expect(simulatePaste(12345, clipboardSequence)).rejects.toMatchObject({ code });
      expect(child.requests.map(({ type }) => type)).toEqual(['paste', 'commit']);
      expect(child.kill).not.toHaveBeenCalled();
      expect(execFile).not.toHaveBeenCalled();
    });

    test(`one-shot native abort ${code} is returned with the same meaning`, async () => {
      nextHelper((_request, child) => child.crash());
      execFile.mockImplementationOnce((_command, _args, _options, callback) => {
        callback?.(Object.assign(new Error('Native paste aborted'), { code }));
        return { kill: mock(() => {}) };
      });
      await expect(simulatePaste(12345, clipboardSequence)).rejects.toMatchObject({ code });
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile.mock.calls[0]?.[1].slice(-6)).toEqual([
        '-TargetWindowHandle', '12345', '-ClipboardSequence', String(clipboardSequence),
        '-DeadlineUnixMs', expect.stringMatching(/^\d+$/),
      ]);
    });
  }

  test('passes the pipeline deadline through preparation and reports native expiry without retrying', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(100_000);
    try {
      const child = await readyPasteHelper((request, helper) => {
        if (request.type === 'paste') helper.reply(request, 'prepared');
        if (request.type === 'commit') {
          clock.mockReturnValue(104_001); // Focus restoration finished after the deadline.
          helper.reply(request, 'aborted', { code: 22 });
        }
      });
      const { delivery } = await processFinalTranscription({
        frame: 'text', type: 'final', text: 'Synthetic dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      }, { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true }, null, 'quick', 12345, undefined, {
        clipboardTimeoutMs: 4000,
      });
      expect(child.requests).toMatchObject([
        { type: 'ready' },
        { type: 'paste', deadlineUnixMs: 104_000 },
        { type: 'commit' },
      ]);
      expect(delivery).toEqual({ kind: 'skipped_unsafe', reason: 'expired', copied: false });
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test('a sequence mismatch preserves a new clipboard owner even when its text matches', async () => {
    setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'previous' })], 'previous');
    await readyPasteHelper((request, helper) => {
      if (request.type === 'paste') helper.reply(request, 'prepared');
      else if (request.type === 'commit') helper.reply(request, 'aborted', { code: PasteAbortCode.ClipboardChanged });
    });
    const outcome = await pasteText('Synthetic dictation', {
      targetWindowHandle: 12345, restoreClipboard: true, restoreDelayMs: 1,
    });
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(outcome).toEqual({ kind: 'skipped_unsafe', reason: 'clipboard_changed', copied: false });
    expect(clipboardText).toBe('Synthetic dictation');
    expect(execFile).not.toHaveBeenCalled();
  });

  test('an invalid target never becomes an untargeted paste', async () => {
    await expect(simulatePaste(NaN, clipboardSequence)).rejects.toThrow('Invalid paste target');
    await expect(simulatePaste(0, clipboardSequence)).rejects.toThrow('Invalid paste target');
    expect(spawn).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });

  test('falls back exactly once if the helper crashes during preparation and restarts on demand', async () => {
    const crashed = nextHelper((_request, child) => child.crash());
    await simulatePaste(12345, clipboardSequence);
    expect(crashed.requests.map(({ type }) => type)).toEqual(['paste']);
    expect(crashed.kill).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('12345');
    expect(spawn).toHaveBeenCalledTimes(1);

    const restarted = nextHelper();
    await simulatePaste(23456, clipboardSequence);
    expect(restarted.requests.map(({ type }) => type)).toEqual(['paste', 'commit']);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('kills a helper that replies with the wrong id and falls back before commit', async () => {
    const child = nextHelper((request, helper) => helper.reply({ ...request, id: request.id + 1 }, 'prepared'));
    await simulatePaste(12345, clipboardSequence);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('the first hotkey after startup captures a target and commits once', async () => {
    const paste = nextHelper();
    const snapshot = nextHelper();
    await pasteHelper.warmUp();
    const result = await processFinalTranscription({
      frame: 'text', type: 'final', text: 'First synthetic dictation',
      confidence: 1, audio_duration: 1, transcription_time: 0.5,
    }, { ...DEFAULT_SETTINGS, autoPaste: true }, null, 'quick', pasteHelper.foreground(KEYDOWN_TICK));
    expect(result.delivery).toEqual({ kind: 'pasted' });
    expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready', 'foreground']);
    expect(paste.requests.map(({ type }) => type)).toEqual(['ready', 'paste', 'commit']);
    expect(execFile).not.toHaveBeenCalled();
  });

  for (const operation of ['commit', 'sequence'] as const) {
    test(`captures the hotkey window while the paste helper waits for ${operation}`, async () => {
      const pending = Promise.withResolvers<HelperRequest>();
      const paste = nextHelper((request, helper) => {
        if (request.type === 'ready') helper.reply(request, 'ready');
        if (request.type === 'paste') helper.reply(request, 'prepared');
        if (request.type === operation) pending.resolve(request);
      });
      const snapshot = nextHelper();
      const helper = new PersistentPasteHelper();
      try {
        await helper.warmUp();
        const inFlight = operation === 'commit' ? helper.paste(67890, clipboardSequence) : helper.clipboardSequence();
        const request = await pending.promise;
        const target = await helper.foreground(KEYDOWN_TICK);
        paste.reply(request, operation === 'commit' ? 'pasted' : 'sequence', { sequence: clipboardSequence });
        await inFlight;
        expect(target).toEqual({ handle: 12345 });
        expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready', 'foreground']);
      } finally {
        helper.shutdown();
      }
    });
  }

  for (const channel of ['snapshot', 'paste'] as const) {
    test(`a ready ${channel} helper crash rewarms before the next hotkey`, async () => {
      const paste = nextHelper();
      const snapshot = nextHelper();
      const restarted = nextHelper();
      const helper = new PersistentPasteHelper();
      try {
        await helper.warmUp();
        (channel === 'snapshot' ? snapshot : paste).crash();
        expect(restarted.requests.map(({ type }) => type)).toEqual(['ready']);
        expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ handle: 12345 });
        expect(await helper.clipboardSequence()).toBe(clipboardSequence);
        expect(spawn).toHaveBeenCalledTimes(3);
      } finally {
        helper.shutdown();
      }
    });
  }

  test('reports absent, warming, busy, and missing-window snapshots without queuing another sample', async () => {
    nextHelper();
    const snapshot = nextHelper(() => {});
    const helper = new PersistentPasteHelper();
    try {
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_absent' });
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_unready' });
      expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready']);
      snapshot.reply(snapshot.requests[0]!, 'ready');
      const sampling = helper.foreground(KEYDOWN_TICK);
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_busy' });
      snapshot.reply(snapshot.requests[1]!, 'foreground', { handle: 0 });
      expect(await sampling).toEqual({ reason: 'no_hwnd' });
      expect(snapshot.requests.map(({ type }) => type)).toEqual(['ready', 'foreground']);
    } finally {
      helper.shutdown();
    }
  });

  test('carries the original snapshot failure through a completed History-and-copy trace', async () => {
    const saved = process.env.MURMUR_PERF_TRACE;
    process.env.MURMUR_PERF_TRACE = '1';
    try {
      const traceId = perfTraceManager.startTrace('synthetic-missing-foreground')!.correlationId;
      const target = pasteHelper.foreground(KEYDOWN_TICK);
      const { delivery } = await processFinalTranscription({
        frame: 'text', type: 'final', text: 'Synthetic dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      }, { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true }, { save: () => {} }, 'quick', target, traceId);
      perfTraceManager.completeTrace(traceId);
      const trace = perfTraceManager.getRecentTraces().find(trace => trace.correlationId === traceId)!;
      expect(delivery).toEqual({ kind: 'skipped_unsafe', reason: 'no_target', copied: true });
      expect(trace.pastePreDispatchReason).toBe('helper_absent');
      expect(trace.main.historyCompletedAt).not.toBeNull();
      expect(trace.main.pasteHelperRequestSentAt).toBeNull();
    } finally {
      perfTraceManager.clear();
      if (saved === undefined) delete process.env.MURMUR_PERF_TRACE;
      else process.env.MURMUR_PERF_TRACE = saved;
    }
  });

  test('identifies an unavailable sequence as a clipboard preflight exit', async () => {
    await readyPasteHelper();
    sequenceRead.mockResolvedValue(null);
    const saved = process.env.MURMUR_PERF_TRACE;
    process.env.MURMUR_PERF_TRACE = '1';
    try {
      const traceId = perfTraceManager.startTrace('synthetic-missing-sequence')!.correlationId;
      await pasteText('Synthetic dictation', {
        targetWindowHandle: 12345, restoreClipboard: false, restoreDelayMs: 750, perfTraceId: traceId,
      });
      perfTraceManager.completeTrace(traceId);
      const trace = perfTraceManager.getRecentTraces().find(trace => trace.correlationId === traceId)!;
      expect(trace.pastePreDispatchReason).toBe('clipboard_sequence_unavailable');
      expect(trace.main.pasteOwnershipCheckedAt).not.toBeNull();
      expect(trace.main.pasteHelperRequestSentAt).toBeNull();
    } finally {
      perfTraceManager.clear();
      if (saved === undefined) delete process.env.MURMUR_PERF_TRACE;
      else process.env.MURMUR_PERF_TRACE = saved;
    }
  });

  for (const outcome of ['focus changed during timeout', 'capture tools unavailable'] as const) {
    test(`forgoes paste when the start window is unavailable: ${outcome}`, async () => {
      let foreground = 12345; // Editor A is active at recording start.
      const paste = nextHelper();
      const child = nextHelper((request, helper) => {
        if (request.type === 'ready') helper.reply(request, 'ready');
        else if (outcome === 'capture tools unavailable') helper.crash();
      });
      execFile.mockImplementation((_command, _args, _options, callback) => {
        if (outcome === 'capture tools unavailable') callback?.(new Error('One-shot also unavailable'));
        else callback?.(null, String(foreground));
        return { kill: mock(() => {}) };
      });
      await pasteHelper.warmUp();
      const capture = pasteHelper.foreground(KEYDOWN_TICK);
      foreground = 23456; // A later sample would see chat B.
      const target = await capture;
      const foregroundRequest = child.requests.at(-1)!;
      child.reply(foregroundRequest, 'foreground', { handle: foreground });
      expect(target).toEqual({ reason: outcome === 'focus changed during timeout' ? 'rpc_timeout' : 'helper_absent' });
      expect(child.requests.map(({ type }) => type)).toEqual(['ready', 'foreground']);
      expect(child.kill).toHaveBeenCalledTimes(1);

      const saved: TranscriptionEntry[] = [];
      const autoCopy = outcome === 'focus changed during timeout';
      const settings: Settings = { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy, dictationMode: 'raw' };
      setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'previous' })], 'previous');
      await processFinalTranscription({
        frame: 'text', type: 'final', text: 'Synthetic dictation',
        confidence: 1, audio_duration: 1, transcription_time: 0.5,
      }, settings, { save: entry => saved.push(entry) }, 'quick', target);
      expect(clipboardText).toBe(autoCopy ? 'Synthetic dictation' : 'previous');
      expect(saved.map(entry => entry.text)).toEqual(['Synthetic dictation']);
      expect(execFile).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(paste.requests.map(({ type }) => type)).toEqual(['ready']);
    });
  }

  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const types = (child: FakePasteHelper) => child.requests.map(({ type }) => type);
  const syntheticFinal = {
    frame: 'text', type: 'final', text: 'Synthetic dictation',
    confidence: 1, audio_duration: 1, transcription_time: 0.5,
  } as const;

  for (const duringBaselineRead of [false, true]) {
    test(`helper and replacement exit after target capture (baseline pending: ${duringBaselineRead})`, async () => {
      const paste = await readyPasteHelper();
      const replacement = nextHelper((_request, helper) => helper.crash());
      const target = await pasteHelper.foreground(KEYDOWN_TICK);
      expect(target).toEqual({ handle: 12345 });
      sequenceRead.mockRestore();
      clipboardWriteText.mockClear();
      setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'Previous synthetic text' })], 'Previous synthetic text');
      const baselineStarted = Promise.withResolvers<void>();
      const baselineRead = Promise.withResolvers<string>();
      if (duringBaselineRead) {
        clipboardReadText.mockImplementationOnce(() => {
          baselineStarted.resolve();
          return baselineRead.promise;
        });
      } else {
        paste.crash();
      }
      const save = mock(() => {});
      const result = processFinalTranscription(syntheticFinal, {
        ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: !duringBaselineRead, restoreClipboardAfterPaste: true,
        dictationMode: 'raw',
      }, { save }, 'quick', target);
      try {
        if (duringBaselineRead) {
          await Promise.race([baselineStarted.promise, result.then(() => { throw new Error('Baseline read did not start'); })]);
          paste.crash();
          baselineRead.resolve('Previous synthetic text');
        }
        expect((await result).delivery).toEqual({ kind: 'skipped_unsafe', reason: 'paste_unavailable', copied: !duringBaselineRead });
        expect(save).toHaveBeenCalledTimes(1);
        expect(clipboardWriteText).toHaveBeenCalledTimes(duringBaselineRead ? 0 : 1);
        expect(clipboardText).toBe(duringBaselineRead ? 'Previous synthetic text' : 'Synthetic dictation');
        expect(types(paste)).toEqual(['ready']);
        expect(types(replacement)).toEqual(['ready']);
        expect(execFile).not.toHaveBeenCalled();
      } finally {
        baselineRead.resolve('Previous synthetic text');
      }
    });
  }

  for (const scenario of ['stalled second read', 'user copy during baseline', 'ready past deadline'] as const) {
    test(`preserves the pending restore on helper replacement with ${scenario}`, async () => {
      const paste = await readyPasteHelper();
      const replacement = nextHelper();
      setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'Original clipboard' })], 'Original clipboard');
      await expect(pasteText('First dictation', {
        targetWindowHandle: 12345, restoreClipboard: true, restoreDelayMs: 1,
      })).resolves.toEqual({ kind: 'pasted' });
      const baselineStarted = Promise.withResolvers<void>();
      const baselineRead = Promise.withResolvers<string>();
      const unexpectedRead = Promise.withResolvers<string>();
      clipboardWriteText.mockClear();
      clipboardReadText.mockClear();
      clipboardReadText.mockImplementation(() => {
        if (clipboardReadText.mock.calls.length === 1) {
          baselineStarted.resolve();
          return baselineRead.promise;
        }
        return unexpectedRead.promise;
      });
      const clock = spyOn(Date, 'now').mockReturnValue(100_000);
      const delivery = pasteText('Second dictation', {
        targetWindowHandle: 12345, restoreClipboard: true, restoreDelayMs: 1,
        deadlineUnixMs: 101_000, signal: AbortSignal.timeout(450),
      });
      try {
        await Promise.race([baselineStarted.promise, delivery.then(() => { throw new Error('Baseline read did not start'); })]);
        if (scenario === 'ready past deadline') clock.mockReturnValue(101_001);
        paste.crash();
        expect(pasteHelper.pasteWarmup).toBeUndefined();
        if (scenario === 'user copy during baseline') {
          setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'User copy' })], 'User copy');
        }
        baselineRead.resolve('First dictation');
        expect(await delivery).toEqual({ kind: 'skipped_unsafe', reason: 'paste_unavailable', copied: false });
        expect(clipboardReadText).toHaveBeenCalledTimes(1);
        expect(clipboardWriteText).not.toHaveBeenCalled();
        expect(types(replacement)).toEqual(['ready']);
        expect(types(paste)).toEqual(['ready', 'paste', 'commit']);
        expect(execFile).not.toHaveBeenCalled();
      } finally {
        baselineRead.resolve('First dictation');
        unexpectedRead.resolve(clipboardText);
        clipboardReadText.mockImplementation(async () => clipboardText);
        clock.mockRestore();
      }
      await Bun.sleep(850);
      expect(clipboardReadText).toHaveBeenCalledTimes(2);
      if (scenario === 'user copy during baseline') {
        expect(clipboardText).toBe('User copy');
        expect(clipboardWriteText).not.toHaveBeenCalled();
      } else {
        expect(clipboardText).toBe('Original clipboard');
        expect(clipboardWriteText.mock.calls).toEqual([['Original clipboard']]);
      }
    });
  }

  test('a stale authorization read preserves the pre-dispatch fallback timeout trace', async () => {
    const originalRead = Promise.withResolvers<string>();
    const fallbackRead = Promise.withResolvers<string>();
    const originalStarted = Promise.withResolvers<void>();
    const fallbackStarted = Promise.withResolvers<void>();
    const child = await readyPasteHelper((request, helper) => {
      if (request.type !== 'paste') return;
      clipboardReadText
        .mockImplementationOnce(() => {
          originalStarted.resolve();
          return originalRead.promise;
        })
        .mockImplementationOnce(() => {
          fallbackStarted.resolve();
          return fallbackRead.promise;
        });
      helper.reply(request, 'prepared');
    });
    nextHelper();
    const saved = process.env.MURMUR_PERF_TRACE;
    process.env.MURMUR_PERF_TRACE = '1';
    try {
      const traceId = perfTraceManager.startTrace('synthetic-stale-authorization')!.correlationId;
      const result = processFinalTranscription(syntheticFinal,
        { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true, dictationMode: 'raw' },
        null, 'quick', 12345, traceId, { clipboardTimeoutMs: 1500 });
      const completedEarly = result.then(() => { throw new Error('Delivery settled before authorization'); });
      await Promise.race([originalStarted.promise, completedEarly]);
      child.crash();
      await Promise.race([fallbackStarted.promise, completedEarly]);
      originalRead.resolve('Synthetic dictation');
      expect((await result).delivery).toEqual({ kind: 'failed' });
      const trace = perfTraceManager.getRecentTraces().find(trace => trace.correlationId === traceId)!;
      expect(trace.pastePreDispatchReason).toBe('clipboard_finalization_timeout');
      expect(types(child)).toEqual(['ready', 'paste']);
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      originalRead.resolve('Synthetic dictation');
      fallbackRead.resolve('Synthetic dictation');
      perfTraceManager.clear();
      if (saved === undefined) delete process.env.MURMUR_PERF_TRACE;
      else process.env.MURMUR_PERF_TRACE = saved;
    }
  });

  test('binds the capture to its keydown and never pastes after focus moved before the sample', async () => {
    const paste = nextHelper();
    const snapshot = nextHelper((request, helper) => {
      if (request.type === 'ready') helper.reply(request, 'ready');
      // Editor A had focus at the keydown; chat B took it before the helper sampled.
      else helper.reply(request, 'rejected', { reason: 'focus_changed' });
    });
    await pasteHelper.warmUp();
    setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'previous' })], 'previous');
    const saved: TranscriptionEntry[] = [];
    const target = pasteHelper.foreground(KEYDOWN_TICK);
    const { delivery } = await processFinalTranscription(syntheticFinal,
      { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true, dictationMode: 'raw' },
      { save: entry => saved.push(entry) }, 'quick', target);
    expect(await target).toEqual({ reason: 'focus_changed' });
    expect(snapshot.requests).toMatchObject([{ type: 'ready' }, { type: 'foreground', keydownTick: KEYDOWN_TICK }]);
    expect(delivery).toEqual({ kind: 'skipped_unsafe', reason: 'no_target', copied: true });
    expect(saved.map(entry => entry.text)).toEqual(['Synthetic dictation']);
    expect(clipboardText).toBe('Synthetic dictation');
    expect(types(paste)).toEqual(['ready']);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('refuses a capture that cannot name its keydown without sampling the current window', async () => {
    nextHelper();
    const snapshot = nextHelper();
    await pasteHelper.warmUp();
    for (const tick of [undefined, -1, 1.5, 2 ** 32, Number.NaN]) {
      expect(await pasteHelper.foreground(tick)).toEqual({ reason: 'keydown_unverified' });
    }
    expect(types(snapshot)).toEqual(['ready']);
  });

  test('treats an unknown rejection reason as a broken helper, not a target', async () => {
    nextHelper();
    const snapshot = nextHelper((request, helper) => {
      if (request.type === 'ready') helper.reply(request, 'ready');
      else helper.reply(request, 'rejected', { reason: 'C:\\private\\path' });
    });
    nextHelper();
    await pasteHelper.warmUp();
    expect(await pasteHelper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_absent' });
    expect(snapshot.kill).toHaveBeenCalledTimes(1);
  });

  test('a hotkey before the replacement snapshot helper is ready falls back without sampling', async () => {
    nextHelper();
    const snapshot = nextHelper();
    let readyRequest: HelperRequest | undefined;
    const replacement = nextHelper((request, helper) => {
      if (request.type === 'ready') readyRequest = request;
      else helper.reply(request, 'foreground', { handle: 23456 });
    });
    const helper = new PersistentPasteHelper();
    try {
      await helper.warmUp();
      snapshot.crash();
      expect(types(replacement)).toEqual(['ready']);
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_unready' });
      expect(types(replacement)).toEqual(['ready']);
      replacement.reply(readyRequest!, 'ready');
      await settle();
      expect(await helper.foreground(KEYDOWN_TICK + 1)).toEqual({ handle: 23456 });
      expect(replacement.requests.at(-1)).toMatchObject({ type: 'foreground', keydownTick: KEYDOWN_TICK + 1 });
    } finally {
      helper.shutdown();
    }
  });

  test('a snapshot helper that never answers times out once and is replaced', async () => {
    nextHelper();
    const silent = nextHelper((request, helper) => {
      if (request.type === 'ready') helper.reply(request, 'ready');
    });
    const replacement = nextHelper();
    const helper = new PersistentPasteHelper();
    try {
      await helper.warmUp();
      const sentAt = performance.now();
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'rpc_timeout' });
      expect(performance.now() - sentAt).toBeGreaterThanOrEqual(90);
      expect(types(silent)).toEqual(['ready', 'foreground']);
      expect(silent.kill).toHaveBeenCalledTimes(1);
      expect(types(replacement)).toEqual(['ready']);
      await settle();
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ handle: 12345 });
    } finally {
      helper.shutdown();
    }
  });

  for (const frame of ['late handle', 'expired'] as const) {
    test(`a ${frame} frame that arrives before the timer fires settles as a timeout`, async () => {
      nextHelper();
      let clock: ReturnType<typeof spyOn> | undefined;
      const snapshot = nextHelper((request, helper) => {
        if (request.type === 'ready') {
          helper.reply(request, 'ready');
        } else if (frame === 'expired') {
          helper.reply(request, 'expired');
        } else {
          // The reply is read after its deadline, before the 100 ms JS timer runs.
          const now = performance.now();
          clock = spyOn(performance, 'now').mockReturnValue(now + 1000);
          helper.reply(request, 'foreground', { handle: 23456 });
        }
      });
      nextHelper();
      const helper = new PersistentPasteHelper();
      try {
        await helper.warmUp();
        const sentAt = Date.now();
        const result = await helper.foreground(KEYDOWN_TICK);
        const settledAfterMs = Date.now() - sentAt;
        clock?.mockRestore();
        expect(result).toEqual({ reason: 'rpc_timeout' });
        expect(settledAfterMs).toBeLessThan(90);
        expect(snapshot.kill).toHaveBeenCalledTimes(frame === 'expired' ? 0 : 1);
      } finally {
        clock?.mockRestore();
        helper.shutdown();
      }
    });
  }

  test('a quick stop while the paste helper warms waits for it instead of skipping', async () => {
    sequenceRead.mockRestore();
    let readyRequest: HelperRequest | undefined;
    const paste = nextHelper((request, helper) => {
      if (request.type === 'ready') readyRequest = request;
      else if (request.type === 'sequence') helper.reply(request, 'sequence', { sequence: clipboardSequence });
      else if (request.type === 'paste') helper.reply(request, 'prepared');
      else if (request.type === 'commit') helper.reply(request, 'pasted');
    });
    nextHelper();
    const warming = pasteHelper.warmUp();
    setSyntheticClipboard([], 'Synthetic baseline');
    void warming.catch(() => {});
    const delivery = pasteText('Synthetic dictation', {
      targetWindowHandle: 12345, restoreClipboard: false, restoreDelayMs: 750,
      deadlineUnixMs: Date.now() + 5000,
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(clipboardText).toBe('Synthetic baseline');
    expect(types(paste)).toEqual(['ready']);
    paste.reply(readyRequest!, 'ready');
    await warming;
    expect(await delivery).toEqual({ kind: 'pasted' });
    expect(types(paste)).toEqual(['ready', 'sequence', 'paste', 'commit']);
    expect(paste.requests[2]).toMatchObject({ targetWindowHandle: 12345, clipboardSequence });
  });

  test('a paste helper that stays cold keeps the copy fallback inside the delivery deadline', async () => {
    sequenceRead.mockRestore();
    const paste = nextHelper(() => {});
    nextHelper();
    void pasteHelper.warmUp().catch(() => {});
    const startedAt = Date.now();
    const { delivery } = await processFinalTranscription({
      frame: 'text', type: 'final', text: 'Synthetic dictation',
      confidence: 1, audio_duration: 1, transcription_time: 0.5,
    }, { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true, dictationMode: 'raw' },
    null, 'quick', 12345, undefined, { clipboardTimeoutMs: 1700 });
    expect(delivery).toEqual({ kind: 'skipped_unsafe', reason: 'paste_unavailable', copied: true });
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(types(paste)).toEqual(['ready']);
    expect(clipboardText).toBe('Synthetic dictation');
  });

  for (const duringDelivery of [false, true]) {
    test(`disabling auto-paste cancels a cold helper (delivery waiting: ${duringDelivery})`, async () => {
      sequenceRead.mockRestore();
      let readyRequest: HelperRequest | undefined;
      const paste = nextHelper((request, helper) => {
        if (request.type === 'ready') readyRequest = request;
        else if (request.type === 'sequence') helper.reply(request, 'sequence', { sequence: clipboardSequence });
        else if (request.type === 'paste') helper.reply(request, 'prepared');
        else if (request.type === 'commit') helper.reply(request, 'pasted');
      });
      nextHelper();
      void pasteHelper.warmUp().catch(() => {});
      setSyntheticClipboard([], 'Synthetic baseline');
      try {
        if (!duringDelivery) pasteHelper.setAutoPaste(false);
        const result = processFinalTranscription({
          frame: 'text', type: 'final', text: 'Synthetic dictation',
          confidence: 1, audio_duration: 1, transcription_time: 0.5,
        }, { ...DEFAULT_SETTINGS, autoPaste: true, autoCopy: true, dictationMode: 'raw' },
        null, 'quick', 12345, undefined, { clipboardTimeoutMs: 1700 });
        if (duringDelivery) {
          await settle();
          expect(clipboardText).toBe('Synthetic baseline');
          pasteHelper.setAutoPaste(false);
        }
        paste.reply(readyRequest!, 'ready');
        expect((await result).delivery).toEqual({ kind: 'skipped_unsafe', reason: 'paste_unavailable', copied: true });
        expect(paste.kill).toHaveBeenCalledTimes(1);
        expect(types(paste)).toEqual(['ready']);
        expect(clipboardText).toBe('Synthetic dictation');
      } finally {
        suspendClipboardPaste();
        pasteHelper.setAutoPaste(true);
      }
    });
  }

  test('disabling auto-paste releases the snapshot helper after an accepted capture settles', async () => {
    nextHelper();
    let pending: HelperRequest | undefined;
    const snapshot = nextHelper((request, helper) => {
      if (request.type === 'ready') helper.reply(request, 'ready');
      else pending = request;
    });
    const helper = new PersistentPasteHelper();
    try {
      await helper.warmUp();
      const capture = helper.foreground(KEYDOWN_TICK);
      helper.setAutoPaste(false);
      expect(snapshot.kill).not.toHaveBeenCalled();
      snapshot.reply(pending!, 'foreground', { handle: 23456 });
      expect(await capture).toEqual({ handle: 23456 });
      expect(snapshot.kill).toHaveBeenCalledTimes(1);
      snapshot.crash();
      await helper.warmUp();
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_absent' });
      expect(spawn).toHaveBeenCalledTimes(2);

      const reenabled = nextHelper();
      helper.setAutoPaste(true);
      await settle();
      expect(types(reenabled)).toEqual(['ready']);
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ handle: 12345 });
    } finally {
      helper.shutdown();
    }
  });

  test('auto-paste off lets accepted work use a ready paste helper without starting a replacement', async () => {
    const paste = nextHelper();
    nextHelper();
    const helper = new PersistentPasteHelper();
    try {
      await helper.warmUp();
      helper.setAutoPaste(false);
      const sequence = await helper.clipboardSequence();
      expect(sequence).toBe(clipboardSequence);

      paste.crash();
      expect(await helper.clipboardSequence()).toBeNull();
      await helper.warmUp();
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_absent' });
      await expect(helper.paste(12345, sequence!)).rejects.toThrow('Auto-paste disabled');
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      helper.shutdown();
    }
  });

  test('reports warming until both helpers answer, then ready, and off when disabled', async () => {
    let pasteReady: HelperRequest | undefined;
    const paste = nextHelper((request, helper) => {
      if (request.type === 'ready') pasteReady = request;
      else helper.reply(request, 'sequence', { sequence: clipboardSequence });
    });
    nextHelper();
    const helper = new PersistentPasteHelper(10_000);
    const reported: string[] = [];
    helper.onReadinessChange(readiness => reported.push(readiness));
    try {
      const warming = helper.warmUp();
      expect(helper.readiness()).toBe('warming');
      await settle();
      expect(helper.readiness()).toBe('warming');
      paste.reply(pasteReady!, 'ready');
      await warming;
      expect(helper.readiness()).toBe('ready');
      helper.setAutoPaste(false);
      expect(helper.readiness()).toBe('off');
      expect(reported).toEqual(['warming', 'ready', 'off']);
    } finally {
      helper.shutdown();
    }
  });

  test('resuming after a failed quit warms both helpers before the next hotkey', async () => {
    const helper = new PersistentPasteHelper();
    try {
      nextHelper();
      nextHelper();
      await helper.warmUp();
      helper.shutdown();
      expect(helper.readiness()).toBe('off');

      const paste = nextHelper();
      const snapshot = nextHelper();
      helper.resume();
      await settle();
      expect(types(paste)).toEqual(['ready']);
      expect(types(snapshot)).toEqual(['ready']);
      expect(helper.readiness()).toBe('ready');
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ handle: 12345 });
    } finally {
      helper.shutdown();
    }
  });

  test('reports degraded after the bounded wait, keeps hotkeys on the fallback, and recovers', async () => {
    let snapshotReady: HelperRequest | undefined;
    nextHelper();
    const snapshot = nextHelper(request => {
      if (request.type === 'ready') snapshotReady = request;
    });
    const helper = new PersistentPasteHelper(50);
    const reported: string[] = [];
    helper.onReadinessChange(readiness => reported.push(readiness));
    try {
      void helper.warmUp().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(helper.readiness()).toBe('degraded');
      expect(await helper.foreground(KEYDOWN_TICK)).toEqual({ reason: 'helper_unready' });
      expect(types(snapshot)).toEqual(['ready']);
      snapshot.reply(snapshotReady!, 'ready');
      await settle();
      expect(helper.readiness()).toBe('ready');
      expect(reported).toEqual(['warming', 'degraded', 'ready']);
    } finally {
      helper.shutdown();
    }
  });

  test('a helper that exits before ready degrades readiness at once', async () => {
    nextHelper();
    const snapshot = nextHelper(() => {});
    const helper = new PersistentPasteHelper(10_000);
    try {
      const warming = helper.warmUp();
      snapshot.crash();
      await expect(warming).rejects.toThrow();
      expect(helper.readiness()).toBe('degraded');
    } finally {
      helper.shutdown();
    }
  });

  test('a crashed ready helper reports warming while its replacement starts', async () => {
    nextHelper();
    const snapshot = nextHelper();
    let replacementReady: HelperRequest | undefined;
    nextHelper(request => {
      if (request.type === 'ready') replacementReady = request;
    });
    const helper = new PersistentPasteHelper(10_000);
    try {
      await helper.warmUp();
      expect(helper.readiness()).toBe('ready');
      snapshot.crash();
      expect(helper.readiness()).toBe('warming');
      expect(replacementReady).toBeDefined();
    } finally {
      helper.shutdown();
    }
  });
  test('switching auto-paste off during warm-up stops the snapshot helper without stranding callers', async () => {
    nextHelper();
    const snapshot = nextHelper(() => {});
    const helper = new PersistentPasteHelper();
    try {
      const warming = helper.warmUp();
      helper.setAutoPaste(false);
      await expect(warming).rejects.toThrow();
      expect(snapshot.kill).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      helper.shutdown();
    }
  });

  for (const outcome of ['late prepare', 'prepare timeout', 'newer operation'] as const) {
    test(`skips keyboard dispatch if ownership expires during preparation: ${outcome}`, async () => {
      const prepared = Promise.withResolvers<HelperRequest>();
      const child = await readyPasteHelper(request => {
        if (request.type === 'paste') prepared.resolve(request);
      });
      const paste = pasteText('Synthetic dictation', {
        targetWindowHandle: 12345,
        restoreClipboard: false, restoreDelayMs: 750,
      });
      const request = await Promise.race([prepared.promise, paste.then(() => {
        throw new Error('Paste finished before preparation');
      })]);

      let newerOperation: Promise<ClipboardCopyOutcome> | undefined;
      if (outcome === 'newer operation') newerOperation = copyToClipboard('New synthetic copy');
      else setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'New synthetic copy' })], 'New synthetic copy');
      if (outcome !== 'prepare timeout') child.reply(request, 'prepared');
      const delivery = await paste;
      if (outcome === 'newer operation') {
        expect(delivery).toEqual({ kind: 'skipped_unsafe', reason: 'superseded', copied: false });
      }
      await newerOperation;
      if (outcome === 'prepare timeout') child.reply(request, 'prepared');

      expect(child.requests.map(({ type }) => type)).toEqual(
        outcome === 'prepare timeout' ? ['ready', 'paste'] : ['ready', 'paste', 'discard']
      );
      expect(execFile).not.toHaveBeenCalled();
      expect(clipboardText).toBe('New synthetic copy');
    }, 10_000);
  }

  for (const when of ['prepared reply', 'authorization completion'] as const) {
    test(`cannot commit after the deadline even before the timer fires: ${when}`, async () => {
      const child = nextHelper(() => {});
      const helper = new PersistentPasteHelper();
      const authorization = Promise.withResolvers<void>();
      const clock = spyOn(performance, 'now').mockReturnValue(100);
      try {
        const paste = helper.paste(12345, clipboardSequence, undefined, async dispatch => {
          await authorization.promise;
          dispatch();
        });
        const request = child.requests[0]!;
        if (when === 'authorization completion') child.reply(request, 'prepared');
        clock.mockReturnValue(5101);
        if (when === 'prepared reply') child.reply(request, 'prepared');
        authorization.resolve();

        await expect(paste).rejects.toMatchObject({ allowFallback: true, message: 'Paste helper request timed out' });
        expect(child.requests.map(({ type }) => type)).toEqual(['paste']);
        expect(child.kill).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
        helper.shutdown();
      }
    });
  }

  for (const replaced of [false, true]) {
    test(`a failed authorization read keeps restoration guarded (clipboard replaced: ${replaced})`, async () => {
      setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'Previous synthetic copy' })], 'Previous synthetic copy');
      const child = await readyPasteHelper((request, helper) => {
        if (request.type !== 'paste') return;
        clipboardReadText.mockImplementationOnce(async () => { throw new Error('Synthetic authorization read failure'); });
        helper.reply(request, 'prepared');
      });
      await pasteText('Synthetic dictation', {
        targetWindowHandle: 12345, restoreClipboard: true, restoreDelayMs: 1,
      });
      expect(child.requests.map(({ type }) => type)).toEqual(['ready', 'paste', 'discard']);
      expect(execFile).not.toHaveBeenCalled();
      if (replaced) {
        setSyntheticClipboard([new MockClipboardItem({ 'text/plain': 'New synthetic copy' })], 'New synthetic copy');
      }
      await new Promise(resolve => setTimeout(resolve, 800));
      expect(clipboardText).toBe(replaced ? 'New synthetic copy' : 'Previous synthetic copy');
    });
  }

  for (const failure of ['exit', 'malformed JSON', 'timeout'] as const) {
    test(`does not retry after commit on ${failure}`, async () => {
      const child = nextHelper((request, helper) => {
        if (request.type === 'paste') helper.reply(request, 'prepared');
        else if (failure === 'exit') helper.crash();
        else if (failure === 'malformed JSON') helper.stdout.write('broken\n');
      });
      const error = { exit: 'exited', 'malformed JSON': 'Malformed', timeout: 'timed out' }[failure];
      await expect(simulatePaste(12345, clipboardSequence)).rejects.toThrow(error);
      expect(child.requests.map(({ type }) => type)).toEqual(['paste', 'commit']);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(execFile).not.toHaveBeenCalled();
    }, 10_000);
  }

  test('preserves native rejection without retrying or restarting a healthy helper', async () => {
    const child = nextHelper((request, helper) => {
      if (request.type === 'paste') helper.reply(request, 'prepared');
      else helper.reply(request, 'failed', { error: 'Target window no longer exists before paste.' });
    });
    await expect(simulatePaste(12345, clipboardSequence)).rejects.toThrow('Target window no longer exists');
    await expect(simulatePaste(23456, clipboardSequence)).rejects.toThrow('Target window no longer exists');
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('shutdown kills the helper, disallows fallback, and prevents a restart', async () => {
    const child = nextHelper(() => {});
    const helper = new PersistentPasteHelper();
    const pending = helper.paste(12345, clipboardSequence);
    helper.shutdown();
    await expect(pending).rejects.toMatchObject({ allowFallback: false });
    await expect(helper.foreground(KEYDOWN_TICK)).resolves.toEqual({ reason: 'helper_absent' });
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('records clipboard, settle, ownership and helper timings in order', async () => {
    const saved = process.env.MURMUR_PERF_TRACE;
    process.env.MURMUR_PERF_TRACE = '1';
    try {
      await readyPasteHelper();
      const traceId = perfTraceManager.startTrace()!.correlationId;
      perfTraceManager.mark(traceId, 'finalReceivedAt');
      await pasteText('Synthetic timing sample', {
        targetWindowHandle: 12345,
        restoreClipboard: false, restoreDelayMs: 750, perfTraceId: traceId,
      });
      const { main } = perfTraceManager.getRecentTraces().find(trace => trace.correlationId === traceId)!;
      const times = [
        main.finalReceivedAt, main.clipboardCompletedAt, main.pasteSettleCompletedAt,
        main.pasteOwnershipCheckedAt, main.pasteHelperRequestSentAt, main.pasteHelperResponseAt,
      ];
      const finiteTimes = times.filter((time): time is number => typeof time === 'number' && Number.isFinite(time));
      expect(finiteTimes).toHaveLength(times.length);
      expect(finiteTimes).toEqual(finiteTimes.toSorted((a, b) => a - b));
      expect(execFile).not.toHaveBeenCalled();
    } finally {
      perfTraceManager.clear();
      if (saved === undefined) delete process.env.MURMUR_PERF_TRACE;
      else process.env.MURMUR_PERF_TRACE = saved;
    }
  });

  test('before-quit cancels a running fallback and blocks another during the History flush', async () => {
    const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main/windows/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const listener = source.statements.find(node => node.getText(source).startsWith("app.on('before-quit'"))!;
    const script = ts.transpileModule(listener.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const flush = Promise.withResolvers<void>();
    const quit = Promise.withResolvers<void>();
    let beforeQuit!: (event: { preventDefault: () => void }) => void;
    const preventDefault = mock(() => {});
    runInNewContext(script, {
      app: { on: (_: string, handler: typeof beforeQuit) => { beforeQuit = handler; }, quit: quit.resolve },
      suspendClipboardPaste, resumeClipboardPaste,
      mainWindowForQuit: {
        isDestroyed: () => false, webContents: { isDestroyed: () => false, executeJavaScript: () => flush.promise },
      },
      isQuitting: false, quitFlushPending: false, QUIT_FLUSH_TIMEOUT_MS: 10_000,
      setTimeout, clearTimeout,
    });
    nextHelper((_request, child) => child.crash());
    const started = Promise.withResolvers<void>();
    const kill = mock(() => {});
    execFile.mockImplementationOnce((_command, _args, options, callback) => {
      const signal = typeof options === 'object' ? options.signal : undefined;
      if (!signal) throw new Error('Missing fallback shutdown signal');
      signal.addEventListener('abort', () => {
        kill();
        callback?.(new Error('Fallback aborted'));
      }, { once: true });
      started.resolve();
      return { kill };
    });

    try {
      const paste = simulatePaste(12345, clipboardSequence);
      await Promise.race([started.promise, paste.then(() => { throw new Error('Fallback did not start'); })]);
      beforeQuit({ preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledTimes(1);
      await paste;
      await simulatePaste(12345, clipboardSequence);
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
      flush.resolve();
      await quit.promise;
    } finally {
      flush.resolve();
      resumeClipboardPaste();
    }
  });
});

describe('buildSendInputScriptContent', () => {
  test('checks the same absolute deadline after focus restoration, immediately before sending Ctrl+V', () => {
    const oneShot = buildSendInputScriptContent();
    const persistent = buildPersistentPasteScript();
    for (const script of [oneShot, persistent]) {
      expect(script).toMatch(/WaitForForeground\(target\)[\s\S]*GetClipboardSequenceNumber\(\) != expectedClipboardSequence[\s\S]*GetForegroundWindow\(\) != new IntPtr\(targetWindowHandle\)[\s\S]*UtcNow\.ToUnixTimeMilliseconds\(\) >= deadlineUnixMs\) \{\s*return 22;\s*\}\s*uint sent = SendInput\(\(uint\)inputs.Length/);
    }
    expect(oneShot).toContain('::Paste($TargetWindowHandle, $ClipboardSequence, $DeadlineUnixMs)');
    expect(persistent).toContain('::Paste($paste.target, $paste.sequence, $paste.deadline)');
  });

  test('uses the full Windows INPUT union so SendInput has the correct x64 size', () => {
    const script = buildSendInputScriptContent();

    expect(script).toContain('public struct MOUSEINPUT');
    expect(script).toContain('public struct KEYBDINPUT');
    expect(script).toContain('public struct HARDWAREINPUT');
    expect(script).toContain('public static extern IntPtr GetForegroundWindow();');
    expect(script).toContain('public static extern bool IsIconic(IntPtr hWnd);');
    expect(script).toContain('[FieldOffset(0)] public MOUSEINPUT mi;');
    expect(script).toContain('[FieldOffset(0)] public KEYBDINPUT ki;');
    expect(script).toContain('[FieldOffset(0)] public HARDWAREINPUT hi;');
    expect(script).toContain('Marshal.SizeOf(typeof(INPUT))');
    expect(script).toContain('Target window is not foreground before paste.');
    expect(script).toContain('if (IsIconic(target))');
    expect(script).toContain('ShowWindow(target, SW_RESTORE);');
    expect(script).toContain('if (GetForegroundWindow() != target)');
    expect(script).toContain('private static bool WaitForForeground(IntPtr target)');
    expect(script).toContain('while (GetForegroundWindow() != target && waitedMs < FOREGROUND_WAIT_MS)');
    expect(script).toContain('if (!activationRequested && GetForegroundWindow() != target)');
  });
});
