/** Owns the renderer's PCM stream until its ordered drain acknowledgement. */
export class CaptureSession {
  private state: 'capturing' | 'draining' | 'closed' = 'capturing';
  private stopped: Promise<boolean> | null = null;
  private settle: ((drained: boolean) => void) | null = null;
  private drained = false;

  constructor(
    readonly id: number,
    private readonly sendAudio: (buffer: ArrayBuffer) => void,
    private readonly requestDrain: () => void,
  ) {}

  get canCommit(): boolean {
    return this.state === 'capturing' || this.drained;
  }

  forward(id: number, buffer: ArrayBuffer): boolean {
    if (id !== this.id || this.state === 'closed') return false;
    this.sendAudio(buffer);
    return true;
  }

  stop(timeoutMs = 2000): Promise<boolean> {
    if (this.stopped) return this.stopped;
    if (this.state === 'closed') return Promise.resolve(false);
    this.state = 'draining';
    this.stopped = new Promise(resolve => {
      const timer = setTimeout(() => this.settle?.(false), timeoutMs);
      this.settle = drained => {
        clearTimeout(timer);
        this.settle = null;
        this.state = 'closed';
        this.drained = drained;
        resolve(drained);
      };
    });
    try { this.requestDrain(); } catch { this.settle?.(false); }
    return this.stopped;
  }

  acknowledge(id: number, drained: boolean): void {
    if (id === this.id && this.state === 'draining') this.settle?.(drained);
  }

  close(): void {
    this.settle?.(false);
    this.state = 'closed';
  }
}
