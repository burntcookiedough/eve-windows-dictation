import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { isPerfTraceEnabled, perfTraceManager as manager, validateCorrelationId } from '../src/main/services/perf-trace.js';
import { OverlayPerfObserver } from '../src/renderer/overlay/perf-observation.js';
import { IsolatedEditorObserver } from '../src/renderer/app/fixtures/isolated-editor-observer.js';
const saved = process.env.MURMUR_PERF_TRACE;
beforeEach(() => { manager.clear(); process.env.MURMUR_PERF_TRACE = '1'; });
afterEach(() => { manager.clear(); if (saved === undefined) delete process.env.MURMUR_PERF_TRACE; else process.env.MURMUR_PERF_TRACE = saved; });
describe('passive correlated diagnostics', () => {
  it('does nothing by default and rejects unsafe identifiers', () => {
    delete process.env.MURMUR_PERF_TRACE;
    expect(isPerfTraceEnabled()).toBe(false);
    expect(manager.startTrace('off')).toBeNull();
    expect(manager.getRecentTraces()).toEqual([]);
    for (const value of ['', 'a'.repeat(65), 'private speech', '../../profile', null]) expect(validateCorrelationId(value)).toBe(false);
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
