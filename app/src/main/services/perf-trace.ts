import { randomUUID } from 'node:crypto';
import type { ServerPerfTiming } from '../../shared/protocol.js';
import type { OverlayPerfObservation } from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Performance');
const ID_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;
const mainEvents = ['captureCommandAt', 'stopRequestedAt', 'lastAudioDispatchedAt', 'stopDispatchedAt', 'firstPartialReceivedAt', 'finalReceivedAt', 'historyCompletedAt', 'clipboardCompletedAt'] as const;
type MainEvent = typeof mainEvents[number];
const rendererEvents = ['captureStartedAt', 'captureReadyAt', 'lastAudioAt', 'stopRequestedAt', 'firstPartialReceivedAt', 'finalReceivedAt', 'finalDomCommittedAt'] as const;
const serverDurations = ['last_audio_offset_ms', 'stop_to_lock_wait_ms', 'lock_wait_ms', 'outstanding_partial_wait_ms', 'executor_queue_wait_ms', 'final_inference_start_offset_ms', 'final_inference_end_offset_ms', 'model_inference_ms', 'ws_send_duration_ms'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

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
  historyCommitMs: number | null;
  clipboardWriteMs: number | null;
  renderer: OverlayPerfObservation | null;
  serverTimings: ServerPerfTiming | null;
  // Production never observes arbitrary target editors.
  actualInsertionObservedAt: null;
}

/** Session-scoped passive diagnostics; old asynchronous callbacks cannot mutate a newer trace. */
class PerfTraceManager {
  private readonly traces = new Map<string, ClientPerfTrace>();
  private readonly emitted = new Map<string, number>();

  startTrace(correlationId?: string): ClientPerfTrace | null {
    if (!isPerfTraceEnabled()) return null;
    const id = sanitizeCorrelationId(correlationId);
    const trace: ClientPerfTrace = {
      correlationId: id, clientClockDomain: 'electron_main_performance_now', status: 'open',
      startedAt: performance.now(), main: Object.fromEntries(mainEvents.map(event => [event, null])) as ClientPerfTrace['main'],
      historyCommitMs: null, clipboardWriteMs: null, renderer: null, serverTimings: null,
      actualInsertionObservedAt: null,
    };
    this.traces.set(id, trace);
    this.emitted.set(id, 0);
    if (this.traces.size > 50) {
      const oldest = this.traces.keys().next().value!;
      this.traces.delete(oldest);
      this.emitted.delete(oldest);
    }
    return structuredClone(trace);
  }

  mark(id: string | undefined, event: MainEvent, timestamp = performance.now()): void {
    if (!isPerfTraceEnabled() || !id || !finite(timestamp)) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    if (event === 'firstPartialReceivedAt' && trace.main[event] !== null) return;
    trace.main[event] = timestamp;
  }

  output(id: string | undefined, kind: 'history' | 'clipboard', duration: number, completedAt = performance.now()): void {
    if (!isPerfTraceEnabled() || !id || !finite(duration) || !finite(completedAt)) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    if (kind === 'history') trace.historyCommitMs = duration;
    else trace.clipboardWriteMs = duration;
    this.mark(id, kind === 'history' ? 'historyCompletedAt' : 'clipboardCompletedAt', completedAt);
  }

  server(id: string | undefined, value: unknown): void {
    if (!isPerfTraceEnabled() || !id || !value || typeof value !== 'object') return;
    const trace = this.traces.get(id);
    const raw = value as Record<string, unknown>;
    if (!trace || raw.session_id !== id || raw.clock_domain !== 'python_perf_counter') return;
    const safe: ServerPerfTiming = { session_id: id, clock_domain: 'python_perf_counter' };
    for (const field of serverDurations) safe[field] = finite(raw[field]) ? raw[field] : null;
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
    this.emit(raw.traceId);
    return true;
  }

  completeTrace(id: string | undefined, status: ClientPerfTrace['status'] = 'complete'): void {
    if (!isPerfTraceEnabled() || !id) return;
    const trace = this.traces.get(id);
    if (!trace) return;
    trace.status = status;
    this.emit(id);
  }

  emit(id: string): void {
    if (!isPerfTraceEnabled()) return;
    const trace = this.traces.get(id);
    const count = this.emitted.get(id) ?? 0;
    if (trace && count < 8) {
      this.emitted.set(id, count + 1);
      log.info('B4_PERF', { trace: JSON.stringify(trace) });
    }
  }

  getRecentTraces(): ClientPerfTrace[] { return structuredClone([...this.traces.values()]); }
  clear(): void { this.traces.clear(); this.emitted.clear(); }
}
export const perfTraceManager = new PerfTraceManager();
