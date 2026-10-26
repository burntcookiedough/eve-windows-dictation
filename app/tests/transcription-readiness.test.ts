import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import type { BrowserWindow } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
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
      service.onFinal(frame => finals.push(frame.text));
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

  test('does not connect or send audio until the server emits ready', async () => {
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
    const service = new TranscriptionService(
      `ws://127.0.0.1:${address.port}`,
      10,
      overlay
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

      socket.send(JSON.stringify({ frame: 'control', type: 'ready' }));
      await connectPromise;
      expect(connected).toBeTrue();

      service.sendAudioBuffer(new ArrayBuffer(8));
      await audioReceived.promise;
      expect(binaryFrames).toBe(1);

    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });

  test('distinguishes a user stop before readiness from a connection failure', async () => {
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

    try {
      const connectPromise = service.connect();
      await startReceived.promise;
      service.stop();

      await expect(connectPromise).rejects.toBeInstanceOf(
        TranscriptionConnectionCancelledError
      );
      await stopReceived.promise;
    } finally {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close();
    }
  });
});
