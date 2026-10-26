import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { AudioCapture } from '../src/renderer/overlay/audio-capture';

test('actual worklet marker drains queued PCM before capture stops; timeout releases tracks', async () => {
  const names = ['navigator', 'AudioContext', 'AudioWorkletNode', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const originals = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  let trackStops = 0;
  let Processor: any;
  let node: any;
  let ignoreDrain = false;
  const events: string[] = [];
  class FakeContext {
    audioWorklet = { addModule: async (url: string) => {
      // Execute the actual Blob module supplied by AudioCapture, not a copied protocol.
      const code = await (await fetch(url)).text();
      runInNewContext(code, {
        AudioWorkletProcessor: class {
          port = {
            onmessage: null as any,
            postMessage: (data: any) => queueMicrotask(() => node.port.onmessage?.({ data })),
          };
        },
        registerProcessor: (_: string, implementation: any) => { Processor = implementation; },
      });
    } };
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { frequencyBinCount: 128, getByteTimeDomainData() {}, disconnect() {} }; }
    async close() {}
  }
  class FakeNode {
    processor: any;
    port = {
      onmessage: null as any,
      postMessage: (data: any) => {
        if (!ignoreDrain) queueMicrotask(() => this.processor.port.onmessage?.({ data }));
      },
    };
    constructor() { node = this; this.processor = new Processor(); }
    disconnect() {}
  }
  const values = {
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => trackStops++ }] }) } },
    AudioContext: FakeContext,
    AudioWorkletNode: FakeNode,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] });
  const capture = new AudioCapture();
  try {
    await capture.start(() => events.push('audio'), () => {});
    node.processor.process([[new Float32Array([0.5])]], [], {});
    const drained = capture.drain().then(ok => { events.push(ok ? 'drained' : 'failed'); return ok; });
    expect(await drained).toBeTrue();
    expect(events).toEqual(['audio', 'drained']);
    expect(trackStops).toBe(1);
    expect(node.processor.process([[new Float32Array([0.5])]], [], {})).toBeFalse();
    await capture.start(() => events.push('late'), () => {});
    ignoreDrain = true;
    expect(await capture.drain(5)).toBeFalse();
    expect(trackStops).toBe(2);
    expect(events).toEqual(['audio', 'drained']);
  } finally {
    capture.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
