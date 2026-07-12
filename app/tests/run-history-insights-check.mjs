import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.platform === 'win32'
  ? join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(appDir, 'node_modules', 'electron', 'dist', 'electron');

const result = spawnSync(executable, [join(appDir, 'tests', 'history-insights.node-check.mjs')], {
  cwd: appDir,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
