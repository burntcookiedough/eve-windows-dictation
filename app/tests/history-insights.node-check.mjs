import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(join(testDir, '.history-check-'));
const bundlePath = join(workDir, 'history-service.mjs');

await build({
  entryPoints: [fileURLToPath(new URL('../src/main/services/history.ts', import.meta.url))],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3'],
  plugins: [
    {
      name: 'electron-test-stub',
      setup(buildApi) {
        buildApi.onResolve({ filter: /^electron$/ }, () => ({
          path: 'electron',
          namespace: 'electron-test-stub',
        }));
        buildApi.onLoad({ filter: /.*/, namespace: 'electron-test-stub' }, () => ({
          contents: `export const app = { getPath: () => ${JSON.stringify(workDir)} };`,
          loader: 'js',
        }));
      },
    },
  ],
});

const { HistoryService } = await import(pathToFileURL(bundlePath).href);

function transcription(id, timestamp, text, audioDuration, transcriptionTime) {
  return {
    id,
    timestamp,
    text,
    audioDuration,
    transcriptionTime,
    confidence: 0.9,
    sessionMode: 'quick',
  };
}

try {
  const dbPath = join(workDir, 'history.db');
  const service = new HistoryService(dbPath);
  service.initialize();

  const now = new Date(2026, 6, 1, 10).getTime();

  service.save(transcription('a', now, 'Project planning project notes', 30, 15000));
  service.save(transcription('b', now, 'Project review notes', 30, 30000));

  const saved = service.getInsights('all');
  assert.equal(saved.summary.totalDictations, 2);
  assert.equal(saved.summary.totalWords, 7);
  assert.equal(saved.summary.totalAudioSeconds, 60);
  assert.equal(saved.summary.totalProcessingMs, 45000);
  assert.equal(saved.summary.avgWpm, 7);
  assert.equal(saved.commonWords[0]?.text, 'project');
  assert.equal(saved.commonWords[0]?.count, 3);

  service.rebuildInsights();
  const rebuilt = service.getInsights('all');
  assert.equal(rebuilt.summary.totalDictations, 2);
  assert.equal(rebuilt.summary.totalWords, 7);
  assert.equal(rebuilt.commonWords[0]?.text, 'project');
  assert.equal(rebuilt.commonWords[0]?.count, 3);

  service.delete('a');
  const afterDelete = service.getInsights('all');
  assert.equal(afterDelete.summary.totalDictations, 1);
  assert.equal(afterDelete.summary.totalWords, 3);
  assert.deepEqual(afterDelete.commonWords.slice(0, 3), [
    { text: 'notes', count: 1 },
    { text: 'project', count: 1 },
    { text: 'review', count: 1 },
  ]);

  service.close();
  console.log('history insights aggregate check passed');
  rmSync(workDir, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  console.error(error);
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
