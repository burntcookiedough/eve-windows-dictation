import { describe, expect, test } from 'bun:test';
import { once } from 'node:events';
import type { BrowserWindow } from 'electron';
import { WebSocketServer, type WebSocket } from 'ws';
import { TranscriptionService } from '../src/main/services/transcription';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('TranscriptionService protocol readiness', () => {
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
});
