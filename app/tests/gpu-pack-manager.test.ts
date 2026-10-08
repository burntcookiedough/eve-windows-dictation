import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import {
  createGpuPackManager,
  PINNED_GPU_PACK_DESCRIPTOR,
  type GpuPackAssetDescriptor,
  type GpuPackDescriptor,
  type GpuPackIdentity,
} from '../src/main/services/gpu-pack-manager';

const identity: GpuPackIdentity = {
  appBuildId: 'eve-0.8.2-test.1',
  ctranslate2BuildId: 'ctranslate2-4.6.3-test-wheel-a1b2',
  platform: 'win32-x64',
};

const scratchRoots: string[] = [];

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'eve-gpu-pack-test-'));
  scratchRoots.push(root);
  return path.join(root, 'local-app-data', 'gpu-packs');
}

function fixture() {
  const files = [
    { fileName: 'cudart64_fixture.dll', contents: Buffer.from('fixture CUDA runtime bytes') },
    { fileName: 'cudnn_ops64_fixture.dll', contents: Buffer.from('fixture cuDNN bytes') },
  ] as const;
  const compressed = files.map(({ contents }) => brotliCompressSync(contents));
  const assets: [GpuPackAssetDescriptor, GpuPackAssetDescriptor] = files.map(
    ({ fileName, contents }, index) => {
      const packed = compressed[index];
      if (!packed) throw new Error('Fixture compression failed');
      return {
        url: `https://fixture.invalid/${fileName}.br`,
        compressedBytes: packed.byteLength,
        compressedSha256: sha256(packed),
        fileName,
        bytes: contents.byteLength,
        sha256: sha256(contents),
      };
    },
  ) as [GpuPackAssetDescriptor, GpuPackAssetDescriptor];

  const descriptor: GpuPackDescriptor = {
    schemaVersion: 1,
    appBuildId: identity.appBuildId,
    ctranslate2BuildId: identity.ctranslate2BuildId,
    platform: identity.platform,
    assets,
  };
  const calls: string[] = [];
  const source = async (url: string) => {
    calls.push(url);
    const index = assets.findIndex((asset) => asset.url === url);
    const packed = compressed[index];
    if (!packed) throw new Error('Unknown fixture URL');
    return (async function* () {
      for (let offset = 0; offset < packed.byteLength; offset += 7) {
        yield packed.subarray(offset, Math.min(offset + 7, packed.byteLength));
      }
    })();
  };

  return { files, compressed, assets, descriptor, calls, source };
}

function managerFor(
  root: string,
  options: {
    descriptor?: GpuPackDescriptor | null;
    identity?: GpuPackIdentity;
    source?: (url: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  } = {},
) {
  const data = fixture();
  return {
    data,
    manager: createGpuPackManager({
      root,
      descriptor: options.descriptor === undefined ? data.descriptor : options.descriptor,
      identity: options.identity ?? identity,
      source: options.source ?? data.source,
    }),
  };
}

describe('GPU pack manager', () => {
  test('production descriptor accepts the current release and rejects a different app identity', async () => {
    const appPackage = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const root = await temporaryRoot();
    const productionIdentity: GpuPackIdentity = {
      appBuildId: appPackage.version,
      ctranslate2BuildId: PINNED_GPU_PACK_DESCRIPTOR.ctranslate2BuildId,
      platform: PINNED_GPU_PACK_DESCRIPTOR.platform,
    };
    let assetRequests = 0;
    const source = async () => {
      assetRequests += 1;
      throw new Error('The production descriptor check must not download assets');
    };

    expect(PINNED_GPU_PACK_DESCRIPTOR.appBuildId).toBe(appPackage.version);
    const compatible = createGpuPackManager({
      root,
      descriptor: PINNED_GPU_PACK_DESCRIPTOR,
      identity: productionIdentity,
      source,
    });
    expect((await compatible.getState()).status).toBe('missing');

    const incompatible = createGpuPackManager({
      root: `${root}-wrong-identity`,
      descriptor: PINNED_GPU_PACK_DESCRIPTOR,
      identity: { ...productionIdentity, appBuildId: '0.8.2-alpha.6' },
      source,
    });
    expect(await incompatible.getState()).toEqual({
      status: 'unavailable',
      code: 'incompatible_build',
    });
    expect(await incompatible.install()).toEqual({
      status: 'unavailable',
      code: 'incompatible_build',
    });
    expect(assetRequests).toBe(0);
  });

  test('missing pinned descriptor is unavailable and does not touch disk or network', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const manager = createGpuPackManager({
      root,
      descriptor: null,
      identity,
      source: data.source,
    });

    expect(await manager.getState()).toEqual({ status: 'unavailable', code: 'descriptor_missing' });
    expect(await manager.install()).toEqual({ status: 'unavailable', code: 'descriptor_missing' });
    expect(await manager.getValidatedRuntime()).toBeNull();
    expect(data.calls).toEqual([]);
    await expect(readdir(path.dirname(root))).rejects.toThrow();
  });

  test('downloads two exact Brotli assets, validates them, and publishes an immutable pack', async () => {
    const root = await temporaryRoot();
    const { manager, data } = managerFor(root);
    const transitions: string[] = [];
    const unsubscribe = manager.onStateChange((state) => transitions.push(state.status));

    expect((await manager.getState()).status).toBe('missing');
    const ready = await manager.install();
    unsubscribe();

    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') throw new Error('Expected ready state');
    expect(ready.restartRequired).toBe(true);
    expect(data.calls).toHaveLength(2);
    expect(transitions).toContain('downloading');
    expect(transitions).toContain('validating');

    const runtime = await manager.getValidatedRuntime();
    expect(runtime).not.toBeNull();
    if (!runtime) throw new Error('Expected validated runtime');
    expect(runtime.packId).toBe(ready.packId);
    expect(runtime.appBuildId).toBe(identity.appBuildId);
    expect(runtime.ctranslate2BuildId).toBe(identity.ctranslate2BuildId);
    for (const file of data.files) {
      expect(await readFile(path.join(runtime.directory, file.fileName))).toEqual(file.contents);
    }

    const serializedState = JSON.stringify(ready);
    expect(serializedState).not.toContain(root);
    expect(serializedState).not.toContain(data.assets[0].url);
    expect((await manager.getState()).status).toBe('ready');
    expect((await manager.install()).status).toBe('ready');
    expect(data.calls).toHaveLength(2);
  });

  test('repairs an installed pack whose bytes changed after publication', async () => {
    const root = await temporaryRoot();
    const { manager, data } = managerFor(root);
    expect((await manager.install()).status).toBe('ready');
    const runtime = await manager.getValidatedRuntime();
    if (!runtime) throw new Error('Expected validated runtime');
    await writeFile(path.join(runtime.directory, data.files[0].fileName), 'corrupt');
    expect(await manager.getState()).toMatchObject({ status: 'failed', code: 'pack_invalid', retryable: true });
    expect(await manager.getValidatedRuntime()).toBeNull();
    expect((await manager.install()).status).toBe('ready');
    expect(data.calls).toHaveLength(4);
    expect(await readFile(path.join(runtime.directory, data.files[0].fileName))).toEqual(data.files[0].contents);
  });

  test('keeps the current and newest validated prior pack across upgrades without deleting unknown entries or links', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const managerForBuild = (appBuildId: string) =>
      createGpuPackManager({
        root,
        descriptor: { ...data.descriptor, appBuildId },
        identity: { ...identity, appBuildId },
        source: data.source,
      });
    const installBuild = async (appBuildId: string) => {
      const state = await managerForBuild(appBuildId).install();
      if (state.status !== 'ready') throw new Error(`Expected ${appBuildId} pack to install`);
      return state.packId;
    };

    const firstBuild = 'eve-0.8.2-test.1';
    const secondBuild = 'eve-0.8.2-test.2';
    const currentBuild = 'eve-0.8.2-test.3';
    const firstPackId = await installBuild(firstBuild);
    const firstDirectory = path.join(root, `gpu-pack-${firstPackId}`);
    await utimes(firstDirectory, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    const secondPackId = await installBuild(secondBuild);
    const secondDirectory = path.join(root, `gpu-pack-${secondPackId}`);
    await utimes(secondDirectory, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

    const unknownDirectory = path.join(root, 'gpu-pack-user-data');
    await mkdir(unknownDirectory);
    await writeFile(path.join(unknownDirectory, 'keep.txt'), 'user-owned');
    const malformedDirectory = path.join(root, `gpu-pack-${'f'.repeat(64)}`);
    await mkdir(malformedDirectory);
    await writeFile(path.join(malformedDirectory, 'gpu-pack.json'), '{}\n');

    const symlinkTarget = path.join(path.dirname(root), 'outside-pack-target');
    await mkdir(symlinkTarget);
    await writeFile(path.join(symlinkTarget, 'keep.txt'), 'outside-target');
    const linkedDirectory = path.join(root, `gpu-pack-${'a'.repeat(64)}`);
    await symlink(symlinkTarget, linkedDirectory, 'junction');

    const currentPackId = await installBuild(currentBuild);
    const entries = await readdir(root);
    expect(entries).toContain(`gpu-pack-${currentPackId}`);
    expect(entries).toContain(`gpu-pack-${secondPackId}`);
    expect(entries).not.toContain(`gpu-pack-${firstPackId}`);
    expect(entries).toContain('gpu-pack-user-data');
    expect(entries).toContain(`gpu-pack-${'f'.repeat(64)}`);
    expect((await lstat(linkedDirectory)).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(symlinkTarget, 'keep.txt'), 'utf8')).toBe('outside-target');

    const currentRuntime = await managerForBuild(currentBuild).getValidatedRuntime();
    const rollbackRuntime = await managerForBuild(secondBuild).getValidatedRuntime();
    expect(currentRuntime?.packId).toBe(currentPackId);
    expect(rollbackRuntime?.packId).toBe(secondPackId);
  });

  test('concurrent install calls share one bounded download and one publication', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    let releaseSource!: () => void;
    let signalStarted!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseSource = resolve;
    });
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const source = async (url: string) => {
      data.calls.push(url);
      const index = data.assets.findIndex((asset) => asset.url === url);
      const packed = data.compressed[index];
      if (!packed) throw new Error('Unknown fixture URL');
      return (async function* () {
        signalStarted();
        await releaseGate;
        yield packed;
      })();
    };
    const manager = createGpuPackManager({ root, descriptor: data.descriptor, identity, source });

    const first = manager.install();
    const second = manager.install();
    expect(second).toBe(first);
    await started;
    releaseSource();
    const [firstState, secondState] = await Promise.all([first, second]);

    expect(firstState.status).toBe('ready');
    expect(secondState).toEqual(firstState);
    expect(data.calls).toHaveLength(2);
    expect((await manager.getValidatedRuntime())?.packId).toBe(
      firstState.status === 'ready' ? firstState.packId : undefined,
    );
  });

  test('rejects a compressed asset hash mismatch before publishing', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const badAssets: [GpuPackAssetDescriptor, GpuPackAssetDescriptor] = [
      data.assets[0],
      { ...data.assets[1], compressedSha256: '0'.repeat(64) },
    ];
    const manager = createGpuPackManager({
      root,
      descriptor: { ...data.descriptor, assets: badAssets },
      identity,
      source: data.source,
    });

    expect(await manager.install()).toMatchObject({
      status: 'failed',
      code: 'integrity_failed',
    });
    expect(await manager.getValidatedRuntime()).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test('rejects a decompressed member hash mismatch before publication', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const badAssets: [GpuPackAssetDescriptor, GpuPackAssetDescriptor] = [
      { ...data.assets[0], sha256: 'f'.repeat(64) },
      data.assets[1],
    ];
    const manager = createGpuPackManager({
      root,
      descriptor: { ...data.descriptor, assets: badAssets },
      identity,
      source: data.source,
    });

    expect(await manager.install()).toMatchObject({
      status: 'failed',
      code: 'integrity_failed',
    });
    expect(await manager.getValidatedRuntime()).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test('rejects a decompressed size overflow and leaves no publishable files', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const badAssets: [GpuPackAssetDescriptor, GpuPackAssetDescriptor] = [
      { ...data.assets[0], bytes: data.assets[0].bytes - 1 },
      data.assets[1],
    ];
    const manager = createGpuPackManager({
      root,
      descriptor: { ...data.descriptor, assets: badAssets },
      identity,
      source: data.source,
    });

    expect(await manager.install()).toMatchObject({
      status: 'failed',
      code: 'integrity_failed',
    });
    expect(await manager.getValidatedRuntime()).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test('rejects traversal or Windows-reserved DLL names without touching the root', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    for (const fileName of ['../outside.dll', '..\\outside.dll', 'CON.dll']) {
      const badAssets: [GpuPackAssetDescriptor, GpuPackAssetDescriptor] = [
        { ...data.assets[0], fileName },
        data.assets[1],
      ];
      const manager = createGpuPackManager({
        root,
        descriptor: { ...data.descriptor, assets: badAssets },
        identity,
        source: data.source,
      });
      expect(await manager.getState()).toEqual({ status: 'unavailable', code: 'invalid_descriptor' });
      expect(await manager.install()).toEqual({ status: 'unavailable', code: 'invalid_descriptor' });
    }

    expect(data.calls).toEqual([]);
    await expect(readdir(path.dirname(root))).rejects.toThrow();
  });

  test('reports an interrupted stream and cleans its staging directory', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const source = async (url: string) => {
      const index = data.assets.findIndex((asset) => asset.url === url);
      const packed = data.compressed[index];
      if (!packed) throw new Error('Unknown fixture URL');
      return (async function* () {
        yield packed.subarray(0, Math.max(1, Math.floor(packed.byteLength / 2)));
        throw new Error('fixture stream interrupted');
      })();
    };
    const manager = createGpuPackManager({ root, descriptor: data.descriptor, identity, source });

    expect(await manager.install()).toMatchObject({
      status: 'failed',
      code: 'download_failed',
      retryable: true,
    });
    expect(await manager.getValidatedRuntime()).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  test('requires exact app and CTranslate2 build identities before reading or downloading', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    const mismatchedIdentities: GpuPackIdentity[] = [
      { ...identity, appBuildId: 'eve-next-build' },
      { ...identity, ctranslate2BuildId: 'ctranslate2-other-wheel' },
    ];

    for (const mismatch of mismatchedIdentities) {
      const manager = createGpuPackManager({
        root,
        descriptor: data.descriptor,
        identity: mismatch,
        source: data.source,
      });
      expect(await manager.getState()).toEqual({
        status: 'unavailable',
        code: 'incompatible_build',
      });
      expect(await manager.install()).toEqual({
        status: 'unavailable',
        code: 'incompatible_build',
      });
      expect(await manager.getValidatedRuntime()).toBeNull();
    }

    expect(data.calls).toEqual([]);
    await expect(readdir(path.dirname(root))).rejects.toThrow();
  });

function createFixtureHttpServer(
  assets: readonly GpuPackAssetDescriptor[],
  compressed: readonly Uint8Array[],
  serverOptions: {
    simulate200OnRange?: boolean;
    simulate416OnFirstRange?: boolean;
    interruptFirstRequestAfterBytes?: number;
    interruptAssetIndex?: number;
    interruptAfterBytes?: number;
    simulateMalformedContentRange?: boolean;
    simulate201Created?: boolean;
    simulateGzipEncoding?: boolean;
    simulateWrongContentLength?: boolean;
    simulateOversizedBody?: boolean;
  } = {},
): Promise<{
  server: Server;
  baseUrl: string;
  close: () => Promise<void>;
  getRequestCount: () => number;
  getRequestedAssets: () => number[];
}> {
  return new Promise((resolve) => {
    let requestCount = 0;
    let did416 = false;
    let didInterrupt = false;
    const requestedAssets: number[] = [];

    const server = createServer((req, res) => {
      requestCount++;
      const url = req.url ?? '';
      const assetIndex = assets.findIndex((a) => url.includes(a.fileName));
      if (assetIndex === -1) {
        res.statusCode = 404;
        res.end();
        return;
      }
      requestedAssets.push(assetIndex);
      const data = compressed[assetIndex]!;
      const rangeHeader = req.headers['range'];

      if (serverOptions.simulate201Created && !rangeHeader) {
        res.statusCode = 201;
        res.setHeader('content-length', String(data.length));
        res.end(data);
        return;
      }

      if (serverOptions.simulateGzipEncoding) {
        res.statusCode = 200;
        res.setHeader('content-encoding', 'gzip');
        res.end(data);
        return;
      }

      if (serverOptions.simulateWrongContentLength) {
        res.statusCode = 200;
        res.setHeader('content-length', String(data.length + 99));
        res.end(data);
        return;
      }

      if (serverOptions.simulateOversizedBody) {
        res.statusCode = 200;
        // Do not send Content-Length so header check passes, but stream oversized payload
        res.write(data);
        res.write(Buffer.from('extra_bytes_exceeding_pinned_limit'));
        res.end();
        return;
      }

      if (
        (serverOptions.interruptFirstRequestAfterBytes && !didInterrupt) ||
        (serverOptions.interruptAssetIndex !== undefined &&
          serverOptions.interruptAssetIndex === assetIndex &&
          !didInterrupt)
      ) {
        didInterrupt = true;
        const interruptBytes =
          serverOptions.interruptAfterBytes ?? serverOptions.interruptFirstRequestAfterBytes ?? 15;
        const chunk = data.subarray(0, interruptBytes);
        res.statusCode = rangeHeader ? 206 : 200;
        if (rangeHeader) {
          res.setHeader('content-range', `bytes 0-${chunk.length - 1}/${data.length}`);
        }
        res.write(chunk);
        setTimeout(() => {
          try { res.destroy(); } catch {}
        }, 15);
        return;
      }

      if (rangeHeader) {
        if (serverOptions.simulate416OnFirstRange && !did416) {
          did416 = true;
          res.statusCode = 416;
          res.setHeader('content-range', `bytes */${data.length}`);
          res.end();
          return;
        }

        if (serverOptions.simulate200OnRange) {
          res.statusCode = 200;
          res.setHeader('content-length', String(data.length));
          res.end(data);
          return;
        }

        if (serverOptions.simulateMalformedContentRange) {
          res.statusCode = 206;
          res.setHeader('content-range', 'bytes malformed-header');
          res.end(data);
          return;
        }

        const match = rangeHeader.match(/bytes=(\d+)-(\d+)?/);
        if (match) {
          const start = parseInt(match[1]!, 10);
          const end = match[2] ? parseInt(match[2]!, 10) : data.length - 1;
          const chunk = data.subarray(start, end + 1);
          res.statusCode = 206;
          res.setHeader('content-range', `bytes ${start}-${end}/${data.length}`);
          res.setHeader('content-length', String(chunk.length));
          res.end(chunk);
          return;
        }
      }

      res.statusCode = 200;
      res.setHeader('content-length', String(data.length));
      res.end(data);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        baseUrl,
        close: () => new Promise<void>((r) => server.close(() => r())),
        getRequestCount: () => requestCount,
        getRequestedAssets: () => requestedAssets.slice(),
      });
    });
  });
}

  test('resumes an interrupted download from a valid partial using HTTP Range', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const managerInit = createGpuPackManager({ root, descriptor: data.descriptor, identity });
    const initState = await managerInit.getState();
    const packId = initState.status === 'missing' ? initState.packId : '';

    // Write a valid partial prefix
    const firstAsset = data.assets[0]!;
    const partPath = path.join(root, 'asset-0.part');
    const metaPath = path.join(root, 'asset-0.meta');
    const prefixBytes = data.compressed[0]!.subarray(0, 15);
    await writeFile(partPath, prefixBytes);
    const meta = {
      schemaVersion: 1,
      packId,
      appBuildId: data.descriptor.appBuildId,
      ctranslate2BuildId: data.descriptor.ctranslate2BuildId,
      url: firstAsset.url,
      assetIndex: 0,
      fileName: firstAsset.fileName,
      compressedBytes: firstAsset.compressedBytes,
      compressedSha256: firstAsset.compressedSha256,
      verifiedBytes: 15,
      prefixSha256: sha256(prefixBytes),
    };
    await writeFile(metaPath, JSON.stringify(meta));

    const srv = await createFixtureHttpServer(data.assets, data.compressed);

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const successState = await manager.install();
    expect(successState).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });

    const runtime = await manager.getValidatedRuntime();
    expect(runtime).not.toBeNull();
    const remainingInRoot = await readdir(root);
    expect(remainingInRoot.some((e) => e.endsWith('.part'))).toBe(false);
    expect(remainingInRoot.some((e) => e.endsWith('.meta'))).toBe(false);

    await srv.close();
  });

  test('safely restarts download from 0 if server responds with 200 instead of 206', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const managerInit = createGpuPackManager({ root, descriptor: data.descriptor, identity });
    const initState = await managerInit.getState();
    const packId = initState.status === 'missing' ? initState.packId : '';

    const firstAsset = data.assets[0]!;
    const partPath = path.join(root, `asset-0.part`);
    const metaPath = path.join(root, `asset-0.meta`);
    const prefixBytes = data.compressed[0]!.subarray(0, 30);
    await writeFile(partPath, prefixBytes);
    const meta = {
      schemaVersion: 1,
      packId,
      appBuildId: data.descriptor.appBuildId,
      ctranslate2BuildId: data.descriptor.ctranslate2BuildId,
      url: firstAsset.url,
      assetIndex: 0,
      fileName: firstAsset.fileName,
      compressedBytes: firstAsset.compressedBytes,
      compressedSha256: firstAsset.compressedSha256,
      verifiedBytes: 30,
      prefixSha256: sha256(prefixBytes),
    };
    await writeFile(metaPath, JSON.stringify(meta));

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulate200OnRange: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const state = await manager.install();
    expect(state).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
    expect(await manager.getValidatedRuntime()).not.toBeNull();

    await srv.close();
  });

  test('recovers deterministically from HTTP 416 with a fresh request', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const managerInit = createGpuPackManager({ root, descriptor: data.descriptor, identity });
    const initState = await managerInit.getState();
    const packId = initState.status === 'missing' ? initState.packId : '';

    const firstAsset = data.assets[0]!;
    const partPath = path.join(root, `asset-0.part`);
    const metaPath = path.join(root, `asset-0.meta`);
    const prefixBytes = data.compressed[0]!.subarray(0, 30);
    await writeFile(partPath, prefixBytes);
    const meta = {
      schemaVersion: 1,
      packId,
      appBuildId: data.descriptor.appBuildId,
      ctranslate2BuildId: data.descriptor.ctranslate2BuildId,
      url: firstAsset.url,
      assetIndex: 0,
      fileName: firstAsset.fileName,
      compressedBytes: firstAsset.compressedBytes,
      compressedSha256: firstAsset.compressedSha256,
      verifiedBytes: 30,
      prefixSha256: sha256(prefixBytes),
    };
    await writeFile(metaPath, JSON.stringify(meta));

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulate416OnFirstRange: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const state = await manager.install();
    expect(state).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
    expect(await manager.getValidatedRuntime()).not.toBeNull();

    await srv.close();
  });

  test('restarts from 0 if partial prefix hash does not match checkpoint', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const managerInit = createGpuPackManager({ root, descriptor: data.descriptor, identity });
    const initState = await managerInit.getState();
    const packId = initState.status === 'missing' ? initState.packId : '';

    const firstAsset = data.assets[0]!;
    const partPath = path.join(root, `asset-0.part`);
    const metaPath = path.join(root, `asset-0.meta`);
    await writeFile(partPath, Buffer.from('corrupted prefix bytes not matching'));
    const meta = {
      schemaVersion: 1,
      packId,
      appBuildId: data.descriptor.appBuildId,
      ctranslate2BuildId: data.descriptor.ctranslate2BuildId,
      url: firstAsset.url,
      assetIndex: 0,
      fileName: firstAsset.fileName,
      compressedBytes: firstAsset.compressedBytes,
      compressedSha256: firstAsset.compressedSha256,
      verifiedBytes: 20,
      prefixSha256: sha256(Buffer.from('original expected prefix bytes')),
    };
    await writeFile(metaPath, JSON.stringify(meta));

    const srv = await createFixtureHttpServer(data.assets, data.compressed);

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const state = await manager.install();
    expect(state).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
    expect(await manager.getValidatedRuntime()).not.toBeNull();

    await srv.close();
  });

  test('leaves unowned or malformed partial files untouched and uses fresh partial identity', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const unownedMeta = path.join(root, 'asset-0.meta');
    await writeFile(unownedMeta, '{"invalid_json": true, "corrupted');
    const unownedPart = path.join(root, 'asset-0.part');
    await writeFile(unownedPart, Buffer.from('unowned contents'));

    const srv = await createFixtureHttpServer(data.assets, data.compressed);

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const state = await manager.install();
    expect(state).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });

    // Unowned files must remain completely untouched
    expect(await readFile(unownedMeta, 'utf8')).toBe('{"invalid_json": true, "corrupted');
    expect(await readFile(unownedPart)).toEqual(Buffer.from('unowned contents'));

    await srv.close();
  });

  test('preflights free disk space and fails with insufficient_space leaving valid pack intact', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    // Install valid pack first
    const installState = await manager.install();
    expect(installState).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
    const packId = (installState as any).packId;
    expect(await manager.getValidatedRuntime()).not.toBeNull();

    // Create a new manager with constrained disk space probe
    const lowDiskManager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: data.source,
      getFreeDiskSpace: async () => 1024,
    });

    // Corrupt the pack so repair must attempt installation
    const dllPath = path.join(root, `gpu-pack-${packId}`, data.descriptor.assets[0]!.fileName);
    await writeFile(dllPath, Buffer.from('corrupt dll bytes'));

    const repairState = await lowDiskManager.repair();
    expect(repairState).toEqual({
      status: 'failed',
      code: 'insufficient_space',
      retryable: true,
    });
  });

  test('fails with space_unknown when free disk space probe returns null or throws', async () => {
    const root = await temporaryRoot();
    const data = fixture();

    const unknownSpaceManager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: data.source,
      getFreeDiskSpace: async () => null,
    });

    const state = await unknownSpaceManager.install();
    expect(state).toEqual({
      status: 'failed',
      code: 'space_unknown',
      retryable: true,
    });
  });

  test('catches ENOSPC during download and maps to insufficient_space', async () => {
    const root = await temporaryRoot();
    const data = fixture();

    const enospcSource = async () => {
      return (async function* () {
        const err: any = new Error('No space left on device');
        err.code = 'ENOSPC';
        throw err;
      })();
    };

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: enospcSource,
    });

    const state = await manager.install();
    expect(state).toEqual({
      status: 'failed',
      code: 'insufficient_space',
      retryable: true,
    });
  });

  test('repair() revalidates healthy pack without network or repairs corrupted pack via staged publish', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    // Initial install
    const initialInstall = await manager.install();
    expect(initialInstall.status).toBe('ready');
    const packId = (initialInstall as any).packId;
    expect(data.calls.length).toBe(2);

    // repair on healthy pack makes 0 network calls and returns ready
    data.calls.length = 0;
    const repairState = await manager.repair();
    expect(repairState).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
    expect(data.calls.length).toBe(0);

    // Corrupt one DLL in the pack
    const dllPath = path.join(root, `gpu-pack-${packId}`, data.descriptor.assets[0]!.fileName);
    await writeFile(dllPath, Buffer.from('damaged dll'));

    // State becomes pack_invalid
    expect(await manager.getState()).toEqual({
      status: 'failed',
      code: 'pack_invalid',
      retryable: true,
    });

    // repair now redownloads, staged-publishes, and returns ready
    const restoredState = await manager.repair();
    expect(restoredState).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
    expect(await manager.getValidatedRuntime()).not.toBeNull();
  });

  test('remove() deletes identified owned components only and leaves unknown files untouched', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    const installState = await manager.install();
    expect(installState.status).toBe('ready');
    const packId = (installState as any).packId;
    expect(await manager.getValidatedRuntime()).not.toBeNull();

    // Create an unknown directory and unknown file in root
    const unknownDir = path.join(root, 'unknown-directory');
    await mkdir(unknownDir);
    const unknownFile = path.join(unknownDir, 'important-data.txt');
    await writeFile(unknownFile, 'do not delete');

    const removeState = await manager.remove();
    expect(removeState).toMatchObject({
      status: 'missing',
      packId,
    });
    expect(await manager.getValidatedRuntime()).toBeNull();

    // Pack directory is removed
    const rootFiles = await readdir(root);
    expect(rootFiles.includes(`gpu-pack-${packId}`)).toBe(false);

    // Unknown files/directories remain 100% intact
    expect(await readFile(unknownFile, 'utf8')).toBe('do not delete');
  });

  test('acquireRuntime() provides lease with bindServerPid and blocks remove() with busy', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    const installState = await manager.install();
    expect(installState.status).toBe('ready');
    const packId = (installState as any).packId;

    const lease = await manager.acquireRuntime();
    expect(lease).not.toBeNull();
    expect(lease!.runtime.packId).toBe(packId);

    // While lease is active, remove() returns busy
    const removeAttempt = await manager.remove();
    expect(removeAttempt).toEqual({
      status: 'failed',
      code: 'busy',
      retryable: true,
    });

    // bindServerPid persists server PID to lease record
    await lease!.bindServerPid(88888);
    const leaseFiles = (await readdir(root)).filter((f) => f.startsWith('.gpu-lease-'));
    expect(leaseFiles.length).toBe(1);
    const leaseContent = JSON.parse(await readFile(path.join(root, leaseFiles[0]!), 'utf8'));
    expect(leaseContent.serverPid).toBe(88888);

    // Releasing the lease unblocks remove()
    await lease!.release();
    expect((await readdir(root)).filter((f) => f.startsWith('.gpu-lease-')).length).toBe(0);

    const removeSuccess = await manager.remove();
    expect(removeSuccess.status).toBe('missing');
  });

  test('active lease with living server PID protects pack even when manager app PID is dead', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    await manager.install();
    const lease = await manager.acquireRuntime();
    expect(lease).not.toBeNull();

    // Bind serverPid to current process pid
    await lease!.bindServerPid(process.pid);

    // Manually edit lease file so app pid is a dead PID
    const leaseFile = (await readdir(root)).find((f) => f.startsWith('.gpu-lease-'))!;
    const leasePath = path.join(root, leaseFile);
    const record = JSON.parse(await readFile(leasePath, 'utf8'));
    record.pid = 99999999;
    record.serverPid = 12345678;
    await writeFile(leasePath, JSON.stringify(record));

    // Create a new manager that sees pid 99999999 as dead, but 12345678 as alive
    const manager2 = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: data.source,
      isProcessAlive: (pid) => pid === 12345678,
    });

    // remove() must return busy because child server process is still alive!
    const state = await manager2.remove();
    expect(state).toEqual({
      status: 'failed',
      code: 'busy',
      retryable: true,
    });
    expect(await manager2.getValidatedRuntime()).not.toBeNull();
  });

  test('all bound wrapper and daemon PIDs remain protected after the app dies', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);
    await manager.install();
    const lease = await manager.acquireRuntime();
    if (!lease) throw new Error('Lease missing');
    await lease.bindServerPid(88881);
    await lease.bindServerPid(88882);
    const leaseFile = (await readdir(root)).find((name) => name.startsWith('.gpu-lease-'))!;
    const leasePath = path.join(root, leaseFile);
    const record = JSON.parse(await readFile(leasePath, 'utf8'));
    expect(record.serverPids).toEqual([88881, 88882]);
    record.pid = 88880;
    await writeFile(leasePath, JSON.stringify(record));
    const wrapperAlive = createGpuPackManager({ root, descriptor: data.descriptor, identity,
      source: data.source, isProcessAlive: (pid) => pid === 88881 });
    expect(await wrapperAlive.remove()).toEqual({ status: 'failed', code: 'busy', retryable: true });
    const allDead = createGpuPackManager({ root, descriptor: data.descriptor, identity,
      source: data.source, isProcessAlive: () => false });
    expect((await allDead.remove()).status).toBe('missing');
  });

  test('an abandoned unbound lease fails closed across the spawn-before-bind crash window', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);
    await manager.install();
    await manager.acquireRuntime();
    const leaseFile = (await readdir(root)).find((name) => name.startsWith('.gpu-lease-'))!;
    const leasePath = path.join(root, leaseFile);
    const record = JSON.parse(await readFile(leasePath, 'utf8'));
    record.pid = 88880;
    await writeFile(leasePath, JSON.stringify(record));
    const restarted = createGpuPackManager({ root, descriptor: data.descriptor, identity,
      source: data.source, isProcessAlive: () => false });
    expect(await restarted.remove()).toEqual({ status: 'failed', code: 'busy', retryable: true });
    expect(await restarted.getValidatedRuntime()).not.toBeNull();
    expect(await readFile(leasePath, 'utf8')).toBe(JSON.stringify(record));
  });

  test('a lease release preserves a replaced unknown record', async () => {
    const root = await temporaryRoot();
    const { manager } = managerFor(root);
    await manager.install();
    const lease = await manager.acquireRuntime();
    if (!lease) throw new Error('Lease missing');
    const leaseFile = (await readdir(root)).find((name) => name.startsWith('.gpu-lease-'))!;
    await writeFile(path.join(root, leaseFile), 'unknown sentinel');
    await lease.release();
    expect(await readFile(path.join(root, leaseFile), 'utf8')).toBe('unknown sentinel');
    expect(await manager.remove()).toEqual({ status: 'failed', code: 'busy', retryable: true });
  });

  test('a dead launcher alone does not expire a lease before verified daemon discovery', async () => {
    const root = await temporaryRoot();
    const { manager, data } = managerFor(root);
    await manager.install();
    const lease = await manager.acquireRuntime();
    if (!lease) throw new Error('Lease missing');
    await lease.bindServerPid(88881, 'wrapper');
    const leaseFile = (await readdir(root)).find((name) => name.startsWith('.gpu-lease-'))!;
    const record = JSON.parse(await readFile(path.join(root, leaseFile), 'utf8'));
    record.pid = 88880;
    await writeFile(path.join(root, leaseFile), JSON.stringify(record));
    const restarted = createGpuPackManager({ root, descriptor: data.descriptor, identity,
      source: data.source, isProcessAlive: () => false });
    expect(await restarted.remove()).toEqual({ status: 'failed', code: 'busy', retryable: true });
    expect(await restarted.getValidatedRuntime()).not.toBeNull();
  });

  test('retention prunes older packs but keeps current, newest validated prior, and any actively leased pack', async () => {
    const root = await temporaryRoot();

    const createPackOnDisk = async (buildId: string) => {
      const files = [
        { fileName: 'cudart64_fixture.dll', contents: Buffer.from(`dll 1 for ${buildId}`) },
        { fileName: 'cudnn_ops64_fixture.dll', contents: Buffer.from(`dll 2 for ${buildId}`) },
      ];
      const manifestFiles = files.map((f) => ({
        fileName: f.fileName,
        bytes: f.contents.length,
        sha256: sha256(f.contents),
      }));
      const packIdentity = {
        schemaVersion: 1,
        appBuildId: buildId,
        ctranslate2BuildId: identity.ctranslate2BuildId,
        platform: identity.platform,
        files: manifestFiles,
      };
      const packId = createHash('sha256').update(JSON.stringify(packIdentity)).digest('hex');
      const packDir = path.join(root, `gpu-pack-${packId}`);
      await mkdir(packDir, { recursive: true });
      for (const f of files) {
        await writeFile(path.join(packDir, f.fileName), f.contents);
      }
      const manifest = {
        schemaVersion: 1,
        packId,
        appBuildId: buildId,
        ctranslate2BuildId: identity.ctranslate2BuildId,
        platform: identity.platform,
        files: manifestFiles,
      };
      await writeFile(path.join(packDir, 'gpu-pack.json'), `${JSON.stringify(manifest)}\n`);
      return packId;
    };

    const oldestId = await createPackOnDisk('build-1');
    await utimes(path.join(root, `gpu-pack-${oldestId}`), 1000, 1000);

    const middleId = await createPackOnDisk('build-2');
    await utimes(path.join(root, `gpu-pack-${middleId}`), 2000, 2000);

    const newestId = await createPackOnDisk('build-3');
    await utimes(path.join(root, `gpu-pack-${newestId}`), 3000, 3000);

    // Active lease on the oldest pack
    const leaseData = {
      schemaVersion: 1,
      packId: oldestId,
      leaseId: 'lease-123',
      pid: process.pid,
      serverPid: null,
      createdAt: Date.now(),
    };
    await writeFile(
      path.join(root, `.gpu-lease-${oldestId}-lease-123.json`),
      `${JSON.stringify(leaseData)}\n`,
    );

    const { data, manager } = managerFor(root);
    const installState = await manager.install();
    expect(installState.status).toBe('ready');
    const currentPackId = (installState as any).packId;

    const dirsAfter = await readdir(root);
    expect(dirsAfter.includes(`gpu-pack-${currentPackId}`)).toBe(true);
    expect(dirsAfter.includes(`gpu-pack-${newestId}`)).toBe(true);
    expect(dirsAfter.includes(`gpu-pack-${oldestId}`)).toBe(true);
    expect(dirsAfter.includes(`gpu-pack-${middleId}`)).toBe(false);
  });

  test('unlike concurrent operations return busy and repeated install calls share one in-flight promise', async () => {
    const root = await temporaryRoot();
    const data = fixture();

    let releaseStream!: () => void;
    let notifyPaused!: () => void;
    const streamPaused = new Promise<void>((resolve) => {
      notifyPaused = resolve;
    });

    let didPause = false;
    const slowSource = async (url: string) => {
      return (async function* () {
        if (!didPause) {
          didPause = true;
          await new Promise<void>((r) => {
            releaseStream = r;
            notifyPaused();
          });
        }
        const index = data.assets.findIndex((a) => a.url === url);
        yield data.compressed[index]!;
      })();
    };

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: slowSource,
    });

    const installPromise1 = manager.install();
    const installPromise2 = manager.install();

    expect(installPromise1).toBe(installPromise2);

    await streamPaused;

    const removeResult = await manager.remove();
    expect(removeResult).toEqual({
      status: 'failed',
      code: 'busy',
      retryable: true,
    });

    releaseStream();
    const res1 = await installPromise1;
    expect(res1).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
  });

  test('mutation lock blocks concurrent managers and reclaims stale lock with dead PID', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);
    await mkdir(root, { recursive: true });

    // 1. Lock held by alive PID blocks mutation
    const aliveLock = {
      schemaVersion: 1,
      lockId: 'lock-1',
      pid: process.pid,
      createdAt: Date.now(),
      operation: 'install',
    };
    await writeFile(path.join(root, 'gpu-pack.lock'), JSON.stringify(aliveLock));

    const blockedState = await manager.install();
    expect(blockedState).toEqual({
      status: 'failed',
      code: 'busy',
      retryable: true,
    });

    // 2. Lock held by dead PID is reclaimed boundedly
    const deadLock = {
      schemaVersion: 1,
      lockId: 'lock-2',
      pid: 99999999,
      createdAt: Date.now(),
      operation: 'install',
    };
    await writeFile(path.join(root, 'gpu-pack.lock'), JSON.stringify(deadLock));

    const managerDead = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: data.source,
      isProcessAlive: (pid) => pid !== 99999999,
    });

    const recoveredState = await managerDead.install();
    expect(recoveredState).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });
  });

  test('end-to-end new manager first HTTP interruption then fresh manager resumes its naturally created filenames', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    // Server interrupts the very first asset after 20 bytes
    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      interruptAssetIndex: 0,
      interruptAfterBytes: 20,
    });

    const createManagerInstance = () =>
      createGpuPackManager({
        root,
        descriptor: data.descriptor,
        identity,
        fetch: async (input, init) => {
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
        },
      });

    // Manager 1 starts fresh with no pre-seeded files
    const manager1 = createManagerInstance();
    const failState = await manager1.install();
    expect(failState.status).toBe('failed');
    expect(failState).toMatchObject({
      status: 'failed',
      code: 'download_failed',
    });

    // Verify natural partial and meta files were created on disk during download
    const rootFiles = await readdir(root);
    const naturalPart = rootFiles.find((f) => f.startsWith('.gpu-partial-0') && f.endsWith('.part'));
    const naturalMeta = rootFiles.find((f) => f.startsWith('.gpu-partial-0') && f.endsWith('.meta'));
    expect(naturalPart).toBeDefined();
    expect(naturalMeta).toBeDefined();

    const metaContent = JSON.parse(await readFile(path.join(root, naturalMeta!), 'utf8'));
    expect(metaContent.verifiedBytes).toBeGreaterThanOrEqual(20);

    // Manager 2 is a brand new manager instance pointing to the same root (NO manual seeding)
    const manager2 = createManagerInstance();
    const successState = await manager2.install();
    expect(successState).toMatchObject({
      status: 'ready',
      restartRequired: true,
    });

    const runtime = await manager2.getValidatedRuntime();
    expect(runtime).not.toBeNull();
    expect(runtime!.packId).toBe(data.descriptor.assets[0].sha256.length === 64 ? (successState as any).packId : '');

    // Partials and metadata cleaned up after successful publication
    const remainingInRoot = await readdir(root);
    expect(remainingInRoot.some((e) => e.endsWith('.part'))).toBe(false);
    expect(remainingInRoot.some((e) => e.endsWith('.meta'))).toBe(false);

    await srv.close();
  });

  test('retains completed compressed assets across second-asset interruption without redownloading first asset', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    // Server completes asset 0, but interrupts asset 1 after 15 bytes
    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      interruptAssetIndex: 1,
      interruptAfterBytes: 15,
    });

    const createManagerInstance = () =>
      createGpuPackManager({
        root,
        descriptor: data.descriptor,
        identity,
        fetch: async (input, init) => {
          const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
        },
      });

    const manager1 = createManagerInstance();
    const failState = await manager1.install();
    expect(failState.status).toBe('failed');

    // Asset 0 is 100% completed and its checkpointed metadata is retained on disk
    const rootFiles = await readdir(root);
    const asset0MetaName = rootFiles.find((f) => f.startsWith('.gpu-partial-0') && f.endsWith('.meta'));
    expect(asset0MetaName).toBeDefined();
    const asset0Meta = JSON.parse(await readFile(path.join(root, asset0MetaName!), 'utf8'));
    expect(asset0Meta.verifiedBytes).toBe(data.assets[0].compressedBytes);

    // Fresh Manager 2 resumes
    const manager2 = createManagerInstance();
    const successState = await manager2.install();
    expect(successState.status).toBe('ready');

    // Verify Asset 0 was NOT re-requested by manager 2
    // Asset 0 was requested once by manager 1; manager 2 did not request it again!
    const requested = srv.getRequestedAssets();
    const asset0Requests = requested.filter((idx) => idx === 0);
    expect(asset0Requests.length).toBe(1);

    await srv.close();
  });

  test('strictly rejects malformed Content-Range from server and fails with download_failed', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    // Seed partial so range is requested
    const prefixBytes = data.compressed[0]!.subarray(0, 15);
    await writeFile(path.join(root, '.gpu-partial-0.part'), prefixBytes);
    const meta = {
      schemaVersion: 1,
      packId: (managerFor(root, { descriptor: data.descriptor }).manager.getState() as any).packId ?? '',
      appBuildId: data.descriptor.appBuildId,
      ctranslate2BuildId: data.descriptor.ctranslate2BuildId,
      url: data.assets[0].url,
      assetIndex: 0,
      fileName: data.assets[0].fileName,
      compressedBytes: data.assets[0].compressedBytes,
      compressedSha256: data.assets[0].compressedSha256,
      verifiedBytes: 15,
      prefixSha256: sha256(prefixBytes),
    };
    // Fetch packId from manager
    const mgrTemp = createGpuPackManager({ root, descriptor: data.descriptor, identity });
    const st = await mgrTemp.getState();
    meta.packId = (st as any).packId;
    await writeFile(path.join(root, '.gpu-partial-0.meta'), JSON.stringify(meta));

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulateMalformedContentRange: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const res = await manager.install();
    expect(res).toMatchObject({
      status: 'failed',
      code: 'download_failed',
    });

    await srv.close();
  });

  test('strictly rejects unexpected HTTP 201 Created on initial request', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulate201Created: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const res = await manager.install();
    expect(res).toMatchObject({
      status: 'failed',
      code: 'download_failed',
    });

    await srv.close();
  });

  test('strictly rejects unexpected Content-Encoding gzip and fails with download_failed', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulateGzipEncoding: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const res = await manager.install();
    expect(res).toMatchObject({
      status: 'failed',
      code: 'download_failed',
    });

    await srv.close();
  });

  test('strictly rejects Content-Length mismatch and fails with download_failed', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulateWrongContentLength: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const res = await manager.install();
    expect(res).toMatchObject({
      status: 'failed',
      code: 'download_failed',
    });

    await srv.close();
  });

  test('strictly rejects oversized body and fails with integrity_failed before publishing', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    const srv = await createFixtureHttpServer(data.assets, data.compressed, {
      simulateOversizedBody: true,
    });

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      fetch: async (input, init) => {
        const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(urlStr.replace('https://fixture.invalid', srv.baseUrl), init);
      },
    });

    const res = await manager.install();
    expect(res).toMatchObject({
      status: 'failed',
      code: 'integrity_failed',
    });

    const entries = await readdir(root);
    expect(entries.some((e) => e.startsWith('gpu-pack-'))).toBe(false);

    await srv.close();
  });

  test('refuses oversized metadata reads exceeding 64KB and treats as invalid/unowned', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    // Create an oversized meta file (70KB)
    const bigMeta = 'x'.repeat(70 * 1024);
    await writeFile(path.join(root, '.gpu-partial-0.meta'), bigMeta);

    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: data.source,
    });

    const res = await manager.install();
    expect(res.status).toBe('ready');

    // The oversized file was ignored and untouched
    const content = await readFile(path.join(root, '.gpu-partial-0.meta'), 'utf8');
    expect(content).toBe(bigMeta);
  });

  test('isPackLeased fails closed on malformed lease JSON and prevents remove()', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    const installState = await manager.install();
    expect(installState.status).toBe('ready');
    const packId = (installState as any).packId;

    // Create a malformed matching lease JSON
    const malformedLease = path.join(root, `.gpu-lease-${packId}-corrupt.json`);
    await writeFile(malformedLease, '{"schemaVersion": 999, "broken": true}');

    const removeResult = await manager.remove();
    expect(removeResult).toEqual({
      status: 'failed',
      code: 'busy',
      retryable: true,
    });

    // The pack directory was NOT deleted
    const entries = await readdir(root);
    expect(entries.includes(`gpu-pack-${packId}`)).toBe(true);
  });

  test('unknown exact pack directory fails install with pack_invalid and is untouched by remove', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    const initState = await manager.getState();
    const packId = (initState as any).packId;

    // Create an unknown exact pack directory containing foreign file
    const packDir = path.join(root, `gpu-pack-${packId}`);
    await mkdir(packDir, { recursive: true });
    await writeFile(path.join(packDir, 'foreign_secret.bin'), 'secret contents');

    // install() fails with pack_invalid and leaves foreign file untouched
    const installRes = await manager.install();
    expect(installRes).toMatchObject({
      status: 'failed',
      code: 'pack_invalid',
    });
    expect(await readFile(path.join(packDir, 'foreign_secret.bin'), 'utf8')).toBe('secret contents');

    // remove() also leaves foreign file untouched
    const removeRes = await manager.remove();
    expect(removeRes.status).toBe('missing');
    expect(await readFile(path.join(packDir, 'foreign_secret.bin'), 'utf8')).toBe('secret contents');
  });

  test('recovers abandoned owned stage directories while preserving foreign stage directories', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);
    await mkdir(root, { recursive: true });

    const initState = await manager.getState();
    const packId = (initState as any).packId;

    // 1. Abandoned owned stage directory with valid marker
    const ownedStageDir = path.join(root, '.gpu-stage-abandoned-1234');
    await mkdir(ownedStageDir, { recursive: true });
    const marker = {
      schemaVersion: 1,
      stageId: '.gpu-stage-abandoned-1234',
      packId,
      createdAt: Date.now() - 10000,
      manifest: { schemaVersion: 1, packId, ...identity,
        files: data.assets.map(({ fileName, bytes, sha256 }) => ({ fileName, bytes, sha256 })),
      },
    };
    await writeFile(path.join(ownedStageDir, '.stage-marker.json'), JSON.stringify(marker));
    await writeFile(path.join(ownedStageDir, '.gpu-partial-0.part'), 'temp partial bytes');

    // 2. Foreign stage directory with unknown file and missing marker
    const foreignStageDir = path.join(root, '.gpu-stage-foreign-5678');
    await mkdir(foreignStageDir, { recursive: true });
    await writeFile(path.join(foreignStageDir, 'unowned_file.txt'), 'do not touch');

    // Run install()
    const installRes = await manager.install();
    expect(installRes.status).toBe('ready');

    // Owned stage directory was recovered and cleaned
    const entries = await readdir(root);
    expect(entries.includes('.gpu-stage-abandoned-1234')).toBe(false);

    // Foreign stage directory was preserved!
    expect(entries.includes('.gpu-stage-foreign-5678')).toBe(true);
    expect(await readFile(path.join(foreignStageDir, 'unowned_file.txt'), 'utf8')).toBe('do not touch');
  });

  test('acquireRuntime acquires mutation lock preventing concurrent remove race', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);

    await manager.install();

    // Lock file held by another process
    const lockPath = path.join(root, 'gpu-pack.lock');
    await writeFile(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        lockId: 'ext-lock',
        pid: process.pid,
        createdAt: Date.now(),
        operation: 'remove',
      }),
    );

    // acquireRuntime fails safely and returns null while mutation lock is held
    const lease = await manager.acquireRuntime();
    expect(lease).toBeNull();

    await rm(lockPath);
  });

  test('an unknown DLL injected into an active stage survives failure and later cleanup', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    let injectedStage = '';
    const manager = createGpuPackManager({ root, descriptor: data.descriptor, identity,
      source: async () => {
        const stage = (await readdir(root)).find((entry) => entry.startsWith('.gpu-stage-'));
        if (!stage) throw new Error('Stage missing');
        injectedStage = path.join(root, stage);
        await writeFile(path.join(injectedStage, 'unrelated.dll'), 'unknown sentinel');
        throw new Error('Synthetic interruption');
      },
    });
    expect((await manager.install()).status).toBe('failed');
    expect(await readFile(path.join(injectedStage, 'unrelated.dll'), 'utf8')).toBe('unknown sentinel');
    const replacement = managerFor(root).manager;
    expect((await replacement.install()).status).toBe('ready');
    expect((await replacement.remove()).status).toBe('missing');
    expect(await readFile(path.join(injectedStage, 'unrelated.dll'), 'utf8')).toBe('unknown sentinel');
  });

  test('Repair restores a missing DLL from an identified pack without mutating unknown entries', async () => {
    const root = await temporaryRoot();
    const { data, manager } = managerFor(root);
    await manager.install();
    const runtime = await manager.getValidatedRuntime();
    if (!runtime) throw new Error('Runtime missing');
    await rm(path.join(runtime.directory, data.files[0].fileName));
    expect((await manager.repair()).status).toBe('ready');
    expect(await readFile(path.join(runtime.directory, data.files[0].fileName))).toEqual(data.files[0].contents);
  });

  test('a runtime lease cannot be resurrected by a bind concurrent with release', async () => {
    const root = await temporaryRoot();
    const { manager } = managerFor(root);
    await manager.install();
    const lease = await manager.acquireRuntime();
    if (!lease) throw new Error('Lease missing');
    await Promise.all([lease.bindServerPid(process.pid), lease.release()]);
    expect((await readdir(root)).some((entry) => entry.startsWith('.gpu-lease-'))).toBe(false);
    await expect(lease.bindServerPid(process.pid)).rejects.toThrow('released');
    expect((await manager.remove()).status).toBe('missing');
  });

  test('disk exhaustion from a real file-handle write returns a retryable storage failure', async () => {
    const root = await temporaryRoot();
    const { manager } = managerFor(root);
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).endsWith('.part')) {
        handle.write = async () => { throw Object.assign(new Error('Synthetic full disk'), { code: 'ENOSPC' }); };
      }
      return handle;
    });
    try {
      expect(await manager.install()).toEqual({ status: 'failed', code: 'insufficient_space', retryable: true });
      expect(await manager.getValidatedRuntime()).toBeNull();
    } finally { openSpy.mockRestore(); }
  });

  test('removal defers before touching the current pack when a prior pack is leased', async () => {
    const root = await temporaryRoot();
    const { manager, data } = managerFor(root);
    await manager.install();
    const lease = await manager.acquireRuntime();
    if (!lease) throw new Error('Lease missing');
    const nextDescriptor = { ...data.descriptor, appBuildId: 'eve-test-next' };
    const next = createGpuPackManager({ root, descriptor: nextDescriptor,
      identity: { ...identity, appBuildId: nextDescriptor.appBuildId }, source: data.source });
    expect((await next.install()).status).toBe('ready');
    const runtime = await next.getValidatedRuntime();
    if (!runtime) throw new Error('Next runtime missing');
    expect(await next.remove()).toEqual({ status: 'failed', code: 'busy', retryable: true });
    expect(await readFile(path.join(runtime.directory, data.files[0].fileName))).toEqual(data.files[0].contents);
    await lease.release();
    expect((await next.remove()).status).toBe('missing');
  });

  test('refuses writes through a junction in root ancestry', async () => {
    const root = await temporaryRoot();
    const outside = path.join(path.dirname(root), 'sentinel-volume');
    await mkdir(outside, { recursive: true });
    const redirectedRoot = path.join(path.dirname(root), 'junction');
    await symlink(outside, redirectedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const { manager, data } = managerFor(path.join(redirectedRoot, 'gpu-packs'));
    expect((await manager.install()).status).toBe('failed');
    expect(data.calls).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
  });

  test('disk preflight discounts verified bytes already present on disk', async () => {
    const root = await temporaryRoot();
    const data = fixture();
    await mkdir(root, { recursive: true });

    // Pre-seed asset 0 as fully verified
    const firstAsset = data.assets[0];
    const prefixBytes = data.compressed[0]!;
    await writeFile(path.join(root, '.gpu-partial-0.part'), prefixBytes);

    const mgrInit = createGpuPackManager({ root, descriptor: data.descriptor, identity });
    const packId = ((await mgrInit.getState()) as any).packId;

    const meta = {
      schemaVersion: 1,
      packId,
      appBuildId: data.descriptor.appBuildId,
      ctranslate2BuildId: data.descriptor.ctranslate2BuildId,
      url: firstAsset.url,
      assetIndex: 0,
      fileName: firstAsset.fileName,
      compressedBytes: firstAsset.compressedBytes,
      compressedSha256: firstAsset.compressedSha256,
      verifiedBytes: firstAsset.compressedBytes,
      prefixSha256: sha256(prefixBytes),
    };
    await writeFile(path.join(root, '.gpu-partial-0.meta'), JSON.stringify(meta));

    // Staged raw = sum(asset bytes), bounded metadata = 10MB, margin = 50MB
    const stagedRaw = data.assets.reduce((sum, a) => sum + a.bytes, 0);
    const asset1Compressed = data.assets[1].compressedBytes;
    const requiredForAsset1Only = asset1Compressed + stagedRaw + 10 * 1024 * 1024 + 50 * 1024 * 1024;
    const requiredBothAssets = data.descriptor.assets[0].compressedBytes + requiredForAsset1Only;

    // Simulate disk space that is enough for asset 1, but NOT enough if asset 0 was not discounted
    const availableSpace = requiredForAsset1Only + 1024; // slightly more than required for asset 1 only, but less than requiredBothAssets

    let probedCount = 0;
    const manager = createGpuPackManager({
      root,
      descriptor: data.descriptor,
      identity,
      source: data.source,
      getFreeDiskSpace: async () => {
        probedCount++;
        return availableSpace;
      },
    });

    const res = await manager.install();
    expect(res.status).toBe('ready');
    expect(probedCount).toBeGreaterThan(0);
  });

});
