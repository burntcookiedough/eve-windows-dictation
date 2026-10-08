import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress } from 'node:zlib';

const GPU_PACK_SCHEMA_VERSION = 1;
const GPU_PACK_MANIFEST_NAME = 'gpu-pack.json';
const STAGE_MARKER_NAME = '.stage-marker.json';
const LOCK_FILE_NAME = 'gpu-pack.lock';
const LOCK_RECLAIM_NAME = 'gpu-pack.lock.reclaim';
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_COMPRESSED_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_DECOMPRESSED_ASSET_BYTES = 1024 * 1024 * 1024;
const MAX_PROGRESS_INTERVAL_MS = 100;
const CHECKPOINT_INTERVAL_BYTES = 512 * 1024;
const BOUNDED_TEMP_METADATA_BYTES = 10 * 1024 * 1024;
const SAFETY_MARGIN_BYTES = 50 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_ABANDONED_STAGES_PER_OPERATION = 16;

export interface GpuPackAssetDescriptor {
  readonly url: string;
  readonly compressedBytes: number;
  readonly compressedSha256: string;
  readonly fileName: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** The production trust root for the optional alpha.8 Windows x64 GPU pack. */
export const PINNED_GPU_PACK_DESCRIPTOR: GpuPackDescriptor = {
  schemaVersion: 1,
  appBuildId: '0.8.2-alpha.8',
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
  | 'storage_failed'
  | 'insufficient_space'
  | 'space_unknown'
  | 'busy';

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

export type GpuPackFetchSeam = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GpuPackManagerOptions {
  /** A machine-local application data directory supplied by the Electron host. */
  readonly root: string;
  readonly descriptor: GpuPackDescriptor | null;
  readonly identity: GpuPackIdentity;
  /** Test seam for fixture streams; production defaults to bounded HTTPS fetch. */
  readonly source?: GpuPackAssetSource;
  /** Test seam for fetch routing; production defaults to globalThis.fetch. */
  readonly fetch?: GpuPackFetchSeam;
  /** Optional disk free space probe seam for deterministic testing. */
  readonly getFreeDiskSpace?: (targetPath: string) => Promise<number | null>;
  /** Optional process liveness check seam for test fixtures. */
  readonly isProcessAlive?: (pid: number) => boolean;
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

export interface RuntimeLease {
  readonly runtime: ValidatedGpuRuntime;
  /** Binds the spawned or adopted server process PID to the durable lease record. */
  bindServerPid(pid: number): Promise<void>;
  /** Releases the runtime lease and removes the durable lease record. */
  release(): Promise<void> | void;
}

export interface GpuPackManager {
  getState(): Promise<GpuPackState>;
  onStateChange(listener: (state: GpuPackState) => void): () => void;
  /** Call only in response to an explicit user request. Repeated calls coalesce. */
  install(): Promise<GpuPackState>;
  /** Revalidates or repairs the exact managed pack. */
  repair(): Promise<GpuPackState>;
  /** Deletes identified owned component data when not in active use. */
  remove(): Promise<GpuPackState>;
  /** Re-hashes the immutable pack before exposing its directory to main. */
  getValidatedRuntime(): Promise<ValidatedGpuRuntime | null>;
  /** Preferred runtime acquisition with durable lease protection. */
  acquireRuntime(): Promise<RuntimeLease | null>;
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

interface PartialMetadata {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly appBuildId: string;
  readonly ctranslate2BuildId: string;
  readonly url: string;
  readonly assetIndex: number;
  readonly fileName: string;
  readonly compressedBytes: number;
  readonly compressedSha256: string;
  readonly verifiedBytes: number;
  readonly prefixSha256: string;
}

interface MutationLockRecord {
  readonly schemaVersion: 1;
  readonly lockId: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly operation: string;
}

interface RuntimeLeaseRecord {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly leaseId: string;
  readonly pid: number;
  serverPid: number | null;
  readonly createdAt: number;
}

interface StageMarkerRecord {
  readonly schemaVersion: 1;
  readonly stageId: string;
  readonly packId: string;
  readonly createdAt: number;
  readonly manifest: PackManifest;
}

type ExistingPackResult = 'missing' | 'valid' | 'invalid';

interface ManagerOwnedPackDirectory {
  readonly directory: string;
  readonly manifest: PackManifest;
  readonly modifiedAt: number;
}

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

async function readBoundedUtf8File(
  filePath: string,
  maxBytes = MAX_METADATA_BYTES,
): Promise<string | null> {
  try {
    const stats = await fs.promises.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
      return null;
    }
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
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
      value.packId !== (value.packId as string).toLowerCase() ||
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
        candidate.sha256 !== (candidate.sha256 as string).toLowerCase()
      ) {
        return null;
      }
      files.push({
        fileName: candidate.fileName as string,
        bytes: candidate.bytes as number,
        sha256: candidate.sha256 as string,
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
      contents.trimEnd() !== JSON.stringify(manifest) ||
      manifest.packId !== calculatePackId(manifest)
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

function parseCanonicalPartialMetadata(
  contents: string,
  descriptor?: NormalizedDescriptor | null,
  expectedAssetIndex?: number,
): PartialMetadata | null {
  try {
    const value = JSON.parse(contents);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'packId',
        'appBuildId',
        'ctranslate2BuildId',
        'url',
        'assetIndex',
        'fileName',
        'compressedBytes',
        'compressedSha256',
        'verifiedBytes',
        'prefixSha256',
      ]) ||
      value.schemaVersion !== 1 ||
      !isSha256(value.packId) ||
      !isSafeIdentity(value.appBuildId) ||
      !isSafeIdentity(value.ctranslate2BuildId) ||
      typeof value.url !== 'string' ||
      !isSafeHttpsUrl(value.url) ||
      !Number.isInteger(value.assetIndex) ||
      (value.assetIndex as number) < 0 ||
      (value.assetIndex as number) > 1 ||
      !isSafeDllName(value.fileName) ||
      !isBoundedByteCount(value.compressedBytes, MAX_COMPRESSED_ASSET_BYTES) ||
      !isSha256(value.compressedSha256) ||
      typeof value.verifiedBytes !== 'number' ||
      !Number.isSafeInteger(value.verifiedBytes) ||
      value.verifiedBytes < 0 ||
      value.verifiedBytes > (value.compressedBytes as number) ||
      !isSha256(value.prefixSha256)
    ) {
      return null;
    }

    if (expectedAssetIndex !== undefined && value.assetIndex !== expectedAssetIndex) {
      return null;
    }

    if (descriptor) {
      if (
        value.packId !== descriptor.packId ||
        value.appBuildId !== descriptor.appBuildId ||
        value.ctranslate2BuildId !== descriptor.ctranslate2BuildId
      ) {
        return null;
      }
      const asset = descriptor.assets[value.assetIndex as number];
      if (
        !asset ||
        value.url !== asset.url ||
        value.fileName !== asset.fileName ||
        value.compressedBytes !== asset.compressedBytes ||
        value.compressedSha256 !== asset.compressedSha256
      ) {
        return null;
      }
    }

    return value as unknown as PartialMetadata;
  } catch {
    return null;
  }
}

function parseCanonicalStageMarker(contents: string): StageMarkerRecord | null {
  try {
    const value = JSON.parse(contents);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['schemaVersion', 'stageId', 'packId', 'createdAt', 'manifest']) ||
      value.schemaVersion !== 1 ||
      typeof value.stageId !== 'string' ||
      !/^\.gpu-stage-[A-Za-z0-9_-]+$/.test(value.stageId) ||
      !isSha256(value.packId) ||
      !Number.isSafeInteger(value.createdAt)
    ) {
      return null;
    }
    const manifest = parseCanonicalPackManifest(JSON.stringify(value.manifest));
    if (!manifest || manifest.packId !== value.packId) return null;
    return { ...value, manifest } as unknown as StageMarkerRecord;
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

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === 'ESRCH') {
      return false;
    }
    return true;
  }
}

function manifestText(descriptor: NormalizedDescriptor): string {
  const manifest: PackManifest = {
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
  return `${JSON.stringify(manifest)}\n`;
}

function isStrictlyContainedInRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative !== '' &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

async function inspectManagerOwnedPackDirectory(
  directory: string,
): Promise<ManagerOwnedPackDirectory | null> {
  try {
    const directoryStats = await fs.promises.lstat(directory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return null;

    const manifestPath = path.join(directory, GPU_PACK_MANIFEST_NAME);
    const manifestContent = await readBoundedUtf8File(manifestPath);
    if (!manifestContent) return null;

    const manifest = parseCanonicalPackManifest(manifestContent);
    if (!manifest) return null;

    const expectedDirName = `gpu-pack-${manifest.packId}`;
    if (path.basename(directory) !== expectedDirName) return null;

    const entries = await fs.promises.readdir(directory);
    const expectedNames = [GPU_PACK_MANIFEST_NAME, ...manifest.files.map((file) => file.fileName)];
    if (
      entries.some((entry) => !expectedNames.includes(entry))
    ) {
      return null;
    }

    for (const entry of entries) {
      const fileStats = await fs.promises.lstat(path.join(directory, entry));
      if (!fileStats.isFile() || fileStats.isSymbolicLink()) return null;
    }

    return { directory, manifest, modifiedAt: directoryStats.mtimeMs };
  } catch {
    return null;
  }
}

async function removeOwnedPackDirectory(
  packDir: string,
  owned: ManagerOwnedPackDirectory,
): Promise<void> {
    if (path.resolve(await fs.promises.realpath(packDir)) !== path.resolve(packDir)) throw new GpuPackError('storage_failed', 'Unsafe pack target');
    const current = await inspectManagerOwnedPackDirectory(packDir);
    if (!current || current.manifest.packId !== owned.manifest.packId) throw new GpuPackError('storage_failed', 'Pack ownership changed');
    const files = [...owned.manifest.files.map((f) => f.fileName), GPU_PACK_MANIFEST_NAME];
    for (const file of files) {
      const fullPath = path.join(packDir, file);
      try {
        const stats = await fs.promises.lstat(fullPath);
        if (stats.isFile() && !stats.isSymbolicLink()) {
          await fs.promises.unlink(fullPath);
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
    }
    await fs.promises.rmdir(packDir);
}

async function inspectManagerOwnedStageDirectory(
  stageDir: string,
): Promise<{ directory: string; marker: StageMarkerRecord; entries: string[] } | null> {
  try {
    const dirStats = await fs.promises.lstat(stageDir);
    if (!dirStats.isDirectory() || dirStats.isSymbolicLink()) return null;

    const markerPath = path.join(stageDir, STAGE_MARKER_NAME);
    const markerContent = await readBoundedUtf8File(markerPath);
    if (!markerContent) return null;

    const marker = parseCanonicalStageMarker(markerContent);
    if (!marker || marker.stageId !== path.basename(stageDir)) return null;

    const entries = await fs.promises.readdir(stageDir);
    for (const entry of entries) {
      const fullPath = path.join(stageDir, entry);
      const stats = await fs.promises.lstat(fullPath);
      if (!stats.isFile() || stats.isSymbolicLink()) return null;

      const allowedNames = [STAGE_MARKER_NAME, GPU_PACK_MANIFEST_NAME,
        ...marker.manifest.files.map((file) => file.fileName),
        ...[0, 1].flatMap((index) => [`.gpu-partial-${index}.part`, `.gpu-partial-${index}.meta`]),
      ];
      const isAllowed = allowedNames.includes(entry);

      if (!isAllowed) return null;
    }

    return { directory: stageDir, marker, entries };
  } catch {
    return null;
  }
}

async function removeOwnedStageDirectory(
  stageDir: string,
  owned: { entries: string[] },
): Promise<void> {
    if (path.resolve(await fs.promises.realpath(stageDir)) !== path.resolve(stageDir)) throw new GpuPackError('storage_failed', 'Unsafe stage target');
    const current = await inspectManagerOwnedStageDirectory(stageDir);
    if (!current || JSON.stringify(current.entries) !== JSON.stringify(owned.entries)) throw new GpuPackError('storage_failed', 'Stage ownership changed');
    for (const entry of [...owned.entries.filter((entry) => entry !== STAGE_MARKER_NAME), STAGE_MARKER_NAME]) {
      const fullPath = path.join(stageDir, entry);
      try {
        const stats = await fs.promises.lstat(fullPath);
        if (stats.isFile() && !stats.isSymbolicLink()) {
          await fs.promises.unlink(fullPath);
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
    }
    await fs.promises.rmdir(stageDir);
}

async function recoverAbandonedOwnedStages(root: string, activeStagePath?: string): Promise<void> {
  try {
    let removed = 0;
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.gpu-stage-/.test(entry.name)) {
        continue;
      }
      const stageDir = path.join(root, entry.name);
      if (activeStagePath && path.resolve(stageDir) === path.resolve(activeStagePath)) continue;
      if (!isStrictlyContainedInRoot(root, stageDir)) continue;

      const owned = await inspectManagerOwnedStageDirectory(stageDir);
      if (owned) {
        await removeOwnedStageDirectory(stageDir, owned);
        if (++removed >= MAX_ABANDONED_STAGES_PER_OPERATION) break;
      }
    }
  } catch {}
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
  if (error instanceof GpuPackError) return error.code;
  if (isRecord(error) && error.code === 'ENOSPC') return 'insufficient_space';
  return 'storage_failed';
}

async function hashFile(filePath: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(filePath)) {
    const buf = toBuffer(chunk);
    bytes += buf.byteLength;
    hash.update(buf);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function hashFilePrefix(filePath: string, length: number): Promise<string> {
  const hash = createHash('sha256');
  if (length === 0) return hash.digest('hex');
  let read = 0;
  for await (const chunk of fs.createReadStream(filePath, { start: 0, end: length - 1 })) {
    const buf = toBuffer(chunk);
    const toTake = Math.min(buf.byteLength, length - read);
    if (toTake > 0) {
      hash.update(buf.subarray(0, toTake));
      read += toTake;
    }
    if (read >= length) break;
  }
  return hash.digest('hex');
}

async function isMissing(error: unknown): Promise<boolean> {
  return isRecord(error) && error.code === 'ENOENT';
}

async function writePartialMeta(
  metaPath: string,
  asset: GpuPackAssetDescriptor,
  index: number,
  verifiedBytes: number,
  prefixSha256: string,
  descriptor: NormalizedDescriptor,
): Promise<void> {
  const meta: PartialMetadata = {
    schemaVersion: 1,
    packId: descriptor.packId,
    appBuildId: descriptor.appBuildId,
    ctranslate2BuildId: descriptor.ctranslate2BuildId,
    url: asset.url,
    assetIndex: index,
    fileName: asset.fileName,
    compressedBytes: asset.compressedBytes,
    compressedSha256: asset.compressedSha256,
    verifiedBytes,
    prefixSha256,
  };
  const tmpPath = `${metaPath}.tmp-${randomUUID()}`;
  const handle = await fs.promises.open(tmpPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(meta)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(tmpPath, metaPath);
}

export function createGpuPackManager(options: GpuPackManagerOptions): GpuPackManager {
  const rootIsAbsolute = typeof options.root === 'string' && path.isAbsolute(options.root);
  const root = path.resolve(options.root);
  const descriptor = normalizeDescriptor(options.descriptor);
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const listeners = new Set<(state: GpuPackState) => void>();

  let activeOperation: 'install' | 'repair' | 'remove' | null = null;
  let inFlightPromise: Promise<GpuPackState> | null = null;

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
        // Observers cannot stop manager transitions
      }
    }
    return cloneState(next);
  };

  const packDirectory = (id?: string): string =>
    path.join(root, `gpu-pack-${id ?? descriptor!.packId}`);

  const ensureRoot = async (): Promise<void> => {
    if (!rootIsAbsolute) {
      throw new GpuPackError('storage_failed', 'GPU pack root must be absolute');
    }
    for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
      try {
        const ancestorStats = await fs.promises.lstat(ancestor);
        if (!ancestorStats.isDirectory() || ancestorStats.isSymbolicLink()) {
          throw new GpuPackError('storage_failed', 'GPU pack storage ancestry is unsafe');
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error;
      }
      if (path.dirname(ancestor) === ancestor) break;
    }
    await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
    const stats = await fs.promises.lstat(root);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GpuPackError('storage_failed', 'GPU pack root is not a regular directory');
    }
    if (path.resolve(await fs.promises.realpath(root)) !== root) {
      throw new GpuPackError('storage_failed', 'GPU pack root resolves through a link');
    }
  };

  const checkFreeDiskSpace = async (neededBytes: number): Promise<void> => {
    let freeBytes: number | null = null;
    if (options.getFreeDiskSpace) {
      try {
        freeBytes = await options.getFreeDiskSpace(root);
      } catch (error) {
        if (error instanceof GpuPackError) throw error;
        throw new GpuPackError('space_unknown', 'Could not determine available disk space', true);
      }
      if (freeBytes === null || !Number.isFinite(freeBytes) || freeBytes < 0) {
        throw new GpuPackError('space_unknown', 'Could not determine available disk space', true);
      }
    } else if (typeof fs.promises.statfs === 'function') {
      try {
        const stats = await fs.promises.statfs(root);
        const bavail = stats.bavail ?? stats.bfree;
        const bsize = stats.bsize;
        freeBytes = Number(bavail) * Number(bsize);
      } catch (error) {
        if (error instanceof GpuPackError) throw error;
        throw new GpuPackError('space_unknown', 'Could not determine available disk space', true);
      }
      if (freeBytes === null || !Number.isFinite(freeBytes) || freeBytes < 0) {
        throw new GpuPackError('space_unknown', 'Could not determine available disk space', true);
      }
    } else {
      throw new GpuPackError('space_unknown', 'Disk space probe is unavailable', true);
    }

    if (freeBytes < neededBytes) {
      throw new GpuPackError('insufficient_space', 'Insufficient disk space for GPU pack installation', true);
    }
  };

  const isPackLeased = async (targetPackId: string): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
      // Fail closed: if root cannot be read, assume pack is leased to protect files
      return true;
    }

    for (const entry of entries) {
      const match = entry.name.match(/^\.gpu-lease-([a-f0-9]{64})-(.+)\.json$/);
      if (!match) continue;
      const entryPackId = match[1];
      if (entryPackId !== targetPackId) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) return true;

      const leasePath = path.join(root, entry.name);
      try {
        const raw = await readBoundedUtf8File(leasePath);
        if (!raw) {
          // Fail closed on unreadable or oversized matching lease file
          return true;
        }
        const parsed = JSON.parse(raw);
        if (
          !isRecord(parsed) ||
          parsed.schemaVersion !== 1 ||
          parsed.packId !== entryPackId ||
          !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0 ||
          parsed.leaseId !== match[2] ||
          (parsed.serverPid !== null && (!Number.isSafeInteger(parsed.serverPid) || (parsed.serverPid as number) <= 0))
        ) {
          // Fail closed on malformed matching lease JSON
          return true;
        }

        const appAlive = isProcessAlive(parsed.pid as number);
        const serverPid = typeof parsed.serverPid === 'number' ? parsed.serverPid : null;
        const serverAlive = serverPid !== null && isProcessAlive(serverPid);

        if (appAlive || serverAlive) {
          return true;
        } else {
          // Both app and server confirmed dead -> expired lease
          try {
            await fs.promises.unlink(leasePath);
          } catch {}
        }
      } catch {
        // Fail closed on any parse / file read error for matching lease
        return true;
      }
    }
    return false;
  };

  const acquireMutationLock = async (
    operation: 'install' | 'repair' | 'remove' | 'lease',
  ): Promise<{ release: () => Promise<void> }> => {
    const lockPath = path.join(root, LOCK_FILE_NAME);
    const reclaimLockPath = path.join(root, LOCK_RECLAIM_NAME);
    const lockId = randomUUID();
    const content: MutationLockRecord = {
      schemaVersion: 1,
      lockId,
      pid: process.pid,
      createdAt: Date.now(),
      operation,
    };
    const serialized = `${JSON.stringify(content)}\n`;

    const tryCreate = async (): Promise<boolean> => {
      try {
        await fs.promises.writeFile(lockPath, serialized, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        return true;
      } catch (error) {
        if (isRecord(error) && error.code === 'EEXIST') {
          return false;
        }
        throw error;
      }
    };

    if (await tryCreate()) {
      return {
        release: async () => {
          try {
            const currentRaw = await readBoundedUtf8File(lockPath);
            if (currentRaw) {
              const currentParsed = JSON.parse(currentRaw);
              if (isRecord(currentParsed) && currentParsed.lockId === lockId) {
                await fs.promises.unlink(lockPath);
              }
            }
          } catch {}
        },
      };
    }

    // Lock file exists: inspect for stale lock
    try {
      const raw = await readBoundedUtf8File(lockPath);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          isRecord(parsed) &&
          parsed.schemaVersion === 1 &&
          Number.isSafeInteger(parsed.pid) && (parsed.pid as number) > 0 &&
          typeof parsed.lockId === 'string'
        ) {
          if (!isProcessAlive(parsed.pid as number)) {
            // Reclaim lock serialization prevents races where one process unlinks another process's new lock
            let reclaimAcquired = false;
            try {
              await fs.promises.writeFile(
                reclaimLockPath,
                JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
                { encoding: 'utf8', flag: 'wx', mode: 0o600 },
              );
              reclaimAcquired = true;
            } catch (reclaimErr) {
              // Never unlink a competing recovery guard: two stale readers could
              // otherwise remove a newly acquired guard and both reclaim the lock.
              throw new GpuPackError('busy', 'GPU pack mutation lock reclamation in progress', true);
            }

            try {
              // Under reclaim lock: re-verify lockPath still contains the exact stale lockId
              const checkRaw = await readBoundedUtf8File(lockPath);
              if (checkRaw) {
                const checkParsed = JSON.parse(checkRaw);
                if (
                  isRecord(checkParsed) &&
                  checkParsed.lockId === parsed.lockId &&
                  !isProcessAlive(checkParsed.pid as number)
                ) {
                  await fs.promises.unlink(lockPath);
                  if (await tryCreate()) {
                    return {
                      release: async () => {
                        try {
                          const currentRaw = await readBoundedUtf8File(lockPath);
                          if (currentRaw) {
                            const currentParsed = JSON.parse(currentRaw);
                            if (isRecord(currentParsed) && currentParsed.lockId === lockId) {
                              await fs.promises.unlink(lockPath);
                            }
                          }
                        } catch {}
                      },
                    };
                  }
                }
              }
            } finally {
              if (reclaimAcquired) {
                try {
                  await fs.promises.unlink(reclaimLockPath);
                } catch {}
              }
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof GpuPackError) throw err;
    }

    throw new GpuPackError('busy', 'GPU pack mutation is in progress', true);
  };

  const verifyPackDirectory = async (
    directory: string,
    customDescriptor?: NormalizedDescriptor,
  ): Promise<ExistingPackResult> => {
    const targetDesc = customDescriptor ?? descriptor;
    if (!targetDesc) return 'invalid';

    let directoryStats: fs.Stats;
    try {
      directoryStats = await fs.promises.lstat(directory);
    } catch (error) {
      return (await isMissing(error)) ? 'missing' : 'invalid';
    }
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return 'invalid';

    try {
      const entries = await fs.promises.readdir(directory);
      const expectedNames = [
        GPU_PACK_MANIFEST_NAME,
        ...targetDesc.assets.map((asset) => asset.fileName),
      ];
      if (
        entries.length !== expectedNames.length ||
        entries.some((entry) => !expectedNames.includes(entry))
      ) {
        return 'invalid';
      }

      const manifestPath = path.join(directory, GPU_PACK_MANIFEST_NAME);
      const manifestStats = await fs.promises.lstat(manifestPath);
      if (!manifestStats.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > MAX_METADATA_BYTES) {
        return 'invalid';
      }
      const manifestContent = await fs.promises.readFile(manifestPath, 'utf8');
      if (manifestContent !== manifestText(targetDesc)) {
        return 'invalid';
      }

      for (const asset of targetDesc.assets) {
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

        if (await isPackLeased(candidate.manifest.packId)) {
          continue;
        }

        const latest = await inspectManagerOwnedPackDirectory(candidate.directory);
        if (!latest) continue;
        if (!keptValidatedPrior && (await isValidatedRetainedPack(latest))) {
          keptValidatedPrior = true;
          continue;
        }

        const beforeRemove = await inspectManagerOwnedPackDirectory(candidate.directory);
        if (!beforeRemove || path.basename(beforeRemove.directory) === currentDirectoryName) {
          continue;
        }
        if (!isStrictlyContainedInRoot(root, beforeRemove.directory)) {
          continue;
        }

        await removeOwnedPackDirectory(beforeRemove.directory, beforeRemove);
      }
    } catch {}
  };

  const setVerifiedState = async (): Promise<GpuPackState> => {
    if (unavailableCode) return setState({ status: 'unavailable', code: unavailableCode });
    if (activeOperation !== null) return cloneState(state);

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

  const inspectExistingPartial = async (
    targetDir: string,
    asset: GpuPackAssetDescriptor,
    index: number,
  ): Promise<{ partPath: string; metaPath: string; verifiedBytes: number }> => {
    try {
      const entries = await fs.promises.readdir(targetDir);
      const candidateMetas: string[] = [];

      for (const entry of entries) {
        if (
          new RegExp(`^\\.gpu-partial-${index}(-[a-zA-Z0-9_-]+)?\\.meta$`).test(entry) ||
          new RegExp(`^asset-${index}(-[a-zA-Z0-9_-]+)?\\.meta$`).test(entry)
        ) {
          candidateMetas.push(entry);
        }
      }

      interface ValidCandidate {
        partPath: string;
        metaPath: string;
        verifiedBytes: number;
      }

      const validCandidates: ValidCandidate[] = [];

      for (const metaFileName of candidateMetas) {
        const metaPath = path.join(targetDir, metaFileName);
        const metaContent = await readBoundedUtf8File(metaPath);
        if (!metaContent) continue;

        const meta = parseCanonicalPartialMetadata(metaContent, descriptor, index);
        if (!meta) continue;

        const partFileName = metaFileName.slice(0, -5) + '.part';
        const partPath = path.join(targetDir, partFileName);

        try {
          const partStats = await fs.promises.lstat(partPath);
          if (!partStats.isFile() || partStats.isSymbolicLink() || partStats.size < meta.verifiedBytes) {
            continue;
          }

          const prefixHash = await hashFilePrefix(partPath, meta.verifiedBytes);
          if (prefixHash !== meta.prefixSha256) {
            // DO NOT truncate if prefix hash does not match! Leave untouched!
            continue;
          }

          validCandidates.push({
            partPath,
            metaPath,
            verifiedBytes: meta.verifiedBytes,
          });
        } catch {}
      }

      if (validCandidates.length > 0) {
        // Pick candidate with highest verifiedBytes
        validCandidates.sort((a, b) => b.verifiedBytes - a.verifiedBytes);
        const best = validCandidates[0]!;

        // Now that prefix is cryptographically verified to match, truncate part file if size > verifiedBytes
        const partStats = await fs.promises.lstat(best.partPath);
        if (partStats.size > best.verifiedBytes) {
          const handle = await fs.promises.open(best.partPath, 'r+');
          try {
            await handle.truncate(best.verifiedBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }

        return best;
      }
    } catch {}

    // No valid candidate found. Choose default canonical filenames.
    const standardPartName = `.gpu-partial-${index}.part`;
    const standardMetaName = `.gpu-partial-${index}.meta`;
    const standardPartPath = path.join(targetDir, standardPartName);
    const standardMetaPath = path.join(targetDir, standardMetaName);

    let standardPartExists = false;
    let standardMetaExists = false;
    try {
      await fs.promises.lstat(standardPartPath);
      standardPartExists = true;
    } catch {}
    try {
      await fs.promises.lstat(standardMetaPath);
      standardMetaExists = true;
    } catch {}

    if (!standardPartExists && !standardMetaExists) {
      return {
        partPath: standardPartPath,
        metaPath: standardMetaPath,
        verifiedBytes: 0,
      };
    }

    // Standard path occupied by unowned or malformed file. Pick fresh alternative.
    const freshId = randomUUID().slice(0, 8);
    return {
      partPath: path.join(targetDir, `.gpu-partial-${index}-${freshId}.part`),
      metaPath: path.join(targetDir, `.gpu-partial-${index}-${freshId}.meta`),
      verifiedBytes: 0,
    };
  };

  const downloadAssetRange = async (
    asset: GpuPackAssetDescriptor,
    partPath: string,
    metaPath: string,
    index: number,
    initialVerifiedBytes: number,
    controller: AbortController,
    receivedBefore: number,
    onProgress: (received: number, force?: boolean) => void,
  ): Promise<number> => {
    let verifiedBytes = initialVerifiedBytes;
    let idleTimeout: ReturnType<typeof setTimeout> | null = null;
    let fileHandle: fs.promises.FileHandle | null = null;
    let response: Response | null = null;
    let writeOffset = verifiedBytes;
    let lastProgressAt = 0;
    let lastCheckpointOffset = verifiedBytes;
    let isResumed = false;
    const overallTimer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

    const resetIdleTimeout = () => {
      if (idleTimeout) clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    };

    try {
      resetIdleTimeout();

      if (initialVerifiedBytes === 0) {
        const existingMetaText = await readBoundedUtf8File(metaPath);
        const existingMeta = existingMetaText
          ? parseCanonicalPartialMetadata(existingMetaText, descriptor, index) : null;
        if (!existingMeta || existingMeta.verifiedBytes !== 0) {
          const initialFile = await fs.promises.open(partPath, 'wx', 0o600);
          await initialFile.close();
        }
        await writePartialMeta(metaPath, asset, index, 0, createHash('sha256').digest('hex'), descriptor!);
      }

      let stream: AsyncIterable<Uint8Array>;
      if (options.source) {
        stream = await options.source(asset.url, controller.signal);
        if (verifiedBytes > 0) {
          verifiedBytes = 0;
          writeOffset = 0;
        }
      } else {
        const headers: Record<string, string> = {
          'accept-encoding': 'identity',
        };
        if (verifiedBytes > 0) {
          headers['Range'] = `bytes=${verifiedBytes}-${asset.compressedBytes - 1}`;
        }

        try {
          response = await fetchImpl(asset.url, {
            signal: controller.signal,
            headers,
          });
        } catch (err) {
          if (err instanceof GpuPackError) throw err;
          throw new GpuPackError('download_failed', 'Network request failed: ' + String(err));
        }

        resetIdleTimeout();

        const encoding = response.headers.get('content-encoding');
        if (encoding && encoding.toLowerCase() !== 'identity') {
          throw new GpuPackError('download_failed', `Unexpected content-encoding: ${encoding}`);
        }

        const contentLengthHeader = response.headers.get('content-length');
        let contentLength: number | null = null;
        if (contentLengthHeader !== null) {
          const parsed = /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : NaN;
          if (!Number.isSafeInteger(parsed) || parsed < 0) {
            throw new GpuPackError('download_failed', 'Malformed Content-Length header');
          }
          contentLength = parsed;
        }

        if (verifiedBytes > 0 && response.status === 416) {
          // Safe 416 retry: request full file from 0
          if (response.body && !response.body.locked) {
            try { await response.body.cancel(); } catch {}
          }
          verifiedBytes = 0;
          writeOffset = 0;
          const handle = await fs.promises.open(partPath, 'w');
          await handle.close();

          try {
            response = await fetchImpl(asset.url, {
              signal: controller.signal,
              headers: { 'accept-encoding': 'identity' },
            });
          } catch (err) {
            if (err instanceof GpuPackError) throw err;
            throw new GpuPackError('download_failed', 'Network request failed: ' + String(err));
          }

          resetIdleTimeout();
          if (response.status !== 200) {
            throw new GpuPackError('download_failed', `Download retry failed with HTTP ${response.status}`);
          }
          const retryEncoding = response.headers.get('content-encoding');
          if (retryEncoding && retryEncoding.toLowerCase() !== 'identity') {
            throw new GpuPackError('download_failed', `Unexpected content-encoding: ${retryEncoding}`);
          }
          const retryLengthHeader = response.headers.get('content-length');
          if (retryLengthHeader !== null) {
            const parsed = /^\d+$/.test(retryLengthHeader) ? Number(retryLengthHeader) : NaN;
            if (parsed !== asset.compressedBytes) {
              throw new GpuPackError('download_failed', 'Content-Length does not match compressed asset size');
            }
          }
          isResumed = false;
        } else if (verifiedBytes > 0 && response.status === 200) {
          // Safe restart from 0
          if (contentLength !== null && contentLength !== asset.compressedBytes) {
            throw new GpuPackError('download_failed', 'Content-Length does not match compressed asset size');
          }
          verifiedBytes = 0;
          writeOffset = 0;
          const handle = await fs.promises.open(partPath, 'w');
          await handle.close();
          isResumed = false;
        } else if (verifiedBytes > 0 && response.status === 206) {
          const contentRange = response.headers.get('content-range') ?? '';
          const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
          if (!match) {
            throw new GpuPackError('download_failed', 'Malformed Content-Range header from server');
          }
          const rangeStart = parseInt(match[1]!, 10);
          const rangeEnd = parseInt(match[2]!, 10);
          const rangeTotal = parseInt(match[3]!, 10);
          if (
            rangeStart !== verifiedBytes ||
            rangeEnd !== asset.compressedBytes - 1 ||
            rangeTotal !== asset.compressedBytes
          ) {
            throw new GpuPackError('download_failed', 'Strict Content-Range bounds mismatch');
          }
          if (contentLength !== null && contentLength !== asset.compressedBytes - verifiedBytes) {
            throw new GpuPackError('download_failed', 'Content-Length does not match remaining asset size');
          }
          isResumed = true;
        } else if (verifiedBytes === 0) {
          if (response.status === 200) {
            if (contentLength !== null && contentLength !== asset.compressedBytes) {
              throw new GpuPackError('download_failed', 'Content-Length does not match compressed asset size');
            }
            isResumed = false;
          } else if (response.status === 206) {
            const contentRange = response.headers.get('content-range') ?? '';
            const match = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
            if (!match) {
              throw new GpuPackError('download_failed', 'Malformed Content-Range header from server');
            }
            const rangeStart = parseInt(match[1]!, 10);
            const rangeEnd = parseInt(match[2]!, 10);
            const rangeTotal = parseInt(match[3]!, 10);
            if (
              rangeStart !== 0 ||
              rangeEnd !== asset.compressedBytes - 1 ||
              rangeTotal !== asset.compressedBytes
            ) {
              throw new GpuPackError('download_failed', 'Strict Content-Range bounds mismatch');
            }
            if (contentLength !== null && contentLength !== asset.compressedBytes) {
              throw new GpuPackError('download_failed', 'Content-Length does not match compressed asset size');
            }
            isResumed = false;
          } else {
            throw new GpuPackError('download_failed', `Download failed with HTTP ${response.status}`);
          }
        } else {
          throw new GpuPackError('download_failed', `Download failed with HTTP ${response.status}`);
        }

        if (!response.body) {
          throw new GpuPackError('download_failed', 'Response body was empty');
        }

        stream = Readable.fromWeb(response.body as any) as Readable & AsyncIterable<Uint8Array>;
      }

      await checkFreeDiskSpace(asset.compressedBytes - verifiedBytes + BOUNDED_TEMP_METADATA_BYTES + SAFETY_MARGIN_BYTES);
      fileHandle = await fs.promises.open(
        partPath,
        verifiedBytes > 0 && isResumed ? 'a' : 'r+',
        0o600,
      );
      if (verifiedBytes === 0) await fileHandle.truncate(0);
      onProgress(receivedBefore + writeOffset, true);

      // Running prefix hash from offset 0
      const runningHash = createHash('sha256');
      if (verifiedBytes > 0 && isResumed) {
        for await (const chunk of fs.createReadStream(partPath, { start: 0, end: verifiedBytes - 1 })) {
          runningHash.update(toBuffer(chunk));
        }
      }

      for await (const chunk of stream) {
        const buf = toBuffer(chunk);
        if (writeOffset + buf.byteLength > asset.compressedBytes) {
          throw new GpuPackError('integrity_failed', 'Compressed GPU asset exceeded its pinned size');
        }

        let written = 0;
        while (written < buf.byteLength) {
          try {
            const res = await fileHandle.write(buf, written, buf.byteLength - written);
            if (res.bytesWritten <= 0) throw new GpuPackError('storage_failed', 'Download write made no progress');
            written += res.bytesWritten;
          } catch (err) {
            if (isRecord(err) && err.code === 'ENOSPC') {
              throw new GpuPackError('insufficient_space', 'Disk space exhausted during download', true);
            }
            throw err;
          }
        }

        runningHash.update(buf);
        writeOffset += buf.byteLength;
        resetIdleTimeout();

        if (writeOffset - lastCheckpointOffset >= CHECKPOINT_INTERVAL_BYTES) {
          await fileHandle.sync();
          const prefixSha256 = runningHash.copy().digest('hex');
          await writePartialMeta(metaPath, asset, index, writeOffset, prefixSha256, descriptor!);
          lastCheckpointOffset = writeOffset;
        }

        const now = Date.now();
        if (now - lastProgressAt >= MAX_PROGRESS_INTERVAL_MS) {
          lastProgressAt = now;
          onProgress(receivedBefore + writeOffset);
        }
      }

      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = null;

      if (writeOffset !== asset.compressedBytes) {
        const currentHash = runningHash.copy().digest('hex');
        await writePartialMeta(metaPath, asset, index, writeOffset, currentHash, descriptor!);
        throw new GpuPackError('download_failed', 'Download ended prematurely');
      }

      const finalHash = runningHash.digest('hex');
      if (finalHash !== asset.compressedSha256) {
        throw new GpuPackError('integrity_failed', 'Compressed GPU asset failed pinned integrity checks');
      }

      // Checkpoint complete metadata and retain it
      await writePartialMeta(metaPath, asset, index, asset.compressedBytes, finalHash, descriptor!);
      onProgress(receivedBefore + writeOffset, true);
      return writeOffset;
    } catch (error) {
      if (fileHandle) {
        try {
          await fileHandle.sync();
          await fileHandle.close();
        } catch {}
        fileHandle = null;
      }

      if (writeOffset > 0 && writeOffset < asset.compressedBytes) {
        try {
          const currentHash = await hashFilePrefix(partPath, writeOffset);
          await writePartialMeta(metaPath, asset, index, writeOffset, currentHash, descriptor!);
        } catch {}
      }

      if (error instanceof GpuPackError) throw error;
      if (isRecord(error) && error.code === 'ENOSPC') {
        throw new GpuPackError('insufficient_space', 'Disk space exhausted during download', true);
      }
      throw new GpuPackError('download_failed', 'GPU asset download failed: ' + String(error));
    } finally {
      clearTimeout(overallTimer);
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = null;
      }
      if (response?.body && !response.body.locked) {
        try {
          await response.body.cancel();
        } catch {}
      }
      if (fileHandle) {
        try {
          await fileHandle.sync();
          await fileHandle.close();
        } catch {}
        fileHandle = null;
      }
    }
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
      if (isRecord(error) && error.code === 'ENOSPC') {
        throw new GpuPackError('insufficient_space', 'Disk space exhausted during decompression', true);
      }
      throw new GpuPackError('integrity_failed', 'Brotli GPU asset could not be validated');
    }

    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw new GpuPackError('integrity_failed', 'Decompressed GPU asset failed pinned integrity checks');
    }
  };

  const performInstall = async (): Promise<GpuPackState> => {
    if (unavailableCode) return setState({ status: 'unavailable', code: unavailableCode });

    let stagePath: string | null = null;
    let lock: { release: () => Promise<void> } | null = null;
    const controller = new AbortController();

    try {
      await ensureRoot();
      lock = await acquireMutationLock('install');

      const existing = await verifyPackDirectory(packDirectory());
      if (existing === 'valid') {
        await pruneOldPackDirectories();
        return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
      }

      await recoverAbandonedOwnedStages(root);

      const destination = packDirectory();
      let destinationStats: fs.Stats | null = null;
      try {
        destinationStats = await fs.promises.lstat(destination);
      } catch {}

      if (destinationStats) {
        const ownedExisting = await inspectManagerOwnedPackDirectory(destination);
        if (!ownedExisting) {
          return setState({ status: 'failed', code: 'pack_invalid', retryable: true });
        }
        if (await isPackLeased(descriptor!.packId)) {
          return setState({ status: 'failed', code: 'busy', retryable: true });
        }
      }

      stagePath = path.join(root, `.gpu-stage-${randomUUID()}`);
      await fs.promises.mkdir(stagePath, { mode: 0o700 });

      const marker: StageMarkerRecord = {
        schemaVersion: 1,
        stageId: path.basename(stagePath),
        packId: descriptor!.packId,
        createdAt: Date.now(),
        manifest: JSON.parse(manifestText(descriptor!)),
      };
      await fs.promises.writeFile(
        path.join(stagePath, STAGE_MARKER_NAME),
        `${JSON.stringify(marker)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );

      const partialDir = options.source ? stagePath : root;
      const partialInfos: { partPath: string; metaPath: string; verifiedBytes: number }[] = [];
      let remainingCompressedBytes = 0;

      for (const [index, asset] of descriptor!.assets.entries()) {
        const info = await inspectExistingPartial(partialDir, asset, index);
        partialInfos.push(info);
        const remainingForAsset = Math.max(0, asset.compressedBytes - info.verifiedBytes);
        remainingCompressedBytes += remainingForAsset;
      }

      const stagedRaw = descriptor!.assets.reduce((sum, a) => sum + a.bytes, 0);
      const totalSpaceRequired =
        remainingCompressedBytes + stagedRaw + BOUNDED_TEMP_METADATA_BYTES + SAFETY_MARGIN_BYTES;
      await checkFreeDiskSpace(totalSpaceRequired);

      let receivedBytes = 0;
      setState({
        status: 'downloading',
        packId: descriptor!.packId,
        receivedBytes,
        totalBytes: descriptor!.downloadBytes,
      });

      const compressedPaths: string[] = [];
      for (const [index, asset] of descriptor!.assets.entries()) {
        const info = partialInfos[index]!;
        compressedPaths.push(info.partPath);

        if (info.verifiedBytes === asset.compressedBytes) {
          const full = await hashFile(info.partPath);
          if (full.bytes === asset.compressedBytes && full.sha256 === asset.compressedSha256) {
            receivedBytes += asset.compressedBytes;
            setState({
              status: 'downloading',
              packId: descriptor!.packId,
              receivedBytes,
              totalBytes: descriptor!.downloadBytes,
            });
            continue;
          }
        }

        const downloaded = await downloadAssetRange(
          asset,
          info.partPath,
          info.metaPath,
          index,
          info.verifiedBytes,
          controller,
          receivedBytes,
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
              for (const listener of listeners) {
                try {
                  listener(cloneState(state));
                } catch {}
              }
            }
          },
        );
        receivedBytes += downloaded; }

      setState({ status: 'validating', packId: descriptor!.packId });

      for (const [index, asset] of descriptor!.assets.entries()) {
        const compressedPath = compressedPaths[index];
        if (!compressedPath) throw new GpuPackError('storage_failed', 'Staged asset was not found');

        await checkFreeDiskSpace(asset.bytes + SAFETY_MARGIN_BYTES);

        await decompressAsset(
          compressedPath,
          path.join(stagePath, asset.fileName),
          asset,
        );

        if (partialDir === stagePath) {
          try { await fs.promises.unlink(compressedPath); } catch {}
          const metaPath = partialInfos[index]?.metaPath;
          if (metaPath) {
            try { await fs.promises.unlink(metaPath); } catch {}
          }
        }
      }

      await fs.promises.writeFile(
        path.join(stagePath, GPU_PACK_MANIFEST_NAME),
        manifestText(descriptor!),
        {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        },
      );

      try {
        await fs.promises.unlink(path.join(stagePath, STAGE_MARKER_NAME));
      } catch {}

      const staged = await verifyPackDirectory(stagePath);
      if (staged !== 'valid') {
        throw new GpuPackError('integrity_failed', 'Staged GPU pack failed validation');
      }

      const existingAtPublish = await verifyPackDirectory(destination);
      if (existingAtPublish === 'valid') {
        await pruneOldPackDirectories();
        return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
      }

      if (existingAtPublish === 'invalid') {
        const ownedAtPublish = await inspectManagerOwnedPackDirectory(destination);
        if (!ownedAtPublish) {
          throw new GpuPackError('pack_invalid', 'Existing directory at destination is not manager-owned', true);
        }
        if (await isPackLeased(descriptor!.packId)) {
          throw new GpuPackError('busy', 'Pack is currently leased by active process', true);
        }
        await removeOwnedPackDirectory(destination, ownedAtPublish);
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

      // Cleanup compressed assets and metadata now that publication succeeded
      for (const info of partialInfos) {
        try { await fs.promises.unlink(info.partPath); } catch {}
        try { await fs.promises.unlink(info.metaPath); } catch {}
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
          const owned = await inspectManagerOwnedStageDirectory(stagePath);
          if (owned) {
            await removeOwnedStageDirectory(stagePath, owned);
          }
        } catch {}
      }
      if (lock) {
        await lock.release();
      }
    }
  };

  const performRepair = async (): Promise<GpuPackState> => {
    if (unavailableCode) return setState({ status: 'unavailable', code: unavailableCode });

    let lock: { release: () => Promise<void> } | null = null;
    try {
      await ensureRoot();
      lock = await acquireMutationLock('repair');

      const destination = packDirectory();
      const existing = await verifyPackDirectory(destination);
      if (existing === 'valid') {
        return setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });
      }

      if (await isPackLeased(descriptor!.packId)) {
        return setState({ status: 'failed', code: 'busy', retryable: true });
      }

      let destStats: fs.Stats | null = null;
      try {
        destStats = await fs.promises.lstat(destination);
      } catch {}

      if (destStats) {
        const owned = await inspectManagerOwnedPackDirectory(destination);
        if (!owned) {
          return setState({ status: 'failed', code: 'pack_invalid', retryable: true });
        }
      }

      await lock.release();
      lock = null;

      return await performInstall();
    } catch (error) {
      const code = errorCode(error);
      const retryable = error instanceof GpuPackError ? error.retryable : true;
      return setState({ status: 'failed', code, retryable });
    } finally {
      if (lock) {
        await lock.release();
      }
    }
  };

  const performRemove = async (): Promise<GpuPackState> => {
    if (unavailableCode) return setState({ status: 'unavailable', code: unavailableCode });

    let lock: { release: () => Promise<void> } | null = null;
    try {
      await ensureRoot();
      lock = await acquireMutationLock('remove');

      if (await isPackLeased(descriptor!.packId)) {
        return setState({ status: 'failed', code: 'busy', retryable: true });
      }

      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      // Removal is all-or-deferred when any identified component pack is in use.
      for (const entry of entries) {
        if (/^gpu-pack-[a-f0-9]{64}$/.test(entry.name) &&
            await isPackLeased(entry.name.slice('gpu-pack-'.length))) {
          return setState({ status: 'failed', code: 'busy', retryable: true });
        }
      }
      for (const entry of entries) {
        const fullPath = path.join(root, entry.name);
        if (!isStrictlyContainedInRoot(root, fullPath) || entry.isSymbolicLink()) continue;

        if (entry.isDirectory()) {
          // 1. Pack directories: gpu-pack-<sha256>
          if (/^gpu-pack-[a-f0-9]{64}$/.test(entry.name)) {
            const packId = entry.name.slice('gpu-pack-'.length);
            if (!(await isPackLeased(packId))) {
              const inspected = await inspectManagerOwnedPackDirectory(fullPath);
              if (inspected) {
                await removeOwnedPackDirectory(fullPath, inspected);
              }
            }
          }
          // 2. Stage directories: .gpu-stage-<uuid> (only if verified owned!)
          else if (/^\.gpu-stage-/.test(entry.name)) {
            const ownedStage = await inspectManagerOwnedStageDirectory(fullPath);
            if (ownedStage) {
              await removeOwnedStageDirectory(fullPath, ownedStage);
            }
          }
        } else if (entry.isFile()) {
          // 3. Stale leases
          if (/^\.gpu-lease-([a-f0-9]{64})-(.+)\.json$/.test(entry.name)) {
            try {
              const raw = await readBoundedUtf8File(fullPath);
              if (raw) {
                const leaseData = JSON.parse(raw);
                if (
                  isRecord(leaseData) &&
                  leaseData.schemaVersion === 1 &&
                  typeof leaseData.pid === 'number'
                ) {
                  const appAlive = isProcessAlive(leaseData.pid);
                  const serverAlive =
                    typeof leaseData.serverPid === 'number' && isProcessAlive(leaseData.serverPid);
                  if (!appAlive && !serverAlive) {
                    await fs.promises.unlink(fullPath);
                  }
                }
              }
            } catch {}
          }
          // 4. Owned partials
          else if (
            /^(?:\.gpu-partial|asset)-[01](?:-[a-zA-Z0-9_-]+)?\.meta$/.test(entry.name)
          ) {
            try {
              const raw = await readBoundedUtf8File(fullPath);
              if (raw) {
                const indexMatch = entry.name.match(/^(?:\.gpu-partial|asset)-([01])/);
                const meta = parseCanonicalPartialMetadata(raw, undefined, Number(indexMatch?.[1]));
                if (meta) {
                  const matchingPart = fullPath.slice(0, -5) + '.part';
                  try {
                    const partStats = await fs.promises.lstat(matchingPart);
                    if (partStats.isFile() && !partStats.isSymbolicLink() &&
                        partStats.size >= meta.verifiedBytes && partStats.size <= meta.compressedBytes &&
                        await hashFilePrefix(matchingPart, meta.verifiedBytes) === meta.prefixSha256) {
                      await fs.promises.unlink(matchingPart);
                      await fs.promises.unlink(fullPath);
                    }
                  } catch {}
                }
              }
            } catch {}
          }
        }
      }

      return setState({
        status: 'missing',
        packId: descriptor!.packId,
        downloadBytes: descriptor!.downloadBytes,
      });
    } catch (error) {
      const code = errorCode(error);
      const retryable = error instanceof GpuPackError ? error.retryable : true;
      return setState({ status: 'failed', code, retryable });
    } finally {
      if (lock) {
        await lock.release();
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
      if (inFlightPromise) {
        if (activeOperation === 'install') return inFlightPromise;
        return Promise.resolve({ status: 'failed', code: 'busy', retryable: true });
      }
      activeOperation = 'install';
      const attempt = performInstall().finally(() => {
        activeOperation = null;
        inFlightPromise = null;
      });
      inFlightPromise = attempt;
      return attempt;
    },
    repair() {
      if (inFlightPromise) {
        return Promise.resolve({ status: 'failed', code: 'busy', retryable: true });
      }
      activeOperation = 'repair';
      const attempt = performRepair().finally(() => {
        activeOperation = null;
        inFlightPromise = null;
      });
      inFlightPromise = attempt;
      return attempt;
    },
    remove() {
      if (inFlightPromise) {
        return Promise.resolve({ status: 'failed', code: 'busy', retryable: true });
      }
      activeOperation = 'remove';
      const attempt = performRemove().finally(() => {
        activeOperation = null;
        inFlightPromise = null;
      });
      inFlightPromise = attempt;
      return attempt;
    },
    async getValidatedRuntime() {
      if (unavailableCode) {
        setState({ status: 'unavailable', code: unavailableCode });
        return null;
      }
      if (activeOperation !== null) {
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
    async acquireRuntime() {
      if (unavailableCode) {
        setState({ status: 'unavailable', code: unavailableCode });
        return null;
      }
      if (activeOperation !== null) {
        return null;
      }

      let lock: { release: () => Promise<void> } | null = null;
      try {
        await ensureRoot();
        try {
          lock = await acquireMutationLock('lease');
        } catch {
          return null;
        }

        if ((await verifyPackDirectory(packDirectory())) !== 'valid') {
          await setVerifiedState();
          return null;
        }
        setState({ status: 'ready', packId: descriptor!.packId, restartRequired: true });

        const leaseId = randomUUID();
        const leaseFileName = `.gpu-lease-${descriptor!.packId}-${leaseId}.json`;
        const leasePath = path.join(root, leaseFileName);
        const leaseData: RuntimeLeaseRecord = {
          schemaVersion: 1,
          packId: descriptor!.packId,
          leaseId,
          pid: process.pid,
          serverPid: null,
          createdAt: Date.now(),
        };

        await fs.promises.writeFile(leasePath, `${JSON.stringify(leaseData)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });

        const runtime: ValidatedGpuRuntime = Object.freeze({
          directory: packDirectory(),
          packId: descriptor!.packId,
          appBuildId: descriptor!.appBuildId,
          ctranslate2BuildId: descriptor!.ctranslate2BuildId,
          [validatedRuntimeBrand]: true as const,
        });

        let released = false;
        let leaseWrites: Promise<void> = Promise.resolve();

        return {
          runtime,
          async bindServerPid(serverPid: number): Promise<void> {
            if (released) throw new Error('Runtime lease has been released');
            if (!Number.isSafeInteger(serverPid) || serverPid <= 0) {
              throw new Error('Invalid server PID');
            }
            const write = leaseWrites.then(async () => {
              leaseData.serverPid = serverPid;
              const tmpPath = path.join(root, `${leaseFileName}.tmp-${randomUUID()}`);
              await fs.promises.writeFile(tmpPath, `${JSON.stringify(leaseData)}\n`, {
                encoding: 'utf8', flag: 'wx', mode: 0o600,
              });
              await fs.promises.rename(tmpPath, leasePath);
            });
            leaseWrites = write.catch(() => {});
            await write;
          },
          async release(): Promise<void> {
            released = true;
            await leaseWrites;
            try {
              await fs.promises.unlink(leasePath);
            } catch {}
          },
        };
      } catch {
        setState({ status: 'failed', code: 'storage_failed', retryable: true });
        return null;
      } finally {
        if (lock) {
          await lock.release();
        }
      }
    },
  };
}
