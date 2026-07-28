import { app, nativeImage } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MASTER_PATH = join(APP_ROOT, 'resources', 'eve-cactus-master.png');
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const OUTPUTS = [
  ['resources/icon.ico', 'standard-ico'],
  ['resources/icon.png', 'standard-png'],
  ['resources/tray-light.ico', 'light-ico'],
  ['resources/tray-dark.ico', 'dark-ico'],
  ['resources/tray-high-contrast.ico', 'high-contrast-ico'],
  ['src/renderer/public/icon.png', 'standard-png'],
];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function recolor(image, variant) {
  const { width, height } = image.getSize();
  const source = image.toBitmap();
  const output = Buffer.alloc(source.length);
  const alpha = new Uint8Array(width * height);

  for (let pixel = 0; pixel < alpha.length; pixel += 1) {
    alpha[pixel] = source[pixel * 4 + 3];
  }

  const useOutline = variant === 'standard' || variant === 'high-contrast';
  const radius = useOutline ? Math.max(1, Math.round(width * 0.03)) : 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const sourceAlpha = alpha[pixel];
      let outlineAlpha = 0;

      if (useOutline && sourceAlpha < 255) {
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          const sampleY = y + offsetY;
          if (sampleY < 0 || sampleY >= height) continue;
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue;
            const sampleX = x + offsetX;
            if (sampleX < 0 || sampleX >= width) continue;
            outlineAlpha = Math.max(outlineAlpha, alpha[sampleY * width + sampleX]);
          }
        }
      }

      const byte = pixel * 4;
      if (sourceAlpha > 0) {
        const value = variant === 'light' ? 8 : 244;
        output[byte] = value;
        output[byte + 1] = value;
        output[byte + 2] = variant === 'light' ? 10 : 245;
        output[byte + 3] = sourceAlpha;
      } else if (outlineAlpha > 0) {
        output[byte] = 10;
        output[byte + 1] = 9;
        output[byte + 2] = 8;
        output[byte + 3] = outlineAlpha;
      }
    }
  }

  return nativeImage.createFromBitmap(output, { width, height });
}

function renderPng(master, size, variant) {
  const resized = master.resize({ width: size, height: size, quality: 'best' });
  return recolor(resized, variant).toPNG();
}

function buildIco(master, variant) {
  const images = ICO_SIZES.map((size) => ({
    size,
    data: renderPng(master, size, variant),
  }));
  const directorySize = 6 + images.length * 16;
  const header = Buffer.alloc(directorySize);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = directorySize;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });

  return Buffer.concat([header, ...images.map(({ data }) => data)]);
}

function buildOutputs(master) {
  const standardPng = renderPng(master, 512, 'standard');
  return new Map(
    OUTPUTS.map(([relativePath, kind]) => {
      if (kind === 'standard-png') return [relativePath, standardPng];
      if (kind === 'standard-ico') return [relativePath, buildIco(master, 'standard')];
      if (kind === 'light-ico') return [relativePath, buildIco(master, 'light')];
      if (kind === 'dark-ico') return [relativePath, buildIco(master, 'dark')];
      return [relativePath, buildIco(master, 'high-contrast')];
    })
  );
}

function validateMaster(master) {
  const { width, height } = master.getSize();
  if (width < 2048 || height < 2048 || width !== height) {
    throw new Error(`Cactus master must be a square image of at least 2048 px; got ${width}x${height}`);
  }

  const bitmap = master.toBitmap();
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let opaquePixels = 0;
  let transparentPixels = 0;

  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const alpha = bitmap[pixel * 4 + 3];
    if (alpha === 0) transparentPixels += 1;
    if (alpha >= 250) opaquePixels += 1;
    if (alpha === 0) continue;

    const x = pixel % width;
    const y = Math.floor(pixel / width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (opaquePixels === 0 || transparentPixels === 0) {
    throw new Error('Cactus master must contain both an opaque glyph and transparent canvas');
  }

  const topPadding = minY / height;
  const bottomPadding = (height - 1 - maxY) / height;
  const sidePadding = Math.min(minX, width - 1 - maxX) / width;
  if (topPadding < 0.1 || topPadding > 0.14 || bottomPadding < 0.1 || bottomPadding > 0.14) {
    throw new Error('Cactus master must retain approximately 12% vertical optical padding');
  }
  if (sidePadding < 0.1) {
    throw new Error('Cactus master must retain at least 10% horizontal optical padding');
  }
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const master = nativeImage.createFromPath(MASTER_PATH);
  if (master.isEmpty()) {
    throw new Error(`Cactus master is missing or invalid: ${MASTER_PATH}`);
  }

  validateMaster(master);

  const outputs = buildOutputs(master);
  for (const [relativePath, expected] of outputs) {
    const outputPath = join(APP_ROOT, relativePath);
    if (checkOnly) {
      if (!existsSync(outputPath)) {
        throw new Error(`Generated icon is missing: ${relativePath}`);
      }
      const actual = readFileSync(outputPath);
      if (!actual.equals(expected)) {
        throw new Error(
          `Generated icon is stale: ${relativePath} (expected ${sha256(expected)}, got ${sha256(actual)})`
        );
      }
      continue;
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, expected);
    console.log(`${relativePath} ${sha256(expected)}`);
  }
}

try {
  main();
  app.exit(0);
} catch (error) {
  console.error(error);
  app.exit(1);
}
