// Never run this clipboard probe on a personal machine.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true'
  || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') {
  throw new Error('Clipboard probe requires disposable hosted Windows.');
}
const { app, clipboard } = require('electron');
const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(process.env.EVE_HOSTED_CLIPBOARD_ROOT);
if (path.dirname(root) !== path.resolve(os.tmpdir())
  || !path.basename(root).startsWith('eve-hosted-clipboard-')) {
  throw new Error('Unexpected hosted clipboard probe directory.');
}
const appDir = path.resolve(__dirname, '../..');
const profile = path.join(root, 'profile');
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.whenReady().then(async () => {
  const bundle = path.join(root, 'clipboard.cjs');
  await build({ entryPoints: [path.join(appDir, 'src/main/services/clipboard.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
  const { copyToClipboard, readFromClipboard } = require(bundle);
  const marker = 'EVE_ALPHA7_HOSTED_SYNTHETIC_CLIPBOARD';
  await copyToClipboard(marker);
  // Read only after the synthetic write has succeeded; no initial clipboard read.
  assert.equal(await readFromClipboard(), marker);
  assert.ok((await clipboard.read()).some(item => item.types.includes('text/plain')));
  await copyToClipboard('');
  process.stdout.write('HOSTED_CLIPBOARD_PROOF=passed\n');
  app.quit();
}).catch(() => {
  process.stderr.write('Hosted synthetic clipboard integration failed.\n');
  app.exit(1);
});
