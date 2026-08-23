import { beforeEach, describe, expect, mock, test } from 'bun:test';

let clipboardText = '';
let clipboardFormats: string[] = [];
let clipboardWrites: string[] = [];
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

mock.module('electron', () => ({
  app: {
    getPath: () => process.env.TEMP ?? '.',
  },
  clipboard: {
    readText: () => clipboardText,
    availableFormats: () => [...clipboardFormats],
    writeText: (text: string) => {
      clipboardText = text;
      clipboardFormats = ['text/plain'];
      clipboardWrites.push(text);
    },
  },
}));

mock.module('child_process', () => ({
  execFile,
}));

const { buildSendInputScriptContent, getForegroundWindowHandle, pasteText, simulatePaste } = await import('../src/main/services/clipboard.js');

describe('pasteText', () => {
  beforeEach(() => {
    clipboardText = 'previous';
    clipboardFormats = ['text/plain'];
    clipboardWrites = [];
    execFile.mockClear();
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

    expect(clipboardText).toBe('new text');
    expect(clipboardWrites).not.toContain('previous');
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
