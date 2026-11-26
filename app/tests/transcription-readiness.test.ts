import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import type { BrowserWindow } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { CaptureSession } from '../src/main/services/capture-session';
import { perfTraceManager } from '../src/main/services/perf-trace';
import { IPC_CHANNELS } from '../src/shared/constants';
import { createAudioFrame } from '../src/shared/protocol';
import type { RecordingDelivery, RecordingStatePayload } from '../src/shared/types';
import {
  TranscriptionConnectionCancelledError,
  TranscriptionService,
} from '../src/main/services/transcription';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('TranscriptionService protocol readiness', () => {
  const sources = [
    { name: 'hold-to-talk Quick', source: 'normal', mode: 'quick', timeout: 300 },
    { name: 'toggle Quick', source: 'normal', mode: 'quick', timeout: 5 },
    { name: 'Long', source: 'normal', mode: 'long', timeout: 5 },
    { name: 'Lab', source: 'lab', mode: 'quick', timeout: 5 },
  ] as const;

  for (const { name, source, mode, timeout } of sources) {
    test(`${name} starts with the expected draft policy and drains PCM before stop`, async () => {
      const server = new WebSocketServer({ port: 0 });
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test address');
      const received: (string | number)[] = [];
      const draftReceived = deferred<void>();
      const closed = deferred<void>();
      const traceId = `mode-${source}-${mode}-${timeout}`;
      const oldPerf = process.env.MURMUR_PERF_TRACE;
      process.env.MURMUR_PERF_TRACE = '1';
      perfTraceManager.startTrace(traceId);
      const overlay = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as BrowserWindow;
      const service = new TranscriptionService(
        `ws://127.0.0.1:${address.port}`, timeout, overlay, undefined, mode, traceId, source,
      );
      const states: string[] = [];
      const finals: string[] = [];
      let start: { silence_timeout: number; speculative_partials?: boolean } | undefined;
      service.onRecordingState(payload => states.push(payload.state));
      service.onTranscription(payload => {
        if (payload.type === 'partial') draftReceived.resolve();
      });
      service.onFinal(frame => { finals.push(frame.text); });
      service.onClose(() => closed.resolve());

      server.on('connection', socket => {
        const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify(frame));
        const text = { frame: 'text', text: 'fixture words', confidence: 0.9, transcription_time: 0.1, audio_duration: 1 };
        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            const value = (data as Buffer)[0]!;
            received.push(value);
            if (value === 1 && start?.speculative_partials) send({ ...text, type: 'partial' });
            return;
          }
          const frame = JSON.parse(data.toString());
          received.push(frame.type);
          if (frame.type === 'start') {
            start = frame;
            send({ frame: 'control', type: 'ready' });
          } else if (frame.type === 'stop') {
            send({ frame: 'control', type: 'status', status: 'long_dictation_processing' });
            send({ ...text, type: 'final' });
            send({ frame: 'control', type: 'closing', reason: 'stop_received' });
          }
        });
      });

      try {
        await service.connect();
        expect(start?.silence_timeout).toBe(timeout);
        expect(start?.speculative_partials).toBe(source === 'lab' ? true : undefined);
        expect(states).toEqual(['listening']);
        const capture = new CaptureSession(1, audio => service.sendAudioBuffer(audio), () => {});
        capture.forward(1, Uint8Array.of(1).buffer);
        if (source === 'lab') await draftReceived.promise;
        const drained = capture.stop();
        capture.forward(1, Uint8Array.of(2).buffer);
        capture.acknowledge(1, true);
        expect(await drained).toBe(true);
        service.stop();
        await closed.promise;

        expect(received).toEqual(['start', 1, 2, 'stop']);
        expect(states).toEqual(source === 'lab'
          ? ['listening', 'transcribing', 'processing', 'success']
          : ['listening', 'processing', 'success']);
        expect(finals).toEqual(['fixture words']);
        const trace = perfTraceManager.getRecentTraces().find(item => item.correlationId === traceId);
        expect(trace).toBeDefined();
        if (source === 'lab') expect(trace?.main.firstPartialReceivedAt).toBeNumber();
        else expect(trace?.main.firstPartialReceivedAt).toBeNull();
      } finally {
        perfTraceManager.completeTrace(traceId);
        if (oldPerf === undefined) delete process.env.MURMUR_PERF_TRACE;
        else process.env.MURMUR_PERF_TRACE = oldPerf;
        for (const client of server.clients) client.terminate();
        server.close();
      }
    });
  }

  test('unexpected closure before readiness remains an error, not user cancellation', async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test address');
    server.on('connection', socket => socket.close());
    const service = new TranscriptionService(`ws://127.0.0.1:${address.port}`, 10,
      { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as BrowserWindow);
    const states: string[] = [];
    service.onRecordingState(payload => states.push(payload.state));
    try {
      await expect(service.connect()).rejects.toThrow('closed');
      expect(states.at(-1)).toBe('error');
    } finally {
      for (const client of server.clients) client.terminate();
      server.close();
    }
  });

  for (const ending of ['error', 'disconnect', 'closing', 'success'] as const) {
    test(`partial then ${ending} preserves terminal provenance and commits once only on success`, async () => {
      const server = new WebSocketServer({ port: 0 });
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No test address');
      const accepted = deferred<WebSocket>();
      server.on('connection', socket => {
        accepted.resolve(socket);
        socket.on('message', () => socket.send(JSON.stringify({ frame: 'control', type: 'ready' })));
      });
      const overlay = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as BrowserWindow;
      const service = new TranscriptionService(`ws://127.0.0.1:${address.port}`, 10, overlay);
      const finals: string[] = [];
      const states: string[] = [];
      const closed = deferred<void>();
      let closes = 0;
      service.onFinal(frame => { finals.push(frame.text); });
      service.onRecordingState(payload => states.push(payload.state));
      service.onClose(() => { closes++; closed.resolve(); });
      try {
        await service.connect();
        const socket = await accepted.promise;
        const socketClosed = once(socket, 'close');
        const text = (type: string) => JSON.stringify({ frame: 'text', type, text: 'synthetic available words', confidence: 0.9, transcription_time: 0.1, audio_duration: 1 });
        socket.send(text('partial'));
        if (ending === 'success') {
          socket.send(text('final'));
          socket.send(text('final')); // Duplicate terminal frames cannot paste twice.
          socket.send(text('partial')); // Nor regress success back to transcribing.
        }
        if (ending === 'error') {
          socket.send(JSON.stringify({ frame: 'control', type: 'error', code: 'internal', message: 'Incomplete inference' }));
        }
        if (ending !== 'disconnect') socket.send(JSON.stringify({ frame: 'control', type: 'closing', reason: 'stop_received' }));
        socket.close();
        await closed.promise;
        await socketClosed;
        expect(finals).toEqual(ending === 'success' ? ['synthetic available words'] : []);
        expect(states.at(-1)).toBe(ending === 'success' ? 'success' : 'error');
        expect(closes).toBe(1);
      } finally {
        for (const client of server.clients) client.terminate();
        server.close();
      }
    });
  }

  test.each([
    ['pasted', 'success'],
    ['copied_not_pasted', 'notice'],
    ['failed', 'error'],
    ['rejected', 'error'],
  ] as const)('publishes the %s pill outcome and closes the session only after delivery settles', async (outcome, state) => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test address');
    const socketClosed = deferred<void>();
    const delivery = Promise.withResolvers<RecordingDelivery>();
    const finalReceived = deferred<void>();
    const sessionClosed = deferred<void>();
    const states: RecordingStatePayload[] = [];
    const overlay = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload: RecordingStatePayload) => {
        if (channel === IPC_CHANNELS.STATE_RECORDING) states.push(payload);
      } },
    } as unknown as BrowserWindow;
    const service = new TranscriptionService(`ws://127.0.0.1:${address.port}`, 10, overlay);
    let closes = 0;
    service.onFinal(() => {
      finalReceived.resolve();
      return delivery.promise;
    });
    service.onClose(() => { closes++; sessionClosed.resolve(); });

    server.on('connection', socket => {
      socket.once('close', () => socketClosed.resolve());
      socket.on('message', data => {
        const send = (frame: Record<string, unknown>) => socket.send(JSON.stringify(frame));
        if (JSON.parse(data.toString()).type === 'start') {
          send({ frame: 'control', type: 'ready' });
        } else {
          send({ frame: 'control', type: 'status', status: 'long_dictation_processing' });
          send({ frame: 'text', type: 'final', text: 'synthetic fixture', confidence: 1, audio_duration: 1, transcription_time: 0.5 });
          send({ frame: 'control', type: 'closing', reason: 'stop_received' });
          socket.close();
        }
      });
    });

    try {
      await service.connect();
      service.stop();
      await finalReceived.promise;
      await socketClosed.promise;
      expect(states.map(payload => payload.state)).toEqual(['listening', 'processing']);
      expect(closes).toBe(0);

      if (outcome === 'rejected') delivery.reject(new Error('Synthetic delivery failure'));
      else delivery.resolve(outcome);
      await sessionClosed.promise;

      expect(states.map(payload => payload.state)).toEqual(['listening', 'processing', state]);
      expect(states.at(-1)).toMatchObject({ state, isRecording: false, delivery: outcome === 'rejected' ? 'failed' : outcome });
      expect(closes).toBe(1);
    } finally {
      delivery.resolve('failed');
      for (const client of server.clients) client.terminate();
      server.close();
    }
  });

  test.each([false, true])('gates connection and first audio on ready (trace enabled: %s)', async (enabled) => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('Expected an ephemeral TCP address');
    }

    const accepted = deferred<WebSocket>();
    const startReceived = deferred<void>();
    const audioReceived = deferred<void>();
    let binaryFrames = 0;

    server.on('connection', (socket) => {
      accepted.resolve(socket);
      socket.on('message', (_data, isBinary) => {
        if (isBinary) {
          binaryFrames += 1;
          audioReceived.resolve();
        } else {
          startReceived.resolve();
        }
      });
    });

    const overlay = {
      isDestroyed: () => false,
      webContents: { send: () => undefined },
    } as unknown as BrowserWindow;
    const previousTraceSetting = process.env.MURMUR_PERF_TRACE;
    if (enabled) process.env.MURMUR_PERF_TRACE = '1';
    else delete process.env.MURMUR_PERF_TRACE;
    const traceId = 'fake-websocket-startup';
    perfTraceManager.startTrace(traceId);
    const trace = () => perfTraceManager.getRecentTraces().find(entry => entry.correlationId === traceId);
    const service = new TranscriptionService(
      `ws://127.0.0.1:${address.port}`,
      10,
      overlay, undefined, 'quick', traceId
    );
    let connected = false;

    try {
      const connectPromise = service.connect().then(() => {
        connected = true;
      });
      const socket = await accepted.promise;
      await startReceived.promise;

      expect(connected).toBeFalse();
      service.sendAudioBuffer(new ArrayBuffer(8));
      expect(binaryFrames).toBe(0);
      if (enabled) {
        expect(trace()!.main.wsOpenedAt).toBeNumber();
        expect(trace()!.main.wsReadyAt).toBeNull();
        expect(trace()!.main.firstAudioSentAt).toBeNull();
      }

      socket.send(JSON.stringify({ frame: 'control', type: 'ready' }));
      await connectPromise;
      expect(connected).toBeTrue();

      service.sendAudioBuffer(createAudioFrame(0, new Int16Array([12345, -23456])));
      await audioReceived.promise;
      expect(binaryFrames).toBe(1);
      if (enabled) {
        const { wsOpenedAt, wsReadyAt, firstAudioSentAt } = trace()!.main;
        expect(wsReadyAt).toBeGreaterThanOrEqual(wsOpenedAt!);
        expect(firstAudioSentAt).toBeGreaterThanOrEqual(wsReadyAt!);
        expect(JSON.stringify(trace())).not.toContain('-23456');
      } else {
        expect(trace()).toBeUndefined();
      }

    } finally {
      perfTraceManager.clear();
      if (previousTraceSetting === undefined) delete process.env.MURMUR_PERF_TRACE;
      else process.env.MURMUR_PERF_TRACE = previousTraceSetting;
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });

  test.each([false, true])('distinguishes a user stop before readiness from a connection failure (closing frame: %s)', async (sendClosing) => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, 'listening');
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('Expected an ephemeral TCP address');
    }

    const startReceived = deferred<void>();
    const stopReceived = deferred<void>();
    server.on('connection', (socket) => {
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        const frame = JSON.parse(data.toString()) as { type?: string };
        if (frame.type === 'start') {
          startReceived.resolve();
        } else if (frame.type === 'stop') {
          stopReceived.resolve();
          if (sendClosing) socket.send(JSON.stringify({ frame: 'control', type: 'closing', reason: 'stop_received' }));
          socket.close();
        }
      });
    });

    const overlay = {
      isDestroyed: () => false,
      webContents: { send: () => undefined },
    } as unknown as BrowserWindow;
    const service = new TranscriptionService(
      `ws://127.0.0.1:${address.port}`,
      10,
      overlay
    );
    const closed = deferred<void>();
    const recordingStates: string[] = [];
    service.onClose(() => closed.resolve());
    service.onRecordingState(payload => recordingStates.push(payload.state));

    try {
      const connectPromise = service.connect();
      await startReceived.promise;
      service.stop();

      await expect(connectPromise).rejects.toBeInstanceOf(
        TranscriptionConnectionCancelledError
      );
      await stopReceived.promise;
      await closed.promise;
      expect(recordingStates).not.toContain('error');
      expect(recordingStates).not.toContain('success');
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });
});
