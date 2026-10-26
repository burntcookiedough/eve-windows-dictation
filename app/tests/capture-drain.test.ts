import { expect, test } from 'bun:test';
import { CaptureSession } from '../src/main/services/capture-session';

test('queued PCM precedes stop, and stale audio/ack cannot enter another session', async () => {
  const events: string[] = [];
  const capture = new CaptureSession(7, () => events.push('audio'), () => events.push('drain'));
  expect(capture.forward(6, new ArrayBuffer(1))).toBeFalse();
  const stopped = capture.stop(1000).then(ok => { events.push(ok ? 'stop' : 'abort'); });
  expect(capture.canCommit).toBeFalse();
  expect(capture.forward(7, new ArrayBuffer(1))).toBeTrue();
  capture.acknowledge(6, true);
  expect(events).toEqual(['drain', 'audio']);
  capture.acknowledge(7, true);
  await stopped;
  expect(capture.canCommit).toBeTrue();
  expect(capture.forward(7, new ArrayBuffer(1))).toBeFalse();
  expect(events).toEqual(['drain', 'audio', 'stop']);
  const next = new CaptureSession(8, () => events.push('new audio'), () => {});
  expect(next.forward(7, new ArrayBuffer(1))).toBeFalse();
  next.close();
});

test('capture-drain timeout and teardown resolve explicitly as failure', async () => {
  const timed = new CaptureSession(1, () => {}, () => {});
  expect(await timed.stop(5)).toBeFalse();
  expect(timed.canCommit).toBeFalse();
  expect(timed.forward(1, new ArrayBuffer(1))).toBeFalse();
  const closed = new CaptureSession(2, () => {}, () => {});
  const pending = closed.stop(1000);
  closed.close();
  expect(await pending).toBeFalse();
  closed.acknowledge(2, true);
  expect(closed.forward(2, new ArrayBuffer(1))).toBeFalse();
});
