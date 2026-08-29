import { StringDecoder } from 'node:string_decoder';
import { Buffer } from 'node:buffer';

export const MAX_PENDING_FRAME_BYTES = 64 * 1024;

function takeUtf8Prefix(value: string, maxBytes: number): [string, string] {
  let byteLength = 0;
  let end = 0;

  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (byteLength + characterBytes > maxBytes) break;
    byteLength += characterBytes;
    end += character.length;
  }

  return [value.slice(0, end), value.slice(end)];
}

/**
 * Frames text from a child-process stream without assuming data events align
 * with log boundaries. Newlines and bare carriage returns both terminate an
 * entry so progress updates do not remain embedded in a later log line.
 * Unterminated output is emitted in bounded UTF-8 chunks to prevent a noisy
 * child process from retaining an unbounded pending frame.
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

    while (Buffer.byteLength(this.pending, 'utf8') > MAX_PENDING_FRAME_BYTES) {
      const [frame, remainder] = takeUtf8Prefix(this.pending, MAX_PENDING_FRAME_BYTES);
      if (!frame) break;
      if (frame.trim()) frames.push(frame);
      this.pending = remainder;
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
