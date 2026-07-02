import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { TextFrameFinal } from '../src/shared/protocol.js';
import type { Settings, TranscriptionEntry } from '../src/shared/types.js';

const pasteText = mock(async () => {});
const copyToClipboard = mock(() => {});

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
  serverUrl: 'ws://localhost:51717/transcribe',
  appendPeriod: false,
  appendSpace: false,
  dictationMode: 'clean_prompt',
  selectedDeviceId: 'default',
  launchOnBoot: false,
  startMinimized: false,
  serverAutoStart: true,
  useExternalServer: false,
  hotwordsEnabled: false,
  hotwordsCsl: '',
};

const frame: TextFrameFinal = {
  frame: 'text',
  type: 'final',
  text: 'hello from murmur',
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
    expect(pasteText).toHaveBeenCalledWith('Hello from murmur.', {
      restoreClipboard: false,
      restoreDelayMs: 250,
      method: 'sendinput',
      targetWindowHandle: 12345,
    });
    expect(copyToClipboard).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    expect(saved[0]?.text).toBe('Hello from murmur.');
    expect(saved[0]?.wordCount).toBe(3);
    expect(result.entryWithGroup.dateGroup).toBe('Today');
  });

  test('falls back to auto-copy when auto-paste is disabled', async () => {
    await processFinalTranscription(
      frame,
      { ...settings, autoPaste: false, autoCopy: true },
      null,
      'quick'
    );

    expect(pasteText).not.toHaveBeenCalled();
    expect(copyToClipboard).toHaveBeenCalledWith('Hello from murmur.');
  });

  test('copies text when auto-paste fails and auto-copy is enabled', async () => {
    pasteText.mockImplementationOnce(async () => {
      throw new Error('paste failed');
    });

    await processFinalTranscription(
      frame,
      { ...settings, autoPaste: true, autoCopy: true },
      null,
      'quick',
      12345
    );

    expect(pasteText).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith('Hello from murmur.');
  });

  test('honors clipboard restore only when auto-copy is disabled', async () => {
    await processFinalTranscription(
      frame,
      { ...settings, autoPaste: true, autoCopy: false, restoreClipboardAfterPaste: true },
      null,
      'quick',
      12345
    );

    expect(pasteText).toHaveBeenCalledWith('Hello from murmur.', {
      restoreClipboard: true,
      restoreDelayMs: 250,
      method: 'sendinput',
      targetWindowHandle: 12345,
    });
  });
});
