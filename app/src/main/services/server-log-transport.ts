import { StringDecoder } from 'node:string_decoder';

/**
 * Frames text from a child-process stream without assuming data events align
 * with log boundaries. Newlines and bare carriage returns both terminate an
 * entry so progress updates do not remain embedded in a later log line.
 */
export class ServerLogFramer {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    return this.consume(text);
  }

  flush(): string[] {
    const frames = this.consume(this.decoder.end());
    if (this.pending.trim()) {
      frames.push(this.pending);
    }
    this.pending = '';
    return frames;
  }

  private consume(text: string): string[] {
    if (text.length === 0) return [];

    this.pending += text;
    const frames: string[] = [];
    let frameStart = 0;

    for (let index = 0; index < this.pending.length; index += 1) {
      const code = this.pending.charCodeAt(index);
      if (code !== 10 && code !== 13) continue;

      const frame = this.pending.slice(frameStart, index);
      if (frame.trim()) frames.push(frame);
      frameStart = index + 1;
    }

    if (frameStart > 0) {
      this.pending = this.pending.slice(frameStart);
    }

    return frames;
  }
}

/**
 * FIFO delivery queue that retains the newest entries when a producer is
 * faster than its consumer. The bounded size keeps renderer IPC backpressure
 * from growing without limit while preserving recent diagnostics.
 */
export class BoundedLogDeliveryQueue<T> {
  private readonly entries: T[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError('Log delivery queue capacity must be a positive integer');
    }
  }

  get size(): number {
    return this.entries.length;
  }

  enqueue(entry: T): void {
    this.entries.push(entry);
    const overflow = this.entries.length - this.capacity;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
    }
  }

  drain(maxEntries: number): T[] {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) return [];
    return this.entries.splice(0, maxEntries);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
