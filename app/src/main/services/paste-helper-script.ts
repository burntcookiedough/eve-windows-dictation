// Both launch paths use the same native window checks and SendInput sequence.
const ADD_NATIVE_PASTE_TYPE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class NativePaste {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT {
    public uint type;
    public InputUnion U;
  }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT {
    public uint uMsg;
    public ushort wParamL;
    public ushort wParamH;
  }

  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const ushort VK_CONTROL = 0x11;
  public const ushort VK_MENU = 0x12;
  public const ushort VK_V = 0x56;
  public const int SW_RESTORE = 9;
  private const int FOREGROUND_WAIT_MS = 750;
  private const int FOREGROUND_POLL_MS = 25;

  private static void SendKey(ushort virtualKey, bool keyUp) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].U.ki.wVk = virtualKey;
    inputs[0].U.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
    uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != 1) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }

  private static void AllowForegroundSwitch() {
    SendKey(VK_MENU, false);
    SendKey(VK_MENU, true);
  }

  private static bool WaitForForeground(IntPtr target) {
    int waitedMs = 0;
    while (GetForegroundWindow() != target && waitedMs < FOREGROUND_WAIT_MS) {
      System.Threading.Thread.Sleep(FOREGROUND_POLL_MS);
      waitedMs += FOREGROUND_POLL_MS;
    }
    return GetForegroundWindow() == target;
  }

  public static void Paste(long targetWindowHandle) {
    if (targetWindowHandle != 0) {
      IntPtr target = new IntPtr(targetWindowHandle);
      if (IsWindow(target)) {
        // The overlay is non-focusable, so the original editor normally remains
        // foreground. Do not reactivate an already-active top-level window: some
        // Chromium editors lose their focused child control when that happens.
        if (GetForegroundWindow() != target) {
          AllowForegroundSwitch();
          if (IsIconic(target)) {
            ShowWindow(target, SW_RESTORE);
            System.Threading.Thread.Sleep(80);
          }
          bool activationRequested = SetForegroundWindow(target);
          if (!activationRequested && GetForegroundWindow() != target) {
            throw new InvalidOperationException("Could not focus target window before paste.");
          }
          if (!WaitForForeground(target)) {
            throw new InvalidOperationException("Target window is not foreground before paste.");
          }
        }
      } else {
        throw new InvalidOperationException("Target window no longer exists before paste.");
      }
    }

    INPUT[] inputs = new INPUT[4];
    inputs[0].type = INPUT_KEYBOARD; inputs[0].U.ki.wVk = VK_CONTROL;
    inputs[1].type = INPUT_KEYBOARD; inputs[1].U.ki.wVk = VK_V;
    inputs[2].type = INPUT_KEYBOARD; inputs[2].U.ki.wVk = VK_V; inputs[2].U.ki.dwFlags = KEYEVENTF_KEYUP;
    inputs[3].type = INPUT_KEYBOARD; inputs[3].U.ki.wVk = VK_CONTROL; inputs[3].U.ki.dwFlags = KEYEVENTF_KEYUP;
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
"@
`.trim();

export function buildSendInputScriptContent(): string {
  return `
param([Parameter(Mandatory=$true)][long]$TargetWindowHandle)

${ADD_NATIVE_PASTE_TYPE}
if ($TargetWindowHandle -le 0) { throw 'Invalid paste target window handle.' }
[NativePaste]::Paste($TargetWindowHandle)
`.trimStart();
}

export function buildPersistentPasteScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

${ADD_NATIVE_PASTE_TYPE}

$prepared = @{}
while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json -InputObject $line
  $id = [long]$request.id
  if ($request.type -eq 'discard') {
    $prepared.Remove($id)
    continue
  }
  $reply = @{ id = $id; type = $request.type }
  switch ($request.type) {
    'ready' {}
    'foreground' {
      $reply.handle = [NativePaste]::GetForegroundWindow().ToInt64()
    }
    'paste' {
      $target = [long]$request.targetWindowHandle
      if ($target -le 0) { throw 'Invalid paste target window handle.' }
      $prepared[$id] = $target
      $reply.type = 'prepared'
    }
    'commit' {
      if (!$prepared.ContainsKey($id)) { throw 'Paste was not prepared.' }
      $target = $prepared[$id]
      $prepared.Remove($id)
      try {
        [NativePaste]::Paste($target)
        $reply.type = 'pasted'
      } catch {
        $reply.type = 'failed'
        $reply.error = $_.Exception.GetBaseException().Message
      }
    }
    default { throw 'Unknown paste helper request.' }
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Compress))
}
`.trim();
}
