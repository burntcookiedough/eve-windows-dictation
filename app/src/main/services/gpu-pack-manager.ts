import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';

const GPU_PACK_SCHEMA_VERSION = 1;
const GPU_PACK_MANIFEST_NAME = 'gpu-pack.json';
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_COMPRESSED_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_DECOMPRESSED_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_PROGRESS_INTERVAL_MS = 100;

export interface GpuPackAssetDescriptor {
  readonly url: string;
  readonly compressedBytes: number;
  readonly compressedSha256: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The production trust root for the optional alpha.6 Windows x64 GPU pack. */
export const PINNED_GPU_PACK_DESCRIPTOR: GpuPackDescriptor = {
  schemaVersion: 1,
  appBuildId: '0.8.2-alpha.6',
  ctranslate2BuildId:
    'ctranslate2-4.6.3-cp311-cp311-win_amd64-sha256:fa2f3dcda893a3f4dedeb32b5059e4085738934d93ea8dccdce4bbef2be5d3dc',
  platform: 'win32-x64',
  assets: [
    {
      url: 'https://github.com/burntcookiedough/eve-windows-dictation/releases/download/gpu-pack-v0.8.2-alpha.6-c19a9ccabb3051651e77d1fe2f3432bfdbf0bc679dadad51ed012e36a14fd6bf/cublas64_12.dll.br',
      compressedBytes: 68190827,
      compressedSha256: 'bf44b669968ee3e660579fb0a8e436b809e075f07d3b296b017f4ca559752528',
      fileName: 'cublas64_12.dll',
      bytes: 102518272,
      sha256: '90052a83efd1b57a8e3616a6590b335855f81b814a4f16eecb7b5bf6d1b1d4eb',
    },
    {
      url: 'https://github.com/burntcookiedough/eve-windows-dictation/releases/download/gpu-pack-v0.8.2-alpha.6-c19a9ccabb3051651e77d1fe2f3432bfdbf0bc679dadad51ed012e36a14fd6bf/cublasLt64_12.dll.br',
      compressedBytes: 426759202,
      compressedSha256: '6b73b5a5125812b4b0be61ce2dfa183baac6451097ebd07466c9d264e01a446d',
      fileName: 'cublasLt64_12.dll',
      bytes: 668669952,
      sha256: 'c3a05ea244c937314afec09f87b91f814c7e27977681f6c67eb51bb06ced3a4a',
    },
  ],
};

export interface GpuPackDescriptor {
  readonly schemaVersion: 1;
  readonly appBuildId: string;
  readonly ctranslate2BuildId: string;
  readonly platform: 'win32-x64';
  readonly assets: readonly [GpuPackAssetDescriptor, GpuPackAssetDescriptor];
}

export interface GpuPackIdentity {
  readonly appBuildId: string;
  readonly ctranslate2BuildId: string;
  readonly platform: 'win32-x64';
}

export type GpuPackFailureCode =
  | 'download_failed'
  | 'integrity_failed'
  | 'pack_invalid'
  | 'storage_failed';

export type GpuPackUnavailableCode =
  | 'descriptor_missing'
  | 'invalid_descriptor'
  | 'incompatible_build';

/** Safe to return over IPC: this type deliberately has no URL or filesystem path. */
export type GpuPackState =
  | { readonly status: 'unavailable'; readonly code: GpuPackUnavailableCode }
  | { readonly status: 'missing'; readonly packId: string; readonly downloadBytes: number }
  | {
      readonly status: 'downloading';
      readonly packId: string;
      readonly receivedBytes: number;
      readonly totalBytes: number;
    }
  | { readonly status: 'validating'; readonly packId: string }
  | { readonly status: 'ready'; readonly packId: string; readonly restartRequired: true }
  | {
      readonly status: 'failed';
      readonly code: GpuPackFailureCode;
      readonly retryable: boolean;
    };

export type GpuPackAssetSource = (
  url: string,
  signal: AbortSignal,
) => Promise<AsyncIterable<Uint8Array>>;

export interface GpuPackManagerOptions {
  /** A machine-local application data directory supplied by the Electron host. */
  readonly root: string;
  readonly descriptor: GpuPackDescriptor | null;
  readonly identity: GpuPackIdentity;
  /** Test seam for fixture streams; production defaults to bounded HTTPS fetch. */
  readonly source?: GpuPackAssetSource;
}

const validatedRuntimeBrand: unique symbol = Symbol('validatedGpuRuntime');

/** Main-process-only result. Never serialize this object to the renderer. */
export interface ValidatedGpuRuntime {
  readonly directory: string;
  readonly packId: string;
  readonly appBuildId: string;
  readonly ctranslate2BuildId: string;
  readonly [validatedRuntimeBrand]: true;
}

export interface GpuPackManager {
  getState(): Promise<GpuPackState>;
  onStateChange(listener: (state: GpuPackState) => void): () => void;
  /** Call only in response to an explicit user request. */
  install(): Promise<GpuPackState>;
  /** Re-hashes the immutable pack before exposing its directory to main. */
  getValidatedRuntime(): Promise<ValidatedGpuRuntime | null>;
}

interface NormalizedDescriptor {
  readonly appBuildId: string;
  readonly ctranslate2BuildId: string;
  readonly platform: 'win32-x64';
  readonly assets: readonly [GpuPackAssetDescriptor, GpuPackAssetDescriptor];
  readonly packId: string;
  readonly downloadBytes: number;
}

interface PackManifest {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly appBuildId: string;
  readonly ctranslate2BuildId: string;
  readonly platform: 'win32-x64';
  readonly files: readonly {
    readonly fileName: string;
    readonly bytes: number;
    readonly sha256: string;
  }[];
}

type ExistingPackResult = 'missing' | 'valid' | 'invalid';

class GpuPackError extends Error {
  constructor(
    readonly code: GpuPackFailureCode,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = 'GpuPackError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeIdentity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isBoundedByteCount(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= maximum;
}

function isSafeDllName(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.dll$/i.test(value)) {
    return false;
  }

  const stem = value.slice(0, -4).toLowerCase();
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem);
}

function calculatePackId(
  value: Pick<PackManifest, 'appBuildId' | 'ctranslate2BuildId' | 'platform' | 'files'>,
): string {
  const packIdentity = {
    schemaVersion: GPU_PACK_SCHEMA_VERSION,
    appBuildId: value.appBuildId,
    ctranslate2BuildId: value.ctranslate2BuildId,
    platform: value.platform,
    files: value.files.map(({ fileName, bytes, sha256 }) => ({ fileName, bytes, sha256 })),
  };
  return createHash('sha256').update(JSON.stringify(packIdentity)).digest('hex');
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseCanonicalPackManifest(contents: string): PackManifest | null {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'packId',
        'appBuildId',
        'ctranslate2BuildId',
        'platform',
        'files',
      ]) ||
      value.schemaVersion !== GPU_PACK_SCHEMA_VERSION ||
      !isSha256(value.packId) ||
      value.packId !== value.packId.toLowerCase() ||
      !isSafeIdentity(value.appBuildId) ||
      !isSafeIdentity(value.ctranslate2BuildId) ||
      value.platform !== 'win32-x64' ||
      !Array.isArray(value.files) ||
      value.files.length !== 2
    ) {
      return null;
    }

    const files: PackManifest['files'][number][] = [];
    for (const candidate of value.files) {
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, ['fileName', 'bytes', 'sha256']) ||
        !isSafeDllName(candidate.fileName) ||
        !isBoundedByteCount(candidate.bytes, MAX_DECOMPRESSED_ASSET_BYTES) ||
        !isSha256(candidate.sha256) ||
        candidate.sha256 !== candidate.sha256.toLowerCase()
      ) {
        return null;
      }
      files.push({
        fileName: candidate.fileName,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
      });
    }

    const [first, second] = files;
    if (!first || !second || first.fileName.toLowerCase() === second.fileName.toLowerCase()) {
      return null;
    }

    const manifest: PackManifest = {
      schemaVersion: GPU_PACK_SCHEMA_VERSION,
      packId: value.packId,
      appBuildId: value.appBuildId,
      ctranslate2BuildId: value.ctranslate2BuildId,
      platform: 'win32-x64',
      files,
    };
    if (
      contents !== `${JSON.stringify(manifest)}\n` ||
      manifest.packId !== calculatePackId(manifest)
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function normalizeDescriptor(value: GpuPackDescriptor | null): NormalizedDescriptor | null {
  if (!isRecord(value) || value.schemaVersion !== GPU_PACK_SCHEMA_VERSION) return null;
  if (
    !isSafeIdentity(value.appBuildId) ||
    !isSafeIdentity(value.ctranslate2BuildId) ||
    value.platform !== 'win32-x64' ||
    !Array.isArray(value.assets) ||
    value.assets.length !== 2
  ) {
    return null;
  }

  const normalizedAssets: GpuPackAssetDescriptor[] = [];
  for (const candidate of value.assets) {
    if (!isRecord(candidate)) return null;
    if (
      typeof candidate.url !== 'string' ||
      !isSafeHttpsUrl(candidate.url) ||
      !isBoundedByteCount(candidate.compressedBytes, MAX_COMPRESSED_ASSET_BYTES) ||
      !isSha256(candidate.compressedSha256) ||
      !isSafeDllName(candidate.fileName) ||
      !isBoundedByteCount(candidate.bytes, MAX_DECOMPRESSED_ASSET_BYTES) ||
      !isSha256(candidate.sha256)
    ) {
      return null;
    }

    normalizedAssets.push({
      url: candidate.url,
      compressedBytes: candidate.compressedBytes,
      compressedSha256: candidate.compressedSha256.toLowerCase(),
      fileName: candidate.fileName,
      bytes: candidate.bytes,
      sha256: candidate.sha256.toLowerCase(),
    });
  }

  const [first, second] = normalizedAssets;
  if (!first || !second || first.fileName.toLowerCase() === second.fileName.toLowerCase()) {
    return null;
  }

  const files = [first, second].map(({ fileName, bytes, sha256 }) => ({
    fileName,
    bytes,
    sha256,
  }));
  const packId = calculatePackId({
    appBuildId: value.appBuildId,
    ctranslate2BuildId: value.ctranslate2BuildId,
    platform: value.platform,
    files,
  });

  return {
    appBuildId: value.appBuildId,
    ctranslate2BuildId: value.ctranslate2BuildId,
    platform: value.platform,
    assets: [first, second],
    packId,
    downloadBytes: first.compressedBytes + second.compressedBytes,
  };
}

function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function cloneState(state: GpuPackState): GpuPackState {
  return { ...state };
}

function toBuffer(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

async function defaultAssetSource(
  url: string,
  signal: AbortSignal,
): Promise<AsyncIterable<Uint8Array>> {
  const response = await fetch(url, {
    signal,
    headers: { 'accept-encoding': 'identity' },
  });
  if (!response.ok || !response.body) {
    throw new Error('GPU pack asset request failed');
  }

  return Readable.fromWeb(response.body) as Readable & AsyncIterable<Uint8Array>;
}

function makeManifest(descriptor: NormalizedDescriptor): PackManifest {
  return {
    schemaVersion: GPU_PACK_SCHEMA_VERSION,
    packId: descriptor.packId,
    appBuildId: descriptor.appBuildId,
    ctranslate2BuildId: descriptor.ctranslate2BuildId,
    platform: descriptor.platform,
    files: descriptor.assets.map(({ fileName, bytes, sha256 }) => ({
      fileName,
      bytes,
      sha256,
    })),
  };
}

function manifestText(descriptor: NormalizedDescriptor): string {
  return `${JSON.stringify(makeManifest(descriptor))}\n`;
}

interface ManagerOwnedPackDirectory {
  readonly directory: string;
  readonly manifest: PackManifest;
  readonly modifiedAt: number;
}

async function inspectManagerOwnedPackDirectory(
  directory: string,
): Promise<ManagerOwnedPackDirectory | null> {
  try {
    const directoryStats = await fs.promises.lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return null;

    const entries = await fs.promises.readdir(directory);
    const manifestPath = path.join(directory, GPU_PACK_MANIFEST_NAME);
    const manifestStats = await fs.promises.lstat(manifestPath);
    if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return null;

    const manifest = parseCanonicalPackManifest(await fs.promises.readFile(manifestPath, 'utf8'));
    if (!manifest || path.basename(directory) !== `gpu-pack-${manifest.packId}`) return null;

    const expectedNames = [GPU_PACK_MANIFEST_NAME, ...manifest.files.map((file) => file.fileName)];
    if (
      entries.length !== expectedNames.length ||
      entries.some((entry) => !expectedNames.includes(entry))
    ) {
      return null;
    }

    for (const file of manifest.files) {
      const fileStats = await fs.promises.lstat(path.join(directory, file.fileName));
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) return null;
    }

    return { directory, manifest, modifiedAt: directoryStats.mtimeMs };
  } catch {
    return null;
  }
}

async function isValidatedRetainedPack(pack: ManagerOwnedPackDirectory): Promise<boolean> {
  try {
    for (const file of pack.manifest.files) {
      const filePath = path.join(pack.directory, file.fileName);
      const stats = await fs.promises.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== file.bytes) return false;
      const actual = await hashFile(filePath);
      if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): GpuPackFailureCode {
  return error instanceof GpuPackError ? error.code : 'storage_failed';
}

async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function isMissing(error: unknown): Promise<boolean> {
  return isRecord(error) && error.code === 'ENOENT';
}

export function createGpuPackManager(options: GpuPackManagerOptions): GpuPackManager {
  const rootIsAbsolute = typeof options.root === 'string' && path.isAbsolute(options.root);
  const root = path.resolve(options.root);
  const descriptor = normalizeDescriptor(options.descriptor);
  const source = options.source ?? defaultAssetSource;
  const listeners = new Set<(state: GpuPackState) => void>();
  let installPromise: Promise<GpuPackState> | null = null;

  let unavailableCode: GpuPackUnavailableCode | null = null;
  if (options.descriptor === null) {
    unavailableCode = 'descriptor_missing';
  } else if (!descriptor) {
    unavailableCode = 'invalid_descriptor';
  } else if (
    options.identity.platform !== descriptor.platform ||
    options.identity.appBuildId !== descriptor.appBuildId ||
    options.identity.ctranslate2BuildId !== descriptor.ctranslate2BuildId
  ) {
    unavailableCode = 'incompatible_build';
  }

  const initialState: GpuPackState = unavailableCode
    ? { status: 'unavailable', code: unavailableCode }
    : {
        status: 'missing',
        packId: descriptor!.packId,
        downloadBytes: descriptor!.downloadBytes,
      };
  let state: GpuPackState = initialState;

  const setState = (next: GpuPackState): GpuPackState => {
    state = next;
    for (const listener of listeners) {
      try {
        listener(cloneState(next));
      } catch {
        // A UI observer must not interrupt verification, download, or publication.
      }
    }
    return cloneState(next);
  };

  const packDirectory = (): string => path.join(root, `gpu-pack-${descriptor!.packId}`);

  const ensureRoot = async (): Promise<void> => {
    if (!rootIsAbsolute) {
      throw new GpuPackError('storage_failed', 'GPU pack root must be absolute');
    }
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const stats = await fs.promises.lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GpuPackError('storage_failed', 'GPU pack root is not a regular directory');
    }
  };

  const verifyPackDirectory = async (directory: string): Promise<ExistingPackResult> => {
    let directoryStats: fs.Stats;
    try {
      directoryStats = await fs.promises.lstat(directory);
    } catch (error) {
      return (await isMissing(error)) ? 'missing' : 'invalid';
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return 'invalid';

    try {
      const entries = await fs.promises.readdir(directory);
      const expectedNames = [GPU_PACK_MANIFEST_NAME, ...descriptor!.assets.map((asset) => asset.fileName)];
      if (
        entries.length !== expectedNames.length ||
        entries.some((entry) => !expectedNames.includes(entry))
      ) {
        return 'invalid';
      }

      const manifestPath = path.join(directory, GPU_PACK_MANIFEST_NAME);
      const manifestStats = await fs.promises.lstat(manifestPath);
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) return 'invalid';
      if ((await fs.promises.readFile(manifestPath, 'utf8')) !== manifestText(descriptor!)) {
        return 'invalid';
      }

      for (const asset of descriptor!.assets) {
        const filePath = path.join(directory, asset.fileName);
        const stats = await fs.promises.lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== asset.bytes) {
          return 'invalid';
        }
        const actual = await hashFile(filePath);
        if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) return 'invalid';
      }

      return 'valid';
    } catch {
      return 'invalid';
    }
  };

  const pruneOldPackDirectories = async (): Promise<void> => {
    try {
      const currentDirectoryName = path.basename(packDirectory());
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      const managedPacks: ManagerOwnedPackDirectory[] = [];

      for (const entry of entries) {
        if (
          entry.name === currentDirectoryName ||
          !/^gpu-pack-[a-f0-9]{64}$/.test(entry.name) ||
          !entry.isDirectory() ||
          entry.isSymbolicLink()
        ) {
          continue;
        }

        const managed = await inspectManagerOwnedPackDirectory(path.join(root, entry.name));
        if (managed) managedPacks.push(managed);
      }

      managedPacks.sort(
        (left, right) =>
          right.modifiedAt - left.modifiedAt ||
          right.manifest.appBuildId.localeCompare(left.manifest.appBuildId) ||
          left.manifest.packId.localeCompare(right.manifest.packId),
      );

      let keptValidatedPrior = false;
      for (const candidate of managedPacks) {
        if (path.basename(candidate.directory) === currentDirectoryName) continue;

        // A previous release is useful only if its own canonical manifest and both
        // native files still agree. The prior app's pinned descriptor will check
        // them again before loading them after a rollback.
        const latest = await inspectManagerOwnedPackDirectory(candidate.directory);
        if (!latest) continue;
        if (!keptValidatedPrior && (await isValidatedRetainedPack(latest))) {
          keptValidatedPrior = true;
          continue;
        }

        // Re-inspect just before deletion. Never follow or remove links, and leave
        // directories with extra or non-regular entries to their owner.
        const beforeRemove = await inspectManagerOwnedPackDirectory(candidate.directory);
        if (!beforeRemove || path.basename(beforeRemove.directory) === currentDirectoryName) {
          continue;
        }
        try {
          await fs.promises.rm(beforeRemove.directory, { recursive: true, force: false });
        } catch {
          // A locked or inaccessible prior pack must not block the active runtime.
        }
      }
    } catch {
      // Retention is best-effort; inability to prune never blocks the current pack.
    }
  };

  const setVerifiedState = async (): Promise<GpuPackState> => {
    if (unavailableCode) return setState({ status: 'unavailable', code: unavailableCode });
    if (state.status === 'downloading' || state.status === 'validating') return cloneState(state);

    try {
      await ensureRoot();
      const result = await verifyPackDirectory(packDirectory());
      if (result === 'valid') {
        return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
      }
      if (result === 'invalid') {
        return setState({ status: 'failed', code: 'pack_invalid', retryable: true });
      }
      return setState({
        status: 'missing',
        packId: descriptor!.packId,
        downloadBytes: descriptor!.downloadBytes,
      });
    } catch {
      return setState({ status: 'failed', code: 'storage_failed', retryable: true });
    }
  };

  const downloadAsset = async (
    asset: GpuPackAssetDescriptor,
    targetPath: string,
    controller: AbortController,
    receivedBefore: number,
    totalBytes: number,
    onProgress: (receivedBytes: number, force?: boolean) => void,
  ): Promise<number> => {
    let received = 0;
    const hash = createHash('sha256');
    let lastProgressAt = 0;
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    };
    const verifier = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const bytes = toBuffer(chunk);
        const next = received + bytes.byteLength;
        if (next > asset.compressedBytes || next > MAX_COMPRESSED_ASSET_BYTES) {
          callback(new GpuPackError('integrity_failed', 'Compressed GPU asset exceeded its pinned size'));
          return;
        }
        received = next;
        hash.update(bytes);
        resetIdleTimeout();
        const now = Date.now();
        if (now - lastProgressAt >= MAX_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          onProgress(receivedBefore + received);
        }
        callback(null, bytes);
      },
    });

    try {
      resetIdleTimeout();
      const chunks = await source(asset.url, controller.signal);
      await pipeline(
        Readable.from(chunks),
        verifier,
        fs.createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      if (error instanceof GpuPackError) throw error;
      throw new GpuPackError('download_failed', 'GPU asset download was interrupted');
    } finally {
      if (idleTimeout) clearTimeout(idleTimeout);
    }

    const actualHash = hash.digest('hex');
    if (received !== asset.compressedBytes || actualHash !== asset.compressedSha256) {
      throw new GpuPackError('integrity_failed', 'Compressed GPU asset failed pinned integrity checks');
    }
    onProgress(receivedBefore + received, true);
    return received;
  };

  const decompressAsset = async (sourcePath: string, outputPath: string, asset: GpuPackAssetDescriptor) => {
    let bytes = 0;
    const hash = createHash('sha256');
    const verifier = new Transform({
      transform(chunk: Buffer | Uint8Array, _encoding, callback) {
        const data = toBuffer(chunk);
        const next = bytes + data.byteLength;
        if (next > asset.bytes || next > MAX_DECOMPRESSED_ASSET_BYTES) {
          callback(new GpuPackError('integrity_failed', 'Decompressed GPU asset exceeded its pinned size'));
          return;
        }
        bytes = next;
        hash.update(data);
        callback(null, data);
      },
    });

    try {
      await pipeline(
        fs.createReadStream(sourcePath),
        createBrotliDecompress(),
        verifier,
        fs.createWriteStream(outputPath, { flags: 'wx', mode: 0o600 }),
      );
    } catch (error) {
      if (error instanceof GpuPackError) throw error;
      throw new GpuPackError('integrity_failed', 'Brotli GPU asset could not be validated');
    }

    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw new GpuPackError('integrity_failed', 'Decompressed GPU asset failed pinned integrity checks');
    }
  };

  const performInstall = async (): Promise<GpuPackState> => {
    if (unavailableCode) return setState({ status: 'unavailable', code: unavailableCode });

    let stagePath: string | null = null;
    const controller = new AbortController();
    try {
      await ensureRoot();
      const existing = await verifyPackDirectory(packDirectory());
      if (existing === 'valid') {
        await pruneOldPackDirectories();
        return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
      }
      if (existing === 'invalid') {
        // An explicit install request also repairs the exact managed pack.
        // Move the invalid entry out of the loadable name before deleting it.
        const quarantine = path.join(root, `.gpu-invalid-${randomUUID()}`);
        await fs.promises.rename(packDirectory(), quarantine);
        await fs.promises.rm(quarantine, { recursive: true, force: true });
      }

      stagePath = path.join(root, `.gpu-stage-${randomUUID()}`);
      await fs.promises.mkdir(stagePath, { mode: 0o700 });

      let receivedBytes = 0;
      setState({
        status: 'downloading',
        packId: descriptor!.packId,
        receivedBytes,
        totalBytes: descriptor!.downloadBytes,
      });
      const compressedPaths: string[] = [];
      for (const [index, asset] of descriptor!.assets.entries()) {
        const compressedPath = path.join(stagePath, `asset-${index}.br`);
        compressedPaths.push(compressedPath);
        const downloaded = await downloadAsset(
          asset,
          compressedPath,
          controller,
          receivedBytes,
          descriptor!.downloadBytes,
          (next, force = false) => {
            if (force || next === 0) {
              setState({
                status: 'downloading',
                packId: descriptor!.packId,
                receivedBytes: next,
                totalBytes: descriptor!.downloadBytes,
              });
            } else {
              state = {
                status: 'downloading',
                packId: descriptor!.packId,
                receivedBytes: next,
                totalBytes: descriptor!.downloadBytes,
              };
              // The downloader throttles callbacks; keeping this path synchronous
              // avoids renderer progress work becoming a backpressure source.
              for (const listener of listeners) {
                try {
                  listener(cloneState(state));
                } catch {
                  // Observers cannot stop a bounded stream.
                }
              }
            }
          },
        );
        receivedBytes += downloaded;
      }

      setState({ status: 'validating', packId: descriptor!.packId });
      for (const [index, asset] of descriptor!.assets.entries()) {
        const compressedPath = compressedPaths[index];
        if (!compressedPath) throw new GpuPackError('storage_failed', 'Staged asset was not found');
        await decompressAsset(
          compressedPath,
          path.join(stagePath, asset.fileName),
          asset,
        );
        await fs.promises.unlink(compressedPath);
      }

      await fs.promises.writeFile(path.join(stagePath, GPU_PACK_MANIFEST_NAME), manifestText(descriptor!), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });

      const staged = await verifyPackDirectory(stagePath);
      if (staged !== 'valid') {
        throw new GpuPackError('integrity_failed', 'Staged GPU pack failed validation');
      }

      const destination = packDirectory();
      const existingAtPublish = await verifyPackDirectory(destination);
      if (existingAtPublish === 'valid') {
        await pruneOldPackDirectories();
        return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
      }
      if (existingAtPublish === 'invalid') {
        throw new GpuPackError('pack_invalid', 'Published GPU pack path is occupied', false);
      }

      try {
        await fs.promises.rename(stagePath, destination);
      } catch (error) {
        const appeared = await verifyPackDirectory(destination);
        if (appeared === 'valid') {
          await pruneOldPackDirectories();
          return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
        }
        throw error;
      }
      stagePath = null;

      const published = await verifyPackDirectory(destination);
      if (published !== 'valid') {
        throw new GpuPackError('integrity_failed', 'Published GPU pack failed validation');
      }
      await pruneOldPackDirectories();
      return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
    } catch (error) {
      const code = errorCode(error);
      const retryable = error instanceof GpuPackError ? error.retryable : true;
      return setState({ status: 'failed', code, retryable });
    } finally {
      controller.abort();
      if (stagePath) {
        try {
          await fs.promises.rm(stagePath, { recursive: true, force: true });
        } catch {
          // An abandoned staging directory is never loadable and has a random name.
        }
      }
    }
  };

  return {
    getState: setVerifiedState,
    onStateChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    install() {
      if (installPromise) return installPromise;
      const attempt = performInstall().finally(() => {
        installPromise = null;
      });
      installPromise = attempt;
      return attempt;
    },
    async getValidatedRuntime() {
      if (unavailableCode) {
        setState({ status: 'unavailable', code: unavailableCode });
        return null;
      }
      try {
        await ensureRoot();
        if ((await verifyPackDirectory(packDirectory())) !== 'valid') {
          await setVerifiedState();
          return null;
        }
        setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
        return Object.freeze({
          directory: packDirectory(),
          packId: descriptor!.packId,
          appBuildId: descriptor!.appBuildId,
          ctranslate2BuildId: descriptor!.ctranslate2BuildId,
          [validatedRuntimeBrand]: true as const,
        });
      } catch {
        setState({ status: 'failed', code: 'storage_failed', retryable: true });
        return null;
      }
    },
  };
}
