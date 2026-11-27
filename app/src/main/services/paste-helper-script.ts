export const PasteAbortCode = {
  ClipboardChanged: 20,
  ForegroundChanged: 21,
  Expired: 22,
} as const;

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
  [DllImport("user32.dll")]
  public static extern uint GetClipboardSequenceNumber();

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

  public static int Paste(long targetWindowHandle, uint expectedClipboardSequence, long deadlineUnixMs) {
    if (targetWindowHandle != 0) {
      IntPtr target = new IntPtr(targetWindowHandle);
      if (IsWindow(target)) {
        // The overlay is non-focusable, so the original editor normally remains
        // foreground. Do not reactivate an already-active top-level window: some
        // Chromium editors lose their focused child control when that happens.
        if (GetForegroundWindow() != target) {
          if (expectedClipboardSequence == 0 || GetClipboardSequenceNumber() != expectedClipboardSequence) {
            return ${PasteAbortCode.ClipboardChanged};
          }
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
    int inputSize = Marshal.SizeOf(typeof(INPUT));
    if (expectedClipboardSequence == 0 || GetClipboardSequenceNumber() != expectedClipboardSequence) {
      return ${PasteAbortCode.ClipboardChanged};
    }
    if (GetForegroundWindow() != new IntPtr(targetWindowHandle)) {
      return ${PasteAbortCode.ForegroundChanged};
    }
    if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= deadlineUnixMs) {
      return ${PasteAbortCode.Expired};
    }
    uint sent = SendInput((uint)inputs.Length, inputs, inputSize);
    if (sent != inputs.Length) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    return 0;
  }
}
"@
`.trim();

export function buildSendInputScriptContent(): string {
  return `
param(
  [Parameter(Mandatory=$true)][long]$TargetWindowHandle,
  [Parameter(Mandatory=$true)][uint32]$ClipboardSequence,
  [Parameter(Mandatory=$true)][long]$DeadlineUnixMs
)

$ErrorActionPreference = 'Stop'
${ADD_NATIVE_PASTE_TYPE}
if ($TargetWindowHandle -le 0) { throw 'Invalid paste target window handle.' }
exit ([NativePaste]::Paste($TargetWindowHandle, $ClipboardSequence, $DeadlineUnixMs))
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
    'sequence' {
      $reply.sequence = [NativePaste]::GetClipboardSequenceNumber()
    }
    'paste' {
      $target = [long]$request.targetWindowHandle
      if ($target -le 0) { throw 'Invalid paste target window handle.' }
      $prepared[$id] = @{ target = $target; sequence = [uint32]$request.clipboardSequence; deadline = [long]$request.deadlineUnixMs }
      $reply.type = 'prepared'
    }
    'commit' {
      if (!$prepared.ContainsKey($id)) { throw 'Paste was not prepared.' }
      $paste = $prepared[$id]
      $prepared.Remove($id)
      try {
        $code = [NativePaste]::Paste($paste.target, $paste.sequence, $paste.deadline)
        if ($code -eq 0) {
          $reply.type = 'pasted'
        } else {
          $reply.type = 'aborted'
          $reply.code = $code
        }
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

// The snapshot helper never samples "whatever is foreground now". A background
// thread records every EVENT_SYSTEM_FOREGROUND, and each capture names the
// hotkey keydown by its KBDLLHOOKSTRUCT tick. Both use the GetTickCount clock,
// so the helper returns the window only when no foreground change happened at
// or after that keydown; otherwise it rejects and Eve uses the copy and History
// fallback. The C# avoids "$" because it sits in a PowerShell here-string.
export const FOREGROUND_TRACKER_TYPE = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;

public sealed class ForegroundCapture {
  public long Handle;
  public string Reason;
}

public static class ForegroundTracker {
  public const ulong MaxKeydownAgeMs = 2000;
  private const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  // A private event in the OEM range marks how far the hook has drained.
  private const uint EVENT_TRACKER_SYNC = 0x01EE;
  private const uint EVENT_OEM_DEFINED_END = 0x01FF;
  private const uint WINEVENT_OUTOFCONTEXT = 0;
  private const uint PM_NOREMOVE = 0;
  private const uint WS_POPUP = 0x80000000;
  private const uint WS_EX_TOOLWINDOW = 0x00000080;
  private const uint WS_EX_NOACTIVATE = 0x08000000;

  private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint thread, uint eventTime);

  [StructLayout(LayoutKind.Sequential)]
  private struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x;
    public int y;
  }

  [DllImport("user32.dll")]
  private static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr module, WinEventProc callback, uint processId, uint threadId, uint flags);
  [DllImport("user32.dll")]
  private static extern void NotifyWinEvent(uint eventType, IntPtr hwnd, int idObject, int idChild);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr CreateWindowEx(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
  [DllImport("user32.dll")]
  private static extern int GetMessage(out MSG message, IntPtr hwnd, uint filterMin, uint filterMax);
  [DllImport("user32.dll")]
  private static extern bool PeekMessage(out MSG message, IntPtr hwnd, uint filterMin, uint filterMax, uint remove);
  [DllImport("user32.dll")]
  private static extern bool TranslateMessage(ref MSG message);
  [DllImport("user32.dll")]
  private static extern IntPtr DispatchMessage(ref MSG message);
  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")]
  private static extern ulong GetTickCount64();
  [DllImport("kernel32.dll")]
  private static extern uint GetCurrentThreadId();

  private static readonly object Gate = new object();
  private static readonly RandomNumberGenerator MarkerRandom = RandomNumberGenerator.Create();
  private static WinEventProc callback;
  private static IntPtr trackerWindow;
  private static uint hookThreadId;
  private static ulong installedAt;
  private static ulong lastChangeAt;
  private static int syncObjectId;
  private static int syncChildId;
  private static bool syncCompleted;

  // Read-only views for diagnostics and the native ordering tests.
  public static long TrackerWindow { get { lock (Gate) { return trackerWindow.ToInt64(); } } }
  public static uint HookThreadId { get { lock (Gate) { return hookThreadId; } } }

  // Places a past GetTickCount value on the 64-bit clock that produced it.
  public static ulong ExpandTick(uint tick, ulong now) {
    uint age = unchecked((uint)now - tick);
    return age <= now ? now - age : 0;
  }

  // A change is never recorded earlier than it happened. An implausible event
  // time is replaced by the delivery time, which can only cause a rejection.
  public static ulong EventTime(uint eventTick, ulong now) {
    ulong at = ExpandTick(eventTick, now);
    return now - at > MaxKeydownAgeMs ? now : at;
  }

  // Null means the window sampled now is the one that was foreground at the keydown.
  public static string Judge(ulong keydownAt, ulong now, ulong installed, ulong lastChange, long before, long after) {
    if (keydownAt > now || now - keydownAt > MaxKeydownAgeMs) return "keydown_unverified";
    if (installed == 0 || installed >= keydownAt) return "tracker_unready";
    // The tick is coarse, so a change in the keydown's own tick counts as later.
    if (lastChange >= keydownAt || before != after) return "focus_changed";
    return null;
  }

  public static bool Start(int timeoutMs) {
    ManualResetEvent started = new ManualResetEvent(false);
    Thread thread = new Thread(delegate() { Run(started); });
    thread.IsBackground = true;
    thread.Start();
    started.WaitOne(timeoutMs);
    lock (Gate) { return installedAt != 0; }
  }

  private static void Run(ManualResetEvent started) {
    MSG message;
    PeekMessage(out message, IntPtr.Zero, 0, 0, PM_NOREMOVE);
    // A hidden, never-activated window that only names this helper's sync events.
    IntPtr window = CreateWindowEx(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, "STATIC", "", WS_POPUP, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    callback = OnEvent;
    // One hook delivers foreground changes and sync markers through the same
    // per-thread event queue, so a marker is never seen before an earlier change.
    IntPtr hook = window == IntPtr.Zero ? IntPtr.Zero
      : SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_OEM_DEFINED_END, IntPtr.Zero, callback, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (hook != IntPtr.Zero) {
      lock (Gate) {
        trackerWindow = window;
        hookThreadId = GetCurrentThreadId();
        installedAt = GetTickCount64();
      }
    }
    started.Set();
    if (hook == IntPtr.Zero) return;
    while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref message);
      DispatchMessage(ref message);
    }
    // A helper without a working tracker exits so Eve can start a replacement.
    Environment.Exit(3);
  }

  private static void OnEvent(IntPtr hook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint eventThread, uint eventTime) {
    if (eventType == EVENT_SYSTEM_FOREGROUND) {
      ulong at = EventTime(eventTime, GetTickCount64());
      lock (Gate) {
        if (at > lastChangeAt) lastChangeAt = at;
      }
    } else if (eventType == EVENT_TRACKER_SYNC) {
      lock (Gate) {
        // Windows attributes window events to the owner thread, including when
        // NotifyWinEvent is called elsewhere. Match the per-capture IDs as well.
        if (eventThread == hookThreadId && hwnd == trackerWindow && idObject == syncObjectId && idChild == syncChildId) {
          syncCompleted = true;
          Monitor.PulseAll(Gate);
        }
      }
    }
  }

  public static ForegroundCapture Capture(uint keydownTick, int waitMs) {
    ForegroundCapture result = new ForegroundCapture();
    ulong now = GetTickCount64();
    ulong keydownAt = ExpandTick(keydownTick, now);
    long before = GetForegroundWindow().ToInt64();
    byte[] nonce = new byte[8];
    MarkerRandom.GetBytes(nonce);
    // Positive custom object and child IDs, with neither ID equal to zero.
    int objectId = (BitConverter.ToInt32(nonce, 0) & int.MaxValue) | 1;
    int childId = (BitConverter.ToInt32(nonce, 4) & int.MaxValue) | 1;
    IntPtr window;
    lock (Gate) {
      syncObjectId = objectId;
      syncChildId = childId;
      syncCompleted = false;
      window = trackerWindow;
    }
    if (window == IntPtr.Zero) {
      result.Reason = "tracker_unavailable";
      return result;
    }
    // Every change that completed before the read above is already queued to
    // the hook thread, ahead of this marker.
    NotifyWinEvent(EVENT_TRACKER_SYNC, window, objectId, childId);
    ulong installed;
    ulong lastChange;
    DateTime until = DateTime.UtcNow.AddMilliseconds(Math.Max(0, waitMs));
    lock (Gate) {
      while (!syncCompleted) {
        int remaining = (int)(until - DateTime.UtcNow).TotalMilliseconds;
        if (remaining <= 0) {
          result.Reason = "tracker_unavailable";
          return result;
        }
        Monitor.Wait(Gate, remaining);
      }
      installed = installedAt;
    }
    long after = GetForegroundWindow().ToInt64();
    lock (Gate) { lastChange = lastChangeAt; }
    result.Reason = Judge(keydownAt, now, installed, lastChange, before, after);
    if (result.Reason == null) result.Handle = before;
    return result;
  }
}
"@
`.trim();

export function buildForegroundSnapshotScript(): string {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

${FOREGROUND_TRACKER_TYPE}

# Ready means the foreground hook is installed, so later keydowns can be judged.
if (-not [ForegroundTracker]::Start(2000)) { throw 'Foreground tracker unavailable.' }

while ($null -ne ($line = [Console]::ReadLine())) {
  $request = ConvertFrom-Json -InputObject $line
  $reply = @{ id = [long]$request.id; type = $request.type }
  switch ($request.type) {
    'ready' {}
    'foreground' {
      $remaining = [long]$request.deadlineUnixMs - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
      if ($remaining -le 0) {
        $reply.type = 'expired'
      } else {
        $capture = [ForegroundTracker]::Capture([uint32]$request.keydownTick, [int]$remaining)
        if ($null -ne $capture.Reason) {
          $reply.type = 'rejected'
          $reply.reason = $capture.Reason
        } elseif ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge [long]$request.deadlineUnixMs) {
          $reply.type = 'expired'
        } else {
          $reply.handle = $capture.Handle
        }
      }
    }
    default { throw 'Unknown foreground snapshot request.' }
  }
  [Console]::WriteLine((ConvertTo-Json -InputObject $reply -Compress))
}
`.trim();
}
