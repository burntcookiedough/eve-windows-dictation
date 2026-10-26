import { beforeEach, describe, expect, mock, test } from 'bun:test';

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

const execFile = mock((
  command: string,
  args: string[],
  options: { windowsHide?: boolean; timeout?: number } | ((error?: Error | null, stdout?: string) => void),
  callback?: (error?: Error | null, stdout?: string) => void
) => {
  const done = typeof options === 'function' ? options : callback;
  done?.(null, '12345');
  return { kill: mock(() => {}) };
});
const spawn = mock(() => {
  throw new Error('spawn is not used by clipboard tests');
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
  getForegroundWindowHandle,
  pasteText,
  readFromClipboard,
  simulatePaste,
} = await import('../src/main/services/clipboard.js');

describe('pasteText', () => {
  beforeEach(() => {
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

  test('rejects copy when Electron rejects the clipboard write', async () => {
    clipboardWriteText.mockImplementationOnce(async () => {
      throw new Error('synthetic write failure');
    });

    await expect(copyToClipboard('copied text')).rejects.toThrow('Could not write to clipboard.');
    expect(clipboardWrites).toEqual([]);
  });

  test('returns Electron clipboard text asynchronously', async () => {
    clipboardText = 'synthetic clipboard text';

    await expect(readFromClipboard()).resolves.toBe('synthetic clipboard text');
  });

  test('handles a rejected delayed restore write without exposing its error', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
    })).rejects.toThrow('synthetic read failure');

    expect(clipboardWrites).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  test('does not restore after a newer paste starts while an ownership read is pending', async () => {
    await pasteText('first text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
    });
    finishRead?.('first text');
    await secondPaste;

    expect(clipboardWrites).toEqual(['first text', 'second text']);
    expect(clipboardText).toBe('second text');
  });

  test('does not restore over a manual clipboard change observed by an async read', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
      targetWindowHandle: 12345,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('-TargetWindowHandle');
    expect(execFile.mock.calls[0]?.[1]).toContain('12345');
    expect(execFile.mock.calls[0]?.[2]).toEqual({ windowsHide: true, timeout: 5000 });
    expect(clipboardText).toBe('new text');

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(clipboardText).toBe('previous');
  });

  test('does not restore over a user clipboard change', async () => {
    await pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
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
      method: 'sendinput',
      targetWindowHandle: 12345,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPaste = pasteText('new text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
      targetWindowHandle: 11111,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondPaste = pasteText('second text', {
      restoreClipboard: false,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
      targetWindowHandle: 11111,
    });
    await new Promise((resolve) => setTimeout(resolve, 140));

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[1]).toContain('11111');
    const secondPaste = pasteText('second text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
      targetWindowHandle: 11111,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondPaste = pasteText('second text', {
      restoreClipboard: true,
      restoreDelayMs: 1,
      method: 'sendinput',
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

    await expect(simulatePaste('sendinput', 12345)).rejects.toThrow('target activation failed');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('does not fall back to VBScript when untargeted SendInput fails', async () => {
    execFile.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error('sendinput failed'));
      return { kill: mock(() => {}) };
    });

    await expect(simulatePaste('sendinput')).rejects.toThrow('sendinput failed');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('runs VBScript only when explicitly selected', async () => {
    await simulatePaste('vbscript');

    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0]?.[0]).toBe('cscript');
  });

  test('keeps transcript on clipboard when restoreClipboard is disabled', async () => {
    await pasteText('final transcript', {
      restoreClipboard: false,
      restoreDelayMs: 1,
      method: 'sendinput',
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
      method: 'sendinput',
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
      method: 'sendinput',
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
      method: 'sendinput',
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
      method: 'sendinput',
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
      method: 'sendinput',
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
      restoreClipboard: false, restoreDelayMs: 1, method: 'sendinput',
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
      restoreClipboard: true, restoreDelayMs: 1, method: 'sendinput',
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
      restoreClipboard: true, restoreDelayMs: 1, method: 'sendinput',
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
      restoreClipboard: true, restoreDelayMs: 1, method: 'sendinput',
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
      method: 'sendinput',
    })).rejects.toThrow('OS format cannot be read');

    expect(clipboardWrites).toEqual([]);
    expect(clipboardItemWrites).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe('getForegroundWindowHandle', () => {
  beforeEach(() => {
    execFile.mockClear();
  });

  test('hides PowerShell and applies a finite timeout', async () => {
    expect(await getForegroundWindowHandle()).toBe(12345);
    expect(execFile.mock.calls[0]?.[2]).toEqual({ windowsHide: true, timeout: 2000 });
  });

  test('resolves null when foreground-window capture times out', async () => {
    execFile.mockImplementationOnce((_command: string, _args: string[], _options: unknown, callback: (error?: Error | null) => void) => {
      callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
      return { kill: mock(() => {}) };
    });

    await expect(getForegroundWindowHandle()).resolves.toBeNull();
  });
});

describe('buildSendInputScriptContent', () => {
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
