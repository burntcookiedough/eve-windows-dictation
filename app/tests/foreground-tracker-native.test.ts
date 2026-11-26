import { expect, test } from 'bun:test';
import { buildForegroundSnapshotScript, FOREGROUND_TRACKER_TYPE } from '../src/main/services/paste-helper-script.js';

// These tests compile the shipped C# with Windows PowerShell. They install at most a
// passive foreground hook and never change focus, send input or touch the clipboard.
const windows = process.platform === 'win32';

async function runPowerShell(script: string): Promise<string> {
  const child = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return stdout.trim();
}

test.skipIf(!windows)('the foreground tracker proves the keydown window or rejects the capture', async () => {
  const output = await runPowerShell(`
$ErrorActionPreference = 'Stop'
${FOREGROUND_TRACKER_TYPE}
$t = [ForegroundTracker]
$r = [ordered]@{
  expandSimple = $t::ExpandTick([uint32]1000, [uint64]5000)
  expandAcrossWrap = $t::ExpandTick([uint32]4294967290, [uint64]4294967306)
  expandFuture = $t::ExpandTick([uint32]6000, [uint64]5000)
  eventOnTime = $t::EventTime([uint32]4990, [uint64]5000)
  eventFromFuture = $t::EventTime([uint32]6000, [uint64]5000)
  eventImplausiblyOld = $t::EventTime([uint32]1000, [uint64]5000)
  accepted = $t::Judge([uint64]10000, [uint64]10010, [uint64]9000, [uint64]9999, [long]5, [long]5)
  changedSameTick = $t::Judge([uint64]10000, [uint64]10010, [uint64]9000, [uint64]10000, [long]5, [long]5)
  changedAfterKeydown = $t::Judge([uint64]10000, [uint64]10010, [uint64]9000, [uint64]10005, [long]5, [long]5)
  movedDuringSample = $t::Judge([uint64]10000, [uint64]10010, [uint64]9000, [uint64]9000, [long]5, [long]6)
  hookAfterKeydown = $t::Judge([uint64]10000, [uint64]10010, [uint64]10000, [uint64]0, [long]5, [long]5)
  hookMissing = $t::Judge([uint64]10000, [uint64]10010, [uint64]0, [uint64]0, [long]5, [long]5)
  staleKeydown = $t::Judge([uint64]10000, [uint64]12001, [uint64]9000, [uint64]0, [long]5, [long]5)
  futureKeydown = $t::Judge([uint64]10011, [uint64]10010, [uint64]9000, [uint64]0, [long]5, [long]5)
}
[Console]::WriteLine((ConvertTo-Json -InputObject $r -Compress))
`);
  expect(JSON.parse(output)).toEqual({
    expandSimple: 1000,
    expandAcrossWrap: 4294967290,
    expandFuture: 0,
    eventOnTime: 4990,
    eventFromFuture: 5000,
    eventImplausiblyOld: 5000,
    accepted: null,
    changedSameTick: 'focus_changed',
    changedAfterKeydown: 'focus_changed',
    movedDuringSample: 'focus_changed',
    hookAfterKeydown: 'tracker_unready',
    hookMissing: 'tracker_unready',
    staleKeydown: 'keydown_unverified',
    futureKeydown: 'keydown_unverified',
  });
}, 60_000);

test.skipIf(!windows)('the shipped snapshot helper answers keydown-bound requests', async () => {
  const { dlopen, FFIType } = await import('bun:ffi');
  const kernel32 = dlopen('kernel32.dll', { GetTickCount64: { args: [], returns: FFIType.u64 } });
  const tick = () => Number(BigInt(kernel32.symbols.GetTickCount64()) % 0x1_0000_0000n);
  const child = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(buildForegroundSnapshotScript(), 'utf16le').toString('base64')],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const reader = child.stdout.getReader();
  let buffered = '';
  const ask = async (request: Record<string, unknown>) => {
    child.stdin.write(JSON.stringify(request) + '\n');
    await child.stdin.flush();
    while (!buffered.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Snapshot helper exited');
      buffered += new TextDecoder().decode(value);
    }
    const newline = buffered.indexOf('\n');
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    return JSON.parse(line) as Record<string, unknown>;
  };
  try {
    expect(await ask({ id: 1, type: 'ready' })).toEqual({ id: 1, type: 'ready' });
    await Bun.sleep(40);
    const keydown = tick();
    const sample = await ask({ id: 2, type: 'foreground', keydownTick: keydown, deadlineUnixMs: Date.now() + 2000 });
    expect(sample).toMatchObject({ id: 2, type: 'foreground', handle: expect.any(Number) });
    const staleKeydown = (tick() + 0x1_0000_0000 - 5000) % 0x1_0000_0000;
    expect(await ask({ id: 3, type: 'foreground', keydownTick: staleKeydown, deadlineUnixMs: Date.now() + 2000 }))
      .toEqual({ id: 3, type: 'rejected', reason: 'keydown_unverified' });
    // .NET Framework's UtcNow advances in ~16 ms steps, so use a clearly past deadline.
    expect(await ask({ id: 4, type: 'foreground', keydownTick: tick(), deadlineUnixMs: Date.now() - 1000 }))
      .toEqual({ id: 4, type: 'expired' });
    child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    kernel32.close();
  }
}, 60_000);

// The test build pauses the real hook inside a callback, outside the tracker lock.
const ORDERING_PROBE = `
public static class OrderingProbe {
  private const uint PauseEvent = 0x01EF;
  private static readonly ManualResetEvent Paused = new ManualResetEvent(false);
  private static readonly ManualResetEvent Release = new ManualResetEvent(false);
  [DllImport("kernel32.dll")] private static extern ulong GetTickCount64();
  [DllImport("user32.dll")] private static extern void NotifyWinEvent(uint eventType, IntPtr hwnd, int idObject, int idChild);

  public static uint Now() { return (uint)GetTickCount64(); }

  public static void Stall(long hwnd) {
    Paused.Reset();
    Release.Reset();
    NotifyWinEvent(PauseEvent, new IntPtr(hwnd), 0, 0);
    if (!Paused.WaitOne(5000)) throw new InvalidOperationException("Hook did not pause.");
  }

  public static bool PauseHook(uint eventType, IntPtr hwnd) {
    if (eventType != PauseEvent || hwnd.ToInt64() != ForegroundTracker.TrackerWindow) return false;
    Paused.Set();
    if (!Release.WaitOne(15000)) Paused.Reset();
    return true;
  }

  public static void MarkerQueued() {
    if (!Paused.WaitOne(0)) throw new InvalidOperationException("Hook was released before the marker was queued.");
    Release.Set();
  }

  // A foreground notification that changes no focus. The tracker cannot tell it
  // apart from a real switch, which is what this test needs.
  public static void RaiseForeground(long hwnd) { NotifyWinEvent(3, new IntPtr(hwnd), 0, 0); }
}
`;

test.skipIf(!windows)('a foreground change queued behind a stalled hook is seen before the capture decides', async () => {
  const { dlopen, FFIType } = await import('bun:ffi');
  const user32 = dlopen('user32.dll', {
    NotifyWinEvent: { args: [FFIType.u32, FFIType.i64, FFIType.i32, FFIType.i32], returns: FFIType.void },
  });
  const kernel32 = dlopen('kernel32.dll', { GetTickCount64: { args: [], returns: FFIType.u64 } });
  // Keep the shipping marker and foreground event on their real WinEvent queue.
  const instrumentedTracker = FOREGROUND_TRACKER_TYPE
    .replace('    if (eventType == EVENT_SYSTEM_FOREGROUND) {',
      '    if (OrderingProbe.PauseHook(eventType, hwnd)) return;\n    if (eventType == EVENT_SYSTEM_FOREGROUND) {')
    .replace('    ulong installed;', '    OrderingProbe.MarkerQueued();\n    ulong installed;')
    .replace('\n"@', `${ORDERING_PROBE}\n"@`);
  const script = `
$ErrorActionPreference = 'Stop'
${instrumentedTracker}
if (-not [ForegroundTracker]::Start(5000)) { throw 'Foreground tracker unavailable.' }
$window = [ForegroundTracker]::TrackerWindow
$r = [ordered]@{}
Start-Sleep -Milliseconds 50

# Control: a stalled hook delays the sync marker but proves no change.
[OrderingProbe]::Stall($window)
$capture = [ForegroundTracker]::Capture([OrderingProbe]::Now(), 5000)
$r.controlReason = $capture.Reason

# A change after the keydown waits in the queue ahead of the marker.
[OrderingProbe]::Stall($window)
$keydown = [OrderingProbe]::Now()
[OrderingProbe]::RaiseForeground($window)
$capture = [ForegroundTracker]::Capture($keydown, 5000)
$r.inProcessReason = $capture.Reason
$r.inProcessHandle = $capture.Handle

# The same, with the change raised by another process.
Start-Sleep -Milliseconds 50
[OrderingProbe]::Stall($window)
[Console]::WriteLine('raise ' + $window)
$keydown = [uint32]::Parse([Console]::ReadLine())
$capture = [ForegroundTracker]::Capture($keydown, 5000)
$r.crossProcessReason = $capture.Reason
$r.crossProcessHandle = $capture.Handle
[Console]::WriteLine((ConvertTo-Json -InputObject $r -Compress))
`;
  const child = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const watchdog = setTimeout(() => child.kill(), 45_000);
  const reader = child.stdout.getReader();
  let buffered = '';
  const nextLine = async () => {
    while (!buffered.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`Ordering probe exited: ${await new Response(child.stderr).text()}`);
      buffered += new TextDecoder().decode(value);
    }
    const newline = buffered.indexOf('\n');
    const line = buffered.slice(0, newline).trim();
    buffered = buffered.slice(newline + 1);
    return line;
  };
  try {
    const raise = await nextLine();
    expect(raise).toMatch(/^raise \d+$/);
    const keydown = BigInt(kernel32.symbols.GetTickCount64()) % 0x1_0000_0000n;
    user32.symbols.NotifyWinEvent(3, BigInt(raise.slice(6)), 0, 0);
    child.stdin.write(`${keydown}\n`);
    await child.stdin.flush();
    const result = JSON.parse(await nextLine()) as Record<string, unknown>;
    expect(await child.exited).toBe(0);
    expect(result).toMatchObject({
      controlReason: null,
      inProcessReason: 'focus_changed', inProcessHandle: 0,
      crossProcessReason: 'focus_changed', crossProcessHandle: 0,
    });
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill();
    await child.exited;
    kernel32.close();
    user32.close();
  }
}, 60_000);
