import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  createSafeStreamWriter,
  type LogOutputStream,
} from '../src/main/lib/logger';

class FakeOutputStream extends EventEmitter implements LogOutputStream {
  destroyed = false;
  writableEnded = false;
  writes: string[] = [];

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

describe('safe logger stream writer', () => {
  test('writes complete log lines while the stream is available', () => {
    const stream = new FakeOutputStream();
    const write = createSafeStreamWriter(stream);

    write('first line');
    write('second line');

    expect(stream.writes).toEqual(['first line\n', 'second line\n']);
  });

  test('absorbs an asynchronous EPIPE and disables further writes', () => {
    const stream = new FakeOutputStream();
    const write = createSafeStreamWriter(stream);

    write('before failure');
    const error = Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    expect(() => stream.emit('error', error)).not.toThrow();
    write('after failure');

    expect(stream.writes).toEqual(['before failure\n']);
  });

  test('absorbs synchronous write failures and disables further writes', () => {
    let attempts = 0;
    const stream = new FakeOutputStream();
    stream.write = () => {
      attempts += 1;
      throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
    };
    const write = createSafeStreamWriter(stream);

    expect(() => write('before failure')).not.toThrow();
    write('after failure');

    expect(attempts).toBe(1);
  });

  test('does not write to an already closed stream', () => {
    const stream = new FakeOutputStream();
    stream.writableEnded = true;
    const write = createSafeStreamWriter(stream);

    write('ignored');

    expect(stream.writes).toEqual([]);
  });

  test('does not write to a destroyed stream', () => {
    const stream = new FakeOutputStream();
    stream.destroyed = true;
    const write = createSafeStreamWriter(stream);

    write('ignored');

    expect(stream.writes).toEqual([]);
  });
});
