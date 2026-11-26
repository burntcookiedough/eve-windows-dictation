import { randomUUID } from 'node:crypto';
import type { ServerPerfTiming } from '../../shared/protocol.js';
import type { OverlayPerfObservation } from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Performance');
const ID_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;
const startupEvents = [
  'hotkeyAt', 'recordingStartDispatchedAt', 'wsOpenedAt', 'wsReadyAt',
  'captureCommandAt', 'captureReadyObservedAt', 'firstAudioSentAt',
] as const;
const mainEvents = [
  ...startupEvents, 'stopRequestedAt', 'lastAudioDispatchedAt', 'stopDispatchedAt',
  'firstPartialReceivedAt', 'finalReceivedAt', 'historyCompletedAt', 'clipboardCompletedAt',
  'pasteSettleCompletedAt', 'pasteOwnershipCheckedAt', 'pasteHelperRequestSentAt', 'pasteHelperResponseAt',
] as const;
type MainEvent = typeof mainEvents[number];
const rendererEvents = [
  'captureStartedAt', 'mediaResolvedAt', 'contextCreatedAt', 'workletModuleLoadedAt',
  'captureReadyAt', 'firstAudioPostedAt', 'lastAudioAt', 'stopRequestedAt',
  'firstPartialReceivedAt', 'finalReceivedAt', 'finalDomCommittedAt',
] as const;
const firstOnlyEvents = new Set<MainEvent>([...startupEvents, 'firstPartialReceivedAt']);
const serverDurations = ['last_audio_offset_ms', 'stop_to_lock_wait_ms', 'lock_wait_ms', 'outstanding_partial_wait_ms', 'executor_queue_wait_ms', 'final_inference_start_offset_ms', 'final_inference_end_offset_ms', 'model_inference_ms', 'ws_send_duration_ms'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const elapsed = (start: number | null, end: number | null): number | null =>
  start !== null && end !== null && end >= start ? end - start : null;

// Reasons the snapshot helper itself gives when it cannot prove the keydown window.
export const foregroundRejections = ['keydown_unverified', 'tracker_unready', 'tracker_unavailable', 'focus_changed'] as const;
export type ForegroundRejection = typeof foregroundRejections[number];
const foregroundSnapshotFailures = [
  'helper_absent', 'helper_unready', 'helper_busy', 'rpc_timeout', 'no_hwnd', ...foregroundRejections,
] as const;
export type ForegroundSnapshotFailure = typeof foregroundSnapshotFailures[number];
const pastePreDispatchReasons = [
  ...foregroundSnapshotFailures, 'no_target', 'superseded', 'clipboard_baseline_read_failed',
  'clipboard_write_failed', 'clipboard_written_read_failed', 'clipboard_written_text_changed',
  'clipboard_ownership_read_failed', 'clipboard_ownership_changed', 'clipboard_sequence_unavailable',
  'clipboard_authorization_read_failed', 'clipboard_authorization_changed', 'paste_expired',
  'native_clipboard_changed', 'native_foreground_changed',
  'paste_helper_not_ready', 'paste_prepare_failed', 'paste_not_authorized',
  'clipboard_finalization_timeout', 'clipboard_delivery_failed',
] as const;
export type PastePreDispatchReason = typeof pastePreDispatchReasons[number];

export function isPerfTraceEnabled(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.MURMUR_PERF_TRACE ?? '').trim().toLowerCase());
}
export function validateCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && ID_REGEX.test(value);
}
export function sanitizeCorrelationId(value?: unknown): string {
  return validateCorrelationId(value) ? value : randomUUID();
}

export interface ClientPerfTrace {
  correlationId: string;
  clientClockDomain: 'electron_main_performance_now';
  status: 'open' | 'complete' | 'closed' | 'cancelled';
  startedAt: number;
  main: Record<MainEvent, number | null>;
  startupSpansMs: {
    hotkeyToReady: number | null;
    readyToCaptureReadyObserved: number | null;
    hotkeyToFirstAudioSent: number | null;
  };
  historyCommitMs: number | null;
  clipboardWriteMs: number | null;
  pastePreDispatchReason: PastePreDispatchReason | null;
  renderer: OverlayPerfObservation | null;
  serverTimings: ServerPerfTiming | null;
  // Production never observes arbitrary target editors.
  actualInsertionObservedAt: null;
}

type SessionTrace = Omit<ClientPerfTrace, 'startupSpansMs'>;

/** Session-scoped passive diagnostics; old asynchronous callbacks cannot mutate a newer trace. */
class PerfTraceManager {
  private readonly traces = new Map<string, SessionTrace>();
  private readonly emitted = new Map<string, number>();
  private readonly emittedTerminalStates = new Map<string, Set<ClientPerfTrace['status']>>();

  startTrace(correlationId?: string): ClientPerfTrace | null {
    if (!isPerfTraceEnabled()) return null;
    const id = sanitizeCorrelationId(correlationId);
    const trace: SessionTrace = {
      correlationId: id, clientClockDomain: 'electron_main_performance_now', status: 'open',
      startedAt: performance.now(), main: Object.fromEntries(mainEvents.map(event => [event, null])) as ClientPerfTrace['main'],
      historyCommitMs: null, clipboardWriteMs: null, pastePreDispatchReason: null, renderer: null, serverTimings: null,
      actualInsertionObservedAt: null,
    };
    this.traces.set(id, trace);
    this.emitted.set(id, 0);
    this.emittedTerminalStates.set(id, new Set());
    if (this.traces.size > 50) {
      const oldest = this.traces.keys().next().value!;
      this.traces.delete(oldest);
      this.emitted.delete(oldest);
      this.emittedTerminalStates.delete(oldest);
    }
    return structuredClone(this.snapshot(trace));
  }

  mark(id: string | undefined, event: MainEvent, timestamp?: number): void {
    if (!id || !isPerfTraceEnabled()) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    if (firstOnlyEvents.has(event) && trace.main[event] !== null) return;
    const observedAt = timestamp ?? performance.now();
    if (!finite(observedAt)) return;
    trace.main[event] = observedAt;
  }

  output(id: string | undefined, kind: 'history' | 'clipboard', duration: number, completedAt = performance.now()): void {
    if (!isPerfTraceEnabled() || !id || !finite(duration) || !finite(completedAt)) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    if (kind === 'history') trace.historyCommitMs = duration;
    else trace.clipboardWriteMs = duration;
    this.mark(id, kind === 'history' ? 'historyCompletedAt' : 'clipboardCompletedAt', completedAt);
  }

  pastePreDispatch(id: string | undefined, reason: PastePreDispatchReason): void {
    if (!id || !isPerfTraceEnabled() || !pastePreDispatchReasons.includes(reason)) return;
    const trace = this.traces.get(id);
    if (trace && trace.status !== 'complete' && trace.status !== 'cancelled') trace.pastePreDispatchReason ??= reason;
  }

  server(id: string | undefined, value: unknown): void {
    if (!isPerfTraceEnabled() || !id || !value || typeof value !== 'object') return;
    const trace = this.traces.get(id);
    const raw = value as Record<string, unknown>;
    if (!trace || raw.session_id !== id || raw.clock_domain !== 'python_perf_counter') return;
    const safe: ServerPerfTiming = { session_id: id, clock_domain: 'python_perf_counter' };
    for (const field of serverDurations) safe[field] = finite(raw[field]) ? raw[field] : null;
    safe.partial_task_active_at_stop = typeof raw.partial_task_active_at_stop === 'boolean' ? raw.partial_task_active_at_stop : null;
    trace.serverTimings = safe;
  }

  renderer(value: unknown): boolean {
    if (!isPerfTraceEnabled() || !value || typeof value !== 'object') return false;
    const raw = value as Record<string, unknown>;
    if (!validateCorrelationId(raw.traceId) || raw.clockDomain !== 'overlay_performance_now') return false;
    const trace = this.traces.get(raw.traceId);
    if (!trace) return false;
    const allowed = new Set(['traceId', 'clockDomain', ...rendererEvents]);
    if (Object.keys(raw).some(key => !allowed.has(key))) return false;
    for (const field of rendererEvents) if (raw[field] !== null && !finite(raw[field])) return false;
    trace.renderer = Object.fromEntries(['traceId', 'clockDomain', ...rendererEvents].map(field => [field, raw[field]])) as unknown as OverlayPerfObservation;
    if (trace.renderer.captureReadyAt !== null) this.mark(raw.traceId, 'captureReadyObservedAt');
    this.emit(raw.traceId);
    return true;
  }

  completeTrace(id: string | undefined, status: ClientPerfTrace['status'] = 'complete'): void {
    if (!isPerfTraceEnabled() || !id) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    if ((trace.status === 'complete' || trace.status === 'cancelled') && status === 'closed') return;
    trace.status = status;
    this.emit(id, status !== 'open');
  }

  private emit(id: string, terminal = false): void {
    if (!isPerfTraceEnabled()) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    if (terminal) {
      const states = this.emittedTerminalStates.get(id)!;
      if (states.has(trace.status)) return;
      states.add(trace.status);
      log.info('B4_PERF', { trace: JSON.stringify(this.snapshot(trace)) });
      return;
    }
    const count = this.emitted.get(id) ?? 0;
    // Reserve one export for each terminal state, including completion after close.
    if (count < 5) {
      this.emitted.set(id, count + 1);
      log.info('B4_PERF', { trace: JSON.stringify(this.snapshot(trace)) });
    }
  }

  private snapshot(trace: SessionTrace): ClientPerfTrace {
    const main = trace.main;
    return {
      ...trace,
      startupSpansMs: {
        hotkeyToReady: elapsed(main.hotkeyAt, main.wsReadyAt),
        readyToCaptureReadyObserved: elapsed(main.wsReadyAt, main.captureReadyObservedAt),
        hotkeyToFirstAudioSent: elapsed(main.hotkeyAt, main.firstAudioSentAt),
      },
    };
  }

  getRecentTraces(): ClientPerfTrace[] {
    return structuredClone([...this.traces.values()].map(trace => this.snapshot(trace)));
  }
  clear(): void { this.traces.clear(); this.emitted.clear(); this.emittedTerminalStates.clear(); }
}
export const perfTraceManager = new PerfTraceManager();
