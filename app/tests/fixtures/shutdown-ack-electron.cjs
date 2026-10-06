const { app } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const appDir = path.resolve(__dirname, '../..');
const tempRoot = path.resolve(process.env.EVE_SHUTDOWN_ACK_TEMP_ROOT);
if (
  path.dirname(tempRoot) !== path.resolve(os.tmpdir())
  || !path.basename(tempRoot).startsWith('eve-shutdown-ack-test-')
) {
  throw new Error(`Refusing unexpected shutdown test path: ${tempRoot}`);
}
const workDir = path.join(tempRoot, 'work');
const profileDir = path.join(tempRoot, 'profile');
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });
fs.mkdirSync(path.join(workDir, 'node_modules'), { recursive: true });
fs.symlinkSync(path.join(appDir, 'node_modules', 'electron'), path.join(workDir, 'node_modules', 'electron'), 'junction');
fs.mkdirSync(path.join(workDir, 'preload'), { recursive: true });
fs.writeFileSync(path.join(workDir, 'preload', 'main.js'), '');
app.setPath('userData', profileDir);

let mainWindow;
let attemptCount = 0;
let beforeQuitCount = 0;
let willQuitCount = 0;
let willQuitBeforeAck = false;
let failureShowCalled = false;
let failureFocusCalled = false;
let retryStartedAt;
let acknowledgedAt;
let finished = false;

function finish(exitCode) {
  if (finished) return;
  finished = true;
  const proof = {
    attemptCount,
    beforeQuitCount,
    willQuitCount,
    failureShowCalled,
    failureFocusCalled,
    willQuitBeforeAck,
    acknowledged: acknowledgedAt !== undefined,
    willQuitAfterAck: acknowledgedAt !== undefined && willQuitCount > 0 && !willQuitBeforeAck,
    retryAckDelayMs: retryStartedAt === undefined || acknowledgedAt === undefined
      ? null
      : acknowledgedAt - retryStartedAt,
  };
  process.stdout.write(`SHUTDOWN_ACK_PROOF=${JSON.stringify(proof)}\n`, () => process.exit(exitCode));
}

const server = http.createServer((request, response) => {
  if (request.url?.startsWith('/attempt/')) {
    attemptCount = Number(request.url.slice('/attempt/'.length));
    if (attemptCount === 2) retryStartedAt = Date.now();
    response.end('started');
    if (attemptCount === 1) {
      setTimeout(() => {
        app.quit();
        setTimeout(() => {
          if (attemptCount < 2) finish(1);
        }, 750);
      }, 300);
    }
    return;
  }

  if (request.url === '/ack') {
    acknowledgedAt = Date.now();
    response.end('acknowledged');
    if (willQuitBeforeAck) setTimeout(() => finish(1), 50);
    return;
  }

  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html><body><script>
    let flushCalls = 0;
    window.__flushDeferredHistoryDeletesOnQuit = () => {
      const attempt = ++flushCalls;
      fetch('/attempt/' + attempt);
      if (attempt === 1) {
        return new Promise((resolve, reject) => {
          setTimeout(() => reject(new Error('synthetic flush rejection')), 100);
        });
      }
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          fetch('/ack').then((response) => {
            if (!response.ok) throw new Error('synthetic acknowledgement failed');
            resolve();
          }, reject).catch(reject);
        }, 5300);
      });
    };
  </script></body></html>`);
});

app.on('before-quit', () => { beforeQuitCount += 1; });
app.on('will-quit', (event) => {
  event.preventDefault();
  willQuitCount += 1;
  if (acknowledgedAt === undefined) {
    willQuitBeforeAck = true;
    return;
  }
  setTimeout(() => finish(0), 50);
});

(async () => {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  process.env.NODE_ENV = 'development';
  process.env.MURMUR_DEV_PORT = String(server.address().port);

  const bundle = await build({
    entryPoints: [path.join(appDir, 'src', 'main', 'windows', 'main.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    external: ['electron'],
    plugins: [{
      name: 'shutdown-ack-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /services\/settings\.js$/ }, () => ({
          path: 'settings',
          namespace: 'shutdown-ack-test',
        }));
        buildApi.onResolve({ filter: /services\/app-icon\.js$/ }, () => ({
          path: 'icon',
          namespace: 'shutdown-ack-test',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'shutdown-ack-test' }, ({ path: module }) => ({
          contents: module === 'settings'
            ? 'export const getMainWindowBounds = () => undefined; export const setMainWindowBounds = () => {}; export const getSettings = () => ({ appearance: "dark" });'
            : 'export const getEveIcon = () => undefined;',
          loader: 'js',
        }));
      },
    }],
  });
  const bundlePath = path.join(workDir, 'main.mjs');
  fs.writeFileSync(bundlePath, bundle.outputFiles[0].text);

  await app.whenReady();
  const { createMainWindow } = await import(pathToFileURL(bundlePath).href);
  mainWindow = await createMainWindow({ startMinimized: true });
  mainWindow.show = () => { failureShowCalled = true; };
  mainWindow.focus = () => { failureFocusCalled = true; };
  app.quit();
})().catch((error) => {
  console.error(error);
  finish(1);
});

setTimeout(() => finish(1), 15000);
