import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TextFrameFinal } from '../src/shared/protocol.js';
import type { Settings, TranscriptionEntry } from '../src/shared/types.js';
import type { ClipboardCopyOutcome, ClipboardPasteOutcome } from '../src/main/services/clipboard.js';

const pasteText = mock(async (): Promise<ClipboardPasteOutcome> => ({ kind: 'pasted' }));
const copyToClipboard = mock(async (): Promise<ClipboardCopyOutcome> => ({ kind: 'copied' }));

mock.module('../src/main/services/clipboard.js', () => ({
  pasteText,
  copyToClipboard,
}));

const { processFinalTranscription } = await import('../src/main/services/pipeline.js');

const settings: Settings = {
  hotkey: { keycode: 3675, ctrlKey: true, altKey: false, shiftKey: false, metaKey: false },
  longHotkey: { keycode: 3675, ctrlKey: true, altKey: false, shiftKey: true, metaKey: false },
  holdToTalk: true,
  autoCopy: true,
  autoPaste: true,
  restoreClipboardAfterPaste: true,
  clipboardRestoreDelayMs: 250,
  pasteMethod: 'sendinput',
  silenceTimeout: 15,
  appendPeriod: false,
  appendSpace: false,
  dictationMode: 'clean_prompt',
  selectedDeviceId: 'default',
  launchOnBoot: false,
  startMinimized: false,
  serverAutoStart: true,
  hotwordsEnabled: false,
  hotwordsCsl: '',
};

const frame: TextFrameFinal = {
  frame: 'text',
  type: 'final',
  text: 'hello from eve',
  confidence: 0.95,
  transcription_time: 1.2,
  audio_duration: 3,
};

describe('processFinalTranscription', () => {
  beforeEach(() => {
    pasteText.mockClear();
    copyToClipboard.mockClear();
  });

  test('auto-pastes processed text with the configured paste options', async () => {
    const saved: TranscriptionEntry[] = [];

    const result = await processFinalTranscription(
      frame,
      settings,
      { save: (entry: TranscriptionEntry) => saved.push(entry) },
      'quick',
      12345
    );

    expect(pasteText).toHaveBeenCalledTimes(1);
    expect(pasteText).toHaveBeenCalledWith('Hello from eve.', {
      restoreClipboard: false,
      restoreDelayMs: 250,
      targetWindowHandle: 12345,
      snapshotFailure: undefined,
      signal: expect.any(AbortSignal),
      deadlineUnixMs: expect.any(Number),
      onDispatch: expect.any(Function),
    });
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('Hello from eve.');
    expect(saved[0]?.wordCount).toBe(3);
    expect(result.entryWithGroup?.dateGroup).toBe('Today');
    expect(result.delivery).toEqual({ kind: 'pasted' });
  });

  test('falls back to auto-copy when auto-paste is disabled', async () => {
    const saved: TranscriptionEntry[] = [];
    const result = await processFinalTranscription(
      frame,
      { ...settings, autoPaste: false, autoCopy: true },
      { save: entry => saved.push(entry) },
      'quick'
    );

    expect(pasteText).not.toHaveBeenCalled();
    expect(copyToClipboard).toHaveBeenCalledWith('Hello from eve.', undefined, expect.any(AbortSignal), expect.any(Number));
    expect(result.delivery).toEqual({ kind: 'copied' });
    expect(saved).toHaveLength(1);
  });

  test('keeps auto-copy dispatch pending until the clipboard write resolves', async () => {
    let finishCopy: ((outcome: ClipboardCopyOutcome) => void) | undefined;
    copyToClipboard.mockImplementationOnce(() => new Promise((resolve) => {
      finishCopy = resolve;
    }));

    let completed = false;
    const dispatch = processFinalTranscription(
      frame,
      { ...settings, autoPaste: false, autoCopy: true },
      null,
      'quick'
    ).then(() => { completed = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(completed).toBe(false);
    finishCopy?.({ kind: 'copied' });
    await dispatch;
    expect(completed).toBe(true);
  });

  test('preserves the paste failure without a second clipboard write', async () => {
    const failure = { kind: 'failed', clipboardWrite: 'written', dispatch: 'uncertain' } as const;
    pasteText.mockResolvedValueOnce(failure);

    const saved: TranscriptionEntry[] = [];
    const result = await processFinalTranscription(
      frame,
      { ...settings, autoPaste: true, autoCopy: true },
      { save: entry => saved.push(entry) },
      'quick',
      12345
    );

    expect(pasteText).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(result.delivery).toEqual(failure);
    expect(saved).toHaveLength(1);
  });

  test('honors clipboard restore only when auto-copy is disabled', async () => {
    await processFinalTranscription(
      frame,
      { ...settings, autoPaste: true, autoCopy: false, restoreClipboardAfterPaste: true },
      null,
      'quick',
      12345
    );

    expect(pasteText).toHaveBeenCalledWith('Hello from eve.', {
      restoreClipboard: true,
      restoreDelayMs: 250,
      targetWindowHandle: 12345,
      snapshotFailure: undefined,
      signal: expect.any(AbortSignal),
      deadlineUnixMs: expect.any(Number),
      onDispatch: expect.any(Function),
    });
  });

  test('retains dictated text in History when baseline protection aborts paste without auto-copy', async () => {
    const saved: TranscriptionEntry[] = [];
    const failure = { kind: 'failed', clipboardWrite: 'not_attempted', dispatch: 'not_attempted' } as const;
    pasteText.mockResolvedValueOnce(failure);
    const result = await processFinalTranscription(
      frame,
      { ...settings, autoPaste: true, autoCopy: false, restoreClipboardAfterPaste: true },
      { save: (entry: TranscriptionEntry) => saved.push(entry) },
      'quick',
      12345,
    );
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toBe('Hello from eve.');
    expect(result.entryWithGroup?.text).toBe(saved[0]?.text);
    expect(result.delivery).toEqual(failure);
  });

  test.each([false, true])('saves History after skipping a missing target (auto-copy: %s)', async (autoCopy) => {
    const save = mock(() => {});
    pasteText.mockResolvedValueOnce({ kind: 'skipped_unsafe', reason: 'no_target', copied: false });

    const result = await processFinalTranscription(frame, { ...settings, autoCopy }, { save }, 'quick', null);

    expect(result.delivery).toEqual({ kind: 'skipped_unsafe', reason: 'no_target', copied: autoCopy });
    expect(copyToClipboard).toHaveBeenCalledTimes(autoCopy ? 1 : 0);
    expect(save).toHaveBeenCalledWith(result.entry);
  });

  test.each([
    { kind: 'skipped_unsafe', reason: 'clipboard_changed', copied: false },
    { kind: 'skipped_unsafe', reason: 'foreground_changed', copied: true },
    { kind: 'skipped_unsafe', reason: 'superseded', copied: false },
  ] as const)('saves History without rewriting the clipboard after %j', async (delivery) => {
    const save = mock(() => {});
    pasteText.mockResolvedValueOnce(delivery);

    const result = await processFinalTranscription(frame, settings, { save }, 'quick', 12345);

    expect(result.delivery).toEqual(delivery);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(result.entry);
  });

  test('reports a copy failure and still saves History', async () => {
    copyToClipboard.mockResolvedValueOnce({ kind: 'failed' });
    const save = mock(() => {});

    const result = await processFinalTranscription(frame, { ...settings, autoPaste: false }, { save });

    expect(result.delivery).toEqual({ kind: 'failed' });
    expect(save).toHaveBeenCalledWith(result.entry);
  });

  test('reports when History is the only successful output requested', async () => {
    const save = mock(() => {});
    const result = await processFinalTranscription(frame, { ...settings, autoPaste: false, autoCopy: false }, { save });

    expect(result.delivery).toEqual({ kind: 'saved' });
    expect(save).toHaveBeenCalledWith(result.entry);
    expect(result.entryWithGroup?.id).toBe(result.entry.id);
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(pasteText).not.toHaveBeenCalled();
  });

  test('reports a History failure separately from a paste that was sent', async () => {
    const result = await processFinalTranscription(frame, settings, { save: () => { throw new Error('Synthetic disk failure'); } }, 'quick', 12345);

    expect(result.delivery).toEqual({ kind: 'pasted' });
    expect(result.entryWithGroup).toBeNull();
    expect(result.historyFailed).toBe(true);
  });
});
