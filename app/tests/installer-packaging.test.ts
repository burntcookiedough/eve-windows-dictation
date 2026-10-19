import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hook = require('../scripts/before-pack.cjs');
const { compute7zCompressArgs } = require('app-builder-lib/out/targets/archive.js');

test('configured hook selects an NSIS compatible filter in the pinned archive implementation', async () => {
  const previous = process.env.ELECTRON_BUILDER_7Z_FILTER;
  try {
    delete process.env.ELECTRON_BUILDER_7Z_FILTER;
    await hook({ electronPlatformName: 'linux' });
    expect(process.env.ELECTRON_BUILDER_7Z_FILTER).toBeUndefined();
    process.env.ELECTRON_BUILDER_7Z_FILTER = 'ARM64';
    const config = require('../package.json').build;
    expect(require(`../${config.beforePack}`)).toBe(hook);
    await hook({ electronPlatformName: 'win32' });
    expect(compute7zCompressArgs('7z', {})).toContain('-mf=BCJ');
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_BUILDER_7Z_FILTER;
    else process.env.ELECTRON_BUILDER_7Z_FILTER = previous;
  }
});
