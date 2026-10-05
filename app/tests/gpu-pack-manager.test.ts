import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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
  test('production descriptor accepts alpha.7 and rejects a different app identity', async () => {
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

    expect(PINNED_GPU_PACK_DESCRIPTOR.appBuildId).toBe('0.8.2-alpha.7');
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
});
