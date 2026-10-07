import type { OverlayPerfObservation } from '../../shared/types';

/** One overlay clock per session; snapshots carry no audio or transcription text. */
export class OverlayPerfObserver {
  private readonly observation: OverlayPerfObservation;
  constructor(traceId: string, startedAt = performance.now()) {
    this.observation = {
      traceId, clockDomain: 'overlay_performance_now', captureStartedAt: startedAt,
      captureReadyAt: null, lastAudioAt: null, stopRequestedAt: null,
      firstPartialReceivedAt: null, finalReceivedAt: null, finalDomCommittedAt: null,
    };
  }
  mark(field: Exclude<keyof OverlayPerfObservation, 'traceId' | 'clockDomain'>, timestamp = performance.now()): void {
    if (field === 'firstPartialReceivedAt' && this.observation[field] !== null) return;
    this.observation[field] = timestamp;
  }
  snapshot(): OverlayPerfObservation { return { ...this.observation }; }
}
