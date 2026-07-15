import { describe, expect, mock, test } from 'bun:test';
import { AudioCapture } from '../src/renderer/overlay/audio-capture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function fakeStream() {
  const stop = mock(() => undefined);
  return {
    stream: { getTracks: () => [{ stop }] } as unknown as MediaStream,
    stop,
  };
}

describe('AudioCapture startup cancellation', () => {
  test('discards a stopped pending acquisition and allows the next start', async () => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
    const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(globalThis, 'AudioWorkletNode');
    const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
    const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
    const pendingStream = fakeStream();
    const activeStream = fakeStream();
    const firstAcquisition = deferred<MediaStream>();
    let getUserMediaCallCount = 0;
    const getUserMedia = mock(() =>
      ++getUserMediaCallCount === 1
        ? firstAcquisition.promise
        : Promise.resolve(activeStream.stream)
    );

    class FakeAudioContext {
      static created = 0;
      audioWorklet = { addModule: async () => undefined };

      constructor() {
        FakeAudioContext.created += 1;
      }

      createMediaStreamSource() {
        return { connect: () => undefined, disconnect: () => undefined };
      }

      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 128,
          getByteTimeDomainData: () => undefined,
          disconnect: () => undefined,
        };
      }

      async close() {}
    }

    class FakeAudioWorkletNode {
      static latest: FakeAudioWorkletNode | null = null;
      port = { onmessage: null as ((event: MessageEvent) => void) | null };

      constructor() {
        FakeAudioWorkletNode.latest = this;
      }

      disconnect() {}
    }

    Object.defineProperties(globalThis, {
      navigator: {
        configurable: true,
        value: { mediaDevices: { getUserMedia } },
      },
      AudioContext: { configurable: true, value: FakeAudioContext },
      AudioWorkletNode: { configurable: true, value: FakeAudioWorkletNode },
      requestAnimationFrame: { configurable: true, value: () => 1 },
      cancelAnimationFrame: { configurable: true, value: () => undefined },
    });

    const capture = new AudioCapture();
    const audioFrames: ArrayBuffer[] = [];

    try {
      const stoppedStart = capture.start(
        (frame) => audioFrames.push(frame),
        () => undefined
      );
      capture.stop();
      firstAcquisition.resolve(pendingStream.stream);
      await stoppedStart;

      expect(pendingStream.stop).toHaveBeenCalledTimes(1);
      expect(FakeAudioContext.created).toBe(0);

      await capture.start(
        (frame) => audioFrames.push(frame),
        () => undefined
      );
      const worklet = FakeAudioWorkletNode.latest;
      expect(worklet).not.toBeNull();
      worklet?.port.onmessage?.({
        data: { audioData: new Float32Array([0.5]) },
      } as MessageEvent);

      expect(audioFrames).toHaveLength(1);
      capture.stop();
      expect(activeStream.stop).toHaveBeenCalledTimes(1);
    } finally {
      capture.stop();
      for (const [name, descriptor] of [
        ['navigator', originalNavigator],
        ['AudioContext', originalAudioContext],
        ['AudioWorkletNode', originalAudioWorkletNode],
        ['requestAnimationFrame', originalRequestAnimationFrame],
        ['cancelAnimationFrame', originalCancelAnimationFrame],
      ] as const) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });
});
