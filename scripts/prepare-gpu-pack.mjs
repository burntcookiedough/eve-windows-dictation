#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  constants as zlibConstants,
  createBrotliCompress,
  createBrotliDecompress,
} from 'node:zlib';

const OFFICIAL_MANIFEST_URL = 'https://developer.download.nvidia.com/compute/cuda/redist/redistrib_12.9.1.json';
const NVIDIA_ARCHIVE_NAME = 'libcublas-windows-x86_64-12.9.1.4-archive.zip';
const NVIDIA_ARCHIVE_URL = 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/windows-x86_64/libcublas-windows-x86_64-12.9.1.4-archive.zip';
const NVIDIA_ARCHIVE_BYTES = 549_755_186;
const NVIDIA_ARCHIVE_SHA256 = 'd534d98b0b453a98914dbf3adf47d7e84b55037abf02f87466439e1dcef581ed';
const NVIDIA_EULA_URL = 'https://developer.download.nvidia.com/compute/cuda/redist/libcublas/LICENSE.txt';
const NVIDIA_EULA_PAGE = 'https://docs.nvidia.com/cuda/archive/12.9.1/eula/index.html';
const PLATFORM = 'win32-x64';
const SCHEMA_VERSION = 1;

const assets = [
  {
    fileName: 'cublas64_12.dll',
    bytes: 102_518_272,
    sha256: '90052a83efd1b57a8e3616a6590b335855f81b814a4f16eecb7b5bf6d1b1d4eb',
    compressedFileName: 'cublas64_12.dll.br',
    compressedBytes: 68_190_827,
    compressedSha256: 'bf44b669968ee3e660579fb0a8e436b809e075f07d3b296b017f4ca559752528',
  },
  {
    fileName: 'cublasLt64_12.dll',
    bytes: 668_669_952,
    sha256: 'c3a05ea244c937314afec09f87b91f814c7e27977681f6c67eb51bb06ced3a4a',
    compressedFileName: 'cublasLt64_12.dll.br',
    compressedBytes: 426_759_202,
    compressedSha256: '6b73b5a5125812b4b0be61ce2dfa183baac6451097ebd07466c9d264e01a446d',
  },
];

const usage = `Usage:
  node scripts/prepare-gpu-pack.mjs --archive <verified NVIDIA ZIP> --output <new directory outside the repository and user profile> --app-build-id <Eve version> --ctranslate2-build-id <pinned CTranslate2 identity>

The command validates the official CUDA 12.9.1 archive, extracts only the two named cuBLAS DLL entries into a temporary staging directory, and writes Brotli quality-5 candidate assets plus an unpublished descriptor draft. It never edits application source or uploads files.

Example:
  node scripts/prepare-gpu-pack.mjs --archive E:\\eve-cuda-12.9.1-cublas.zip --output E:\\eve-alpha6-gpu-pack-candidate --app-build-id 0.8.2-alpha.6 --ctranslate2-build-id ctranslate2-4.6.3-cp311-cp311-win_amd64-sha256:fa2f3dcda893a3f4dedeb32b5059e4085738934d93ea8dccdce4bbef2be5d3dc`;

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help' || key === '-h') return { help: true };
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key ?? ''}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Argument repeated: ${key}`);
    values.set(key, value);
    index += 1;
  }
  return {
    archive: values.get('--archive'),
    output: values.get('--output'),
    appBuildId: values.get('--app-build-id'),
    ctranslate2BuildId: values.get('--ctranslate2-build-id'),
    help: false,
  };
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertOutsideSensitiveRoots(label, candidatePath, repositoryRoot) {
  const normalized = path.resolve(candidatePath);
  const roots = [repositoryRoot, os.homedir()].map((root) => path.resolve(root));
  for (const root of roots) {
    if (isPathInside(root, normalized)) {
      throw new Error(`${label} must be outside the repository and the user profile`);
    }
  }
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function assertRegularFile(filePath, label) {
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch {
    throw new Error(`${label} was not found`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
}

async function assertFreshOutputLocation(outputDir) {
  let parentStats;
  try {
    parentStats = await fs.lstat(path.dirname(outputDir));
  } catch {
    throw new Error('The output parent directory must already exist');
  }
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error('The output parent must be a regular directory');
  }
  try {
    await fs.lstat(outputDir);
    throw new Error('The output directory already exists; choose a new, empty path');
  } catch (error) {
    if (error instanceof Error && error.message.includes('already exists')) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function extractNamedEntries(archivePath, rawDir) {
  const expected = assets.map(({ fileName, bytes }) => ({ fileName, bytes }));
  const serializedExpected = JSON.stringify(expected);
  const powershellScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archivePath = $env:EVE_GPU_PACK_ARCHIVE
$rawDirectory = $env:EVE_GPU_PACK_RAW_DIRECTORY
$expected = ConvertFrom-Json -InputObject $env:EVE_GPU_PACK_EXPECTED_ENTRIES
$archive = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  foreach ($wanted in $expected) {
    $matches = @($archive.Entries | Where-Object { $_.Name -ceq [string]$wanted.fileName })
    if ($matches.Count -ne 1) { throw "Expected exactly one named CUDA archive entry" }
    $entry = $matches[0]
    if ([int64]$entry.Length -ne [int64]$wanted.bytes) { throw "CUDA archive entry size mismatch" }
    $destination = Join-Path $rawDirectory ([string]$wanted.fileName)
    $inputStream = $entry.Open()
    $outputStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
  }
} finally { $archive.Dispose() }
`;

  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellScript], {
    encoding: 'utf8',
    env: {
      ...process.env,
      EVE_GPU_PACK_ARCHIVE: archivePath,
      EVE_GPU_PACK_RAW_DIRECTORY: rawDir,
      EVE_GPU_PACK_EXPECTED_ENTRIES: serializedExpected,
    },
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`Could not open the CUDA archive with Windows PowerShell: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`Could not extract the two named CUDA DLL entries${detail ? `: ${detail}` : ''}`);
  }
}

async function compressFile(sourcePath, targetPath) {
  const compressor = createBrotliCompress({
    params: {
      [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
      [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
    },
  });
  await pipeline(createReadStream(sourcePath), compressor, createWriteStream(targetPath, { flags: 'wx' }));
}

async function verifyCompressedRoundTrip(compressedPath, expectedAsset) {
  const hash = createHash('sha256');
  let bytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.byteLength;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  await pipeline(createReadStream(compressedPath), createBrotliDecompress(), verifier, sink);
  const actualHash = hash.digest('hex');
  if (bytes !== expectedAsset.bytes || actualHash !== expectedAsset.sha256) {
    throw new Error(`Brotli round-trip did not reproduce ${expectedAsset.fileName}`);
  }
}

function candidateManifest(appBuildId, ctranslate2BuildId, generatedAssets) {
  const files = generatedAssets.map(({ fileName, bytes, sha256 }) => ({ fileName, bytes, sha256 }));
  const identity = {
    schemaVersion: SCHEMA_VERSION,
    appBuildId,
    ctranslate2BuildId,
    platform: PLATFORM,
    files,
  };
  const packId = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  return {
    status: 'unpublished-candidate',
    note: 'Not a production descriptor. Asset URLs remain null until immutable hosting and distribution review are complete.',
    source: {
      archive: NVIDIA_ARCHIVE_NAME,
      archiveUrl: NVIDIA_ARCHIVE_URL,
      archiveBytes: NVIDIA_ARCHIVE_BYTES,
      archiveSha256: NVIDIA_ARCHIVE_SHA256,
      officialManifestUrl: OFFICIAL_MANIFEST_URL,
      eulaUrl: NVIDIA_EULA_PAGE,
      componentLicenseUrl: NVIDIA_EULA_URL,
    },
    packId,
    descriptorDraft: {
      schemaVersion: SCHEMA_VERSION,
      appBuildId,
      ctranslate2BuildId,
      platform: PLATFORM,
      assets: generatedAssets.map((asset) => ({
        url: null,
        compressedBytes: asset.compressedBytes,
        compressedSha256: asset.compressedSha256,
        fileName: asset.fileName,
        bytes: asset.bytes,
        sha256: asset.sha256,
      })),
    },
    generatedBy: {
      node: process.version,
      brotliQuality: 5,
      brotliMode: 'generic',
    },
    totalDownloadBytes: generatedAssets.reduce((sum, asset) => sum + asset.compressedBytes, 0),
    totalInstalledBytes: generatedAssets.reduce((sum, asset) => sum + asset.bytes, 0),
  };
}

const noticeDraft = `# Draft NVIDIA CUDA notice for the Eve GPU pack

Status: candidate notice only. Do not ship until NVIDIA distribution terms and applicable third-party attributions have been reviewed for the final delivery method.

Eve's optional Windows x64 GPU pack candidate contains NVIDIA CUDA cuBLAS 12.9.1.4 runtime files: cublas64_12.dll and cublasLt64_12.dll. NVIDIA's CUDA 12.9.1 redistributable manifest identifies the component license as CUDA Toolkit and points to libcublas/LICENSE.txt. The CUDA Toolkit EULA lists Windows cuBLAS and cuBLASLt DLLs, including filename variants, in Attachment A.

CUDA Toolkit EULA: ${NVIDIA_EULA_PAGE}
Official CUDA 12.9.1 redistributable manifest: ${OFFICIAL_MANIFEST_URL}
Official cuBLAS component license text: ${NVIDIA_EULA_URL}

This draft does not decide whether a separately hosted, user-requested pack meets the EULA's application-only access and no-standalone-product requirements. The applicable NVIDIA EULA and third-party notices must accompany the final Eve distribution in a form that meets their terms. NVIDIA does not sponsor or endorse Eve.
`;

async function buildCandidate(options) {
  if (process.platform !== 'win32') throw new Error('Run this Windows-only pack preparation script from Windows PowerShell');
  for (const [label, value] of [['--archive', options.archive], ['--output', options.output], ['--app-build-id', options.appBuildId], ['--ctranslate2-build-id', options.ctranslate2BuildId]]) {
    if (!value) throw new Error(`Required argument missing: ${label}`);
  }
  for (const [label, value] of [['app build ID', options.appBuildId], ['CTranslate2 build ID', options.ctranslate2BuildId]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`Invalid ${label}`);
  }
  if (!path.isAbsolute(options.archive) || !path.isAbsolute(options.output)) {
    throw new Error('--archive and --output must be absolute paths');
  }

  const archivePath = path.resolve(options.archive);
  const outputDir = path.resolve(options.output);
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assertOutsideSensitiveRoots('The archive', archivePath, repositoryRoot);
  assertOutsideSensitiveRoots('The output directory', outputDir, repositoryRoot);
  await assertRegularFile(archivePath, 'The CUDA archive');
  await assertFreshOutputLocation(outputDir);

  const archiveDigest = await sha256File(archivePath);
  if (archiveDigest.bytes !== NVIDIA_ARCHIVE_BYTES || archiveDigest.sha256 !== NVIDIA_ARCHIVE_SHA256) {
    throw new Error('CUDA archive size or SHA-256 does not match NVIDIA CUDA 12.9.1 manifest');
  }

  const outputParent = path.dirname(outputDir);
  const stageDir = path.join(outputParent, `.${path.basename(outputDir)}.staging-${randomUUID()}`);
  const expectedStagePrefix = `.${path.basename(outputDir)}.staging-`;
  if (path.dirname(stageDir).toLowerCase() !== outputParent.toLowerCase() || !path.basename(stageDir).startsWith(expectedStagePrefix)) {
    throw new Error('Could not establish a safe staging directory');
  }

  let stageCreated = false;
  try {
    await fs.mkdir(stageDir);
    stageCreated = true;
    const rawDir = path.join(stageDir, 'raw-source-dlls');
    await fs.mkdir(rawDir);
    await extractNamedEntries(archivePath, rawDir);

    const generatedAssets = [];
    for (const asset of assets) {
      const rawPath = path.join(rawDir, asset.fileName);
      await assertRegularFile(rawPath, 'Extracted CUDA DLL');
      const actualRaw = await sha256File(rawPath);
      if (actualRaw.bytes !== asset.bytes || actualRaw.sha256 !== asset.sha256) {
        throw new Error(`Source DLL did not match the reviewed ${asset.fileName} hash`);
      }

      const compressedPath = path.join(stageDir, asset.compressedFileName);
      await compressFile(rawPath, compressedPath);
      const actualCompressed = await sha256File(compressedPath);
      if (actualCompressed.bytes !== asset.compressedBytes || actualCompressed.sha256 !== asset.compressedSha256) {
        throw new Error(`Brotli output did not reproduce the reviewed ${asset.compressedFileName} candidate hash`);
      }
      await verifyCompressedRoundTrip(compressedPath, asset);
      generatedAssets.push({
        fileName: asset.fileName,
        bytes: actualRaw.bytes,
        sha256: actualRaw.sha256,
        compressedFileName: asset.compressedFileName,
        compressedBytes: actualCompressed.bytes,
        compressedSha256: actualCompressed.sha256,
      });
    }

    await fs.rm(rawDir, { recursive: true, force: false });
    const manifest = candidateManifest(options.appBuildId, options.ctranslate2BuildId, generatedAssets);
    await fs.writeFile(path.join(stageDir, 'gpu-pack-candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(stageDir, 'NVIDIA-CUDA-12.9.1-NOTICE-DRAFT.md'), noticeDraft, { flag: 'wx' });

    await fs.rename(stageDir, outputDir);
    stageCreated = false;
    process.stdout.write(`Prepared unpublished candidate: ${path.basename(outputDir)}\n`);
    process.stdout.write(`Pack ID: ${manifest.packId}\n`);
    process.stdout.write(`Compressed bytes: ${manifest.totalDownloadBytes}\n`);
    process.stdout.write(`Installed bytes: ${manifest.totalInstalledBytes}\n`);
    for (const asset of generatedAssets) {
      process.stdout.write(`${asset.compressedFileName}: ${asset.compressedBytes} bytes sha256=${asset.compressedSha256}\n`);
    }
  } catch (error) {
    if (stageCreated) {
      const currentStage = await fs.lstat(stageDir).catch(() => null);
      if (currentStage?.isDirectory() && !currentStage.isSymbolicLink()
        && path.dirname(stageDir).toLowerCase() === outputParent.toLowerCase()
        && path.basename(stageDir).startsWith(expectedStagePrefix)) {
        await fs.rm(stageDir, { recursive: true, force: false }).catch(() => {});
      }
    }
    throw error;
  }
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage}\n`);
      return;
    }
    await buildCandidate(options);
  } catch (error) {
    process.stderr.write(`GPU pack candidate preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`\n${usage}\n`);
    process.exitCode = 1;
  }
}

await main();
