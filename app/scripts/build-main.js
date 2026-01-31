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

// Build preload script
const preloadOptions = {
  ...commonOptions,
  entryPoints: [resolve(projectRoot, 'src/main/preload/overlay.ts')],
  outfile: resolve(projectRoot, 'dist/main/preload/overlay.js'),
};

async function build() {
  if (isWatch) {
    const mainCtx = await esbuild.context(mainOptions);
    const preloadCtx = await esbuild.context(preloadOptions);

    await mainCtx.watch();
    await preloadCtx.watch();

    console.log('Watching for changes...');
  } else {
    await esbuild.build(mainOptions);
    await esbuild.build(preloadOptions);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
