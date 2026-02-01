import * as esbuild from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

const isWatch = process.argv.includes('--watch');

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: [
    'electron',
    'better-sqlite3',
    'ws',
    'uiohook-napi',
    '@nut-tree-fork/nut-js',
  ],
  sourcemap: true,
  logLevel: 'info',
};

// Build main process
const mainOptions = {
  ...commonOptions,
  entryPoints: [resolve(projectRoot, 'src/main/index.ts')],
  outfile: resolve(projectRoot, 'dist/main/index.js'),
};

// Build overlay preload script
const preloadOverlayOptions = {
  ...commonOptions,
  entryPoints: [resolve(projectRoot, 'src/main/preload/overlay.ts')],
  outfile: resolve(projectRoot, 'dist/main/preload/overlay.js'),
};

// Build main window preload script
const preloadMainOptions = {
  ...commonOptions,
  entryPoints: [resolve(projectRoot, 'src/main/preload/main.ts')],
  outfile: resolve(projectRoot, 'dist/main/preload/main.js'),
};

async function build() {
  if (isWatch) {
    const mainCtx = await esbuild.context(mainOptions);
    const preloadOverlayCtx = await esbuild.context(preloadOverlayOptions);
    const preloadMainCtx = await esbuild.context(preloadMainOptions);

    await mainCtx.watch();
    await preloadOverlayCtx.watch();
    await preloadMainCtx.watch();

    console.log('Watching for changes...');
  } else {
    await esbuild.build(mainOptions);
    await esbuild.build(preloadOverlayOptions);
    await esbuild.build(preloadMainOptions);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
