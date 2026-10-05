import { describe, expect, test } from 'bun:test';
import { getAudioFrameLevel } from '../src/shared/audio-level';
import { createAudioFrame } from '../src/shared/protocol';

describe('Home mic level from existing audio frames', () => {
  test('silence, signed samples, and clipping produce bounded energy', () => {
    expect(getAudioFrameLevel(createAudioFrame(1, new Int16Array([0, 0])))).toBe(0);
    expect(getAudioFrameLevel(createAudioFrame(2, new Int16Array([4096, -4096])))).toBe(0.5);
    expect(getAudioFrameLevel(createAudioFrame(3, new Int16Array([-32768, 32767])))).toBe(1);
  });
  test('empty and malformed frames do not drive motion', () => {
    expect(getAudioFrameLevel(new ArrayBuffer(2))).toBe(0);
    expect(getAudioFrameLevel(createAudioFrame(0, new Int16Array()))).toBe(0);
    const malformed = createAudioFrame(0, new Int16Array([2000])).slice(0, 6);
    expect(getAudioFrameLevel(malformed)).toBe(0);
  });
});
