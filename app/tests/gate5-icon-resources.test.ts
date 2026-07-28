import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const APP_ROOT = path.resolve(import.meta.dir, '..');
const REQUIRED_ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function read(relativePath: string): Buffer {
  return readFileSync(path.join(APP_ROOT, relativePath));
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(buffer.toString('ascii', 12, 16)).toBe('IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function icoSizes(buffer: Buffer): number[] {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  const count = buffer.readUInt16LE(4);
  const sizes: number[] = [];

  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = buffer.readUInt8(entry) || 256;
    const height = buffer.readUInt8(entry + 1) || 256;
    expect(height).toBe(width);
    expect(buffer.readUInt16LE(entry + 4)).toBe(1);
    expect(buffer.readUInt16LE(entry + 6)).toBe(32);

    const length = buffer.readUInt32LE(entry + 8);
    const offset = buffer.readUInt32LE(entry + 12);
    expect(pngSize(buffer.subarray(offset, offset + length))).toEqual({
      width,
      height,
    });
    sizes.push(width);
  }

  return sizes;
}

describe('Gate 5B cactus resources', () => {
  test('keeps one 2048px alpha master and identical runtime PNG copies', () => {
    const master = read('resources/eve-cactus-master.png');
    expect(pngSize(master)).toEqual({ width: 2048, height: 2048 });

    const runtime = read('resources/icon.png');
    const renderer = read('src/renderer/public/icon.png');
    expect(pngSize(runtime)).toEqual({ width: 512, height: 512 });
    expect(createHash('sha256').update(runtime).digest('hex')).toBe(
      createHash('sha256').update(renderer).digest('hex')
    );
  });

  test('includes every required Windows size in application and tray ICOs', () => {
    for (const relativePath of [
      'resources/icon.ico',
      'resources/tray-light.ico',
      'resources/tray-dark.ico',
      'resources/tray-high-contrast.ico',
    ]) {
      expect(icoSizes(read(relativePath))).toEqual(REQUIRED_ICO_SIZES);
    }
  });

  test('keeps all derivatives reproducible from the tracked master', () => {
    const packageJson = read('package.json').toString('utf8');
    expect(packageJson).toContain('"build:icons": "electron scripts/build-icons.mjs"');

    const script = read('scripts/build-icons.mjs').toString('utf8');
    expect(script).toContain("const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]");
    expect(script).toContain("process.argv.includes('--check')");
    expect(script).not.toContain('sharp');

    const result = Bun.spawnSync({
      cmd: [process.execPath, 'run', 'build:icons', '--', '--check'],
      cwd: APP_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = `${result.stderr.toString()}${result.stdout.toString()}`;
    expect(result.exitCode, output).toBe(0);
  });
});
