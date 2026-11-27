import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isPerfTraceEnabled, perfTraceManager as manager, validateCorrelationId } from '../src/main/services/perf-trace.js';
import { OverlayPerfObserver } from '../src/renderer/overlay/perf-observation.js';
import { IsolatedEditorObserver } from '../src/renderer/app/fixtures/isolated-editor-observer.js';
import { addTransport } from '../src/main/lib/logger.js';
import type { ClientPerfTrace, PastePreDispatchReason } from '../src/main/services/perf-trace.js';
const loggedTraces: ClientPerfTrace[] = [];
addTransport(entry => {
  if (entry.context === 'Performance' && entry.message === 'B4_PERF' && typeof entry.data?.trace === 'string') {
    loggedTraces.push(JSON.parse(entry.data.trace));
  }
});
const saved = process.env.MURMUR_PERF_TRACE;
beforeEach(() => { manager.clear(); loggedTraces.length = 0; process.env.MURMUR_PERF_TRACE = '1'; });
afterEach(() => { manager.clear(); if (saved === undefined) delete process.env.MURMUR_PERF_TRACE; else process.env.MURMUR_PERF_TRACE = saved; });
describe('passive correlated diagnostics', () => {
  it('does nothing by default and rejects unsafe identifiers', () => {
    delete process.env.MURMUR_PERF_TRACE;
    expect(isPerfTraceEnabled()).toBe(false);
    expect(manager.startTrace('off')).toBeNull();
    manager.mark('off', 'hotkeyAt', 5);
    expect(manager.renderer(new OverlayPerfObserver('off', 10).snapshot())).toBe(false);
    manager.completeTrace('off');
    expect(manager.getRecentTraces()).toEqual([]);
    expect(loggedTraces).toEqual([]);
    for (const value of ['', 'a'.repeat(65), 'private speech', '../../profile', null]) expect(validateCorrelationId(value)).toBe(false);
  });
  it('exports ordered startup marks and calculates spans on the main clock', () => {
    manager.startTrace('startup');
    const step = performance.now() / 8;
    manager.mark('startup', 'hotkeyAt', 0);
    manager.mark('startup', 'recordingStartDispatchedAt', step);
    manager.mark('startup', 'wsOpenedAt', 2 * step);
    manager.mark('startup', 'wsReadyAt', 3 * step);
    manager.mark('startup', 'captureCommandAt', 4 * step);
    expect(manager.getRecentTraces()[0]!.startupSpansMs).toEqual({
      hotkeyToReady: 3 * step, readyToCaptureReadyObserved: null, hotkeyToFirstAudioSent: null,
    });

    const overlay = new OverlayPerfObserver('startup', 10_000);
    overlay.mark('mediaResolvedAt', 10_010);
    overlay.mark('contextCreatedAt', 10_020);
    overlay.mark('workletModuleLoadedAt', 10_030);
    overlay.mark('captureReadyAt', 10_040);
    const syntheticPcm = new Int16Array([12345, -23456]);
    expect(manager.renderer({ ...overlay.snapshot(), audio: syntheticPcm })).toBe(false);
    expect(manager.getRecentTraces()[0]!.main.captureReadyObservedAt).toBeNull();
    expect(manager.renderer(overlay.snapshot())).toBe(true);
    const readyObservedAt = loggedTraces.at(-1)!.main.captureReadyObservedAt!;

    overlay.mark('firstAudioPostedAt', 10_050);
    manager.mark('startup', 'firstAudioSentAt', readyObservedAt + 10);
    manager.mark('startup', 'firstAudioSentAt', readyObservedAt + 20);
    expect(manager.renderer(overlay.snapshot())).toBe(true);
    manager.completeTrace('startup');

    const trace = loggedTraces.at(-1)!;
    const { main, renderer } = trace;
    const mainMarks = [main.hotkeyAt, main.recordingStartDispatchedAt, main.wsOpenedAt,
      main.wsReadyAt, main.captureCommandAt, main.captureReadyObservedAt, main.firstAudioSentAt];
    expect(mainMarks).toEqual([...mainMarks].sort((a, b) => a! - b!));
    expect(main.captureReadyObservedAt).toBe(readyObservedAt);
    expect([renderer!.captureStartedAt, renderer!.mediaResolvedAt, renderer!.contextCreatedAt,
      renderer!.workletModuleLoadedAt, renderer!.captureReadyAt, renderer!.firstAudioPostedAt])
      .toEqual([10_000, 10_010, 10_020, 10_030, 10_040, 10_050]);
    expect(trace.startupSpansMs).toEqual({
      hotkeyToReady: 3 * step,
      readyToCaptureReadyObserved: readyObservedAt - 3 * step,
      hotkeyToFirstAudioSent: readyObservedAt + 10,
    });
    expect(JSON.stringify(loggedTraces)).not.toContain('-23456');
  });
  it('keeps overlapping callbacks in their own sessions and missing stages null', () => {
    manager.startTrace('old'); manager.startTrace('new');
    manager.mark('old', 'finalReceivedAt', 100); manager.output('old', 'history', 4, 104);
    manager.output('new', 'clipboard', 2, 202);
    manager.mark('old', 'firstPartialReceivedAt', 10); manager.mark('old', 'firstPartialReceivedAt', 20);
    manager.completeTrace('old');
    const [old, recent] = manager.getRecentTraces();
    expect(old.main.finalReceivedAt).toBe(100); expect(old.main.firstPartialReceivedAt).toBe(10);
    expect(old.historyCommitMs).toBe(4); expect(old.clipboardWriteMs).toBeNull();
    expect(old.actualInsertionObservedAt).toBeNull(); expect(recent.main.finalReceivedAt).toBeNull();
    expect(recent.clipboardWriteMs).toBe(2); expect(recent.status).toBe('open');
  });
  it('sanitizes server fields without retaining arbitrary extras', () => {
    manager.startTrace('trial');
    manager.server('trial', { session_id: 'other', clock_domain: 'python_perf_counter', model_inference_ms: 5 });
    expect(manager.getRecentTraces()[0].serverTimings).toBeNull();
    manager.server('trial', { session_id: 'trial', clock_domain: 'python_perf_counter', model_inference_ms: 12, lock_wait_ms: Infinity, text: 'PRIVATE_CANARY' });
    const trace = manager.getRecentTraces()[0];
    expect(trace.serverTimings?.model_inference_ms).toBe(12); expect(trace.serverTimings?.lock_wait_ms).toBeNull();
    expect(JSON.stringify(trace)).not.toContain('PRIVATE_CANARY');
    manager.mark('trial', 'stopRequestedAt', NaN); expect(manager.getRecentTraces()[0].main.stopRequestedAt).toBeNull();
  });
  it('preserves partial-task observations without coercing unavailable or invalid values', () => {
    manager.startTrace('trial');
    for (const value of [true, false, null, undefined, 1, 'true']) {
      manager.server('trial', { session_id: 'trial', clock_domain: 'python_perf_counter', partial_task_active_at_stop: value });
      expect((manager.getRecentTraces()[0].serverTimings as unknown as Record<string, unknown>).partial_task_active_at_stop)
        .toBe(typeof value === 'boolean' ? value : null);
    }
  });
  it('preserves successful completion across socket close while retaining early-close outcomes', () => {
    manager.startTrace('successful'); manager.startTrace('early-close');
    manager.completeTrace('successful'); manager.completeTrace('successful', 'closed');
    manager.completeTrace('early-close', 'closed');
    const [successful, earlyClose] = manager.getRecentTraces();
    expect(successful.status).toBe('complete'); expect(earlyClose.status).toBe('closed');
    // A final callback can finish asynchronous output after the socket has closed.
    manager.completeTrace('early-close');
    expect(manager.getRecentTraces()[1].status).toBe('complete');
  });
  it('keeps fixed renderer fields in their own clock domain', () => {
    manager.startTrace('trial'); const overlay = new OverlayPerfObserver('trial', 500);
    overlay.mark('finalReceivedAt', 600); overlay.mark('finalDomCommittedAt', 608);
    expect(manager.renderer({ ...overlay.snapshot(), text: 'PRIVATE_CANARY' })).toBe(false);
    expect(manager.renderer({ ...overlay.snapshot(), lastAudioAt: -1 })).toBe(false);
    expect(manager.renderer(overlay.snapshot())).toBe(true);
    const trace = manager.getRecentTraces()[0];
    expect(trace.clientClockDomain).toBe('electron_main_performance_now'); expect(trace.main.finalReceivedAt).toBeNull();
    expect(trace.renderer!.finalDomCommittedAt! - trace.renderer!.finalReceivedAt!).toBe(8);
  });
  it('preserves cancellation when a pending connection subsequently closes', () => {
    manager.startTrace('cancel-before-close');
    manager.completeTrace('cancel-before-close', 'cancelled');
    const exportsBeforeClose = loggedTraces.length;
    manager.completeTrace('cancel-before-close', 'closed');
    expect(manager.getRecentTraces()[0].status).toBe('cancelled');
    expect(loggedTraces.length).toBe(exportsBeforeClose);
    expect(loggedTraces.at(-1)!.status).toBe('cancelled');
  });
  it('exports completed output after renderer updates exhaust the snapshot budget', () => {
    manager.startTrace('busy');
    const overlay = new OverlayPerfObserver('busy', 10);
    for (let i = 0; i < 40; i++) expect(manager.renderer(overlay.snapshot())).toBe(true);
    manager.completeTrace('busy', 'closed');
    manager.mark('busy', 'finalReceivedAt', 100);
    manager.output('busy', 'history', 4, 104);
    manager.output('busy', 'clipboard', 2, 106);
    manager.pastePreDispatch('busy', 'PRIVATE_CANARY' as PastePreDispatchReason);
    expect(manager.getRecentTraces()[0].pastePreDispatchReason).toBeNull();
    manager.pastePreDispatch('busy', 'helper_unready');
    manager.pastePreDispatch('busy', 'clipboard_finalization_timeout');
    manager.completeTrace('busy');
    const completed = loggedTraces.at(-1)!;
    expect(completed.status).toBe('complete');
    expect(completed.main.finalReceivedAt).toBe(100);
    expect(completed.historyCommitMs).toBe(4);
    expect(completed.clipboardWriteMs).toBe(2);
    expect(completed.pastePreDispatchReason).toBe('helper_unready');
    for (let i = 0; i < 40; i++) { manager.completeTrace('busy'); manager.renderer(overlay.snapshot()); }
    expect(loggedTraces.filter(trace => trace.status === 'complete')).toHaveLength(1);
    expect(loggedTraces.length).toBeLessThanOrEqual(8);
  });
  it('exports cancellation once even after renderer updates exhaust the snapshot budget', () => {
    manager.startTrace('cancelled');
    const overlay = new OverlayPerfObserver('cancelled', 10);
    for (let i = 0; i < 40; i++) manager.renderer(overlay.snapshot());
    for (let i = 0; i < 40; i++) manager.completeTrace('cancelled', 'cancelled');
    expect(loggedTraces.at(-1)!.status).toBe('cancelled');
    expect(loggedTraces.filter(trace => trace.status === 'cancelled')).toHaveLength(1);
    expect(loggedTraces.length).toBeLessThanOrEqual(8);
  });
  it('bounds retained traces and returns independent snapshots', () => {
    for (let i = 0; i < 80; i++) manager.startTrace(`trace-${i}`);
    const traces = manager.getRecentTraces(); expect(traces.length).toBe(50); expect(traces[0].correlationId).toBe('trace-30');
    traces[0].historyCommitMs = 999; expect(manager.getRecentTraces()[0].historyCommitMs).toBeNull();
  });
  it('rejects requests, untrusted events, unchanged values and deletion as insertion proof', () => {
    const handlers = new Map<string, (event: Event) => void>();
    const editor = { value: '', addEventListener: (name: string, fn: (event: Event) => void) => handlers.set(name, fn), removeEventListener: (name: string) => handlers.delete(name) };
    const observer = new IsolatedEditorObserver(editor as unknown as HTMLTextAreaElement);
    expect(handlers.has('beforeinput')).toBe(false);
    const input = (inputType: string, isTrusted = true) => handlers.get('input')!({ inputType, isTrusted } as unknown as Event);
    editor.value = 'Script'; input('insertFromPaste', false); expect(observer.getObservation()).toBeNull();
    editor.value = ''; input('deleteContentBackward'); expect(observer.getObservation()).toBeNull();
    input('insertFromPaste'); expect(observer.getObservation()).toBeNull();
    editor.value = 'Fictional test'; input('insertFromPaste');
    expect(observer.getObservation()?.clockDomain).toBe('isolated_editor_performance_now');
    expect(observer.getObservation()?.charCount).toBe(editor.value.length);
    // Mock input tests filtering; it is not Windows paste evidence.
    observer.reset(); expect(observer.getObservation()).toBeNull(); observer.dispose(); expect(handlers.size).toBe(0);
  });
});
