import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

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
  const empty = service.getInsights('7d');
  assert.equal(empty.hasData, false);
  assert.equal(empty.summary.totalDictations, 0);
  assert.equal(empty.indexing.isIndexing, false);
  assert.equal(empty.indexing.totalEntries, 0);

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

  const migrationDbPath = join(workDir, 'migration-history.db');
  const migrationService = new HistoryService(migrationDbPath);
  migrationService.initialize();
  migrationService.save(transcription('m-a', now, 'Migration project notes', 30, 15000));
  migrationService.save(transcription('m-b', now, 'Migration review notes', 30, 15000));
  migrationService.close();

  const migrationDb = new Database(migrationDbPath);
  migrationDb.prepare('DELETE FROM insights_processed_entries').run();
  migrationDb.close();

  const migratedService = new HistoryService(migrationDbPath);
  migratedService.initialize();
  const migrated = migratedService.getInsights('all');
  assert.equal(migrated.summary.totalDictations, 2);
  assert.equal(migrated.summary.totalWords, 6);
  migratedService.close();

  const largeDbPath = join(workDir, 'large-history.db');
  const largeSetup = new HistoryService(largeDbPath);
  largeSetup.initialize();
  largeSetup.close();

  const largeDb = new Database(largeDbPath);
  const insert = largeDb.prepare(`
    INSERT INTO transcriptions (
      id,
      timestamp,
      text,
      confidence,
      audioDuration,
      transcriptionTime,
      wordCount,
      sessionMode
    )
    VALUES (@id, @timestamp, @text, 0.9, 12, 6000, @wordCount, 'quick')
  `);
  const insertMany = largeDb.transaction((count) => {
    for (let index = 0; index < count; index += 1) {
      insert.run({
        id: `large-${index}`,
        timestamp: now - index * 60000,
        text: `large history entry ${index} project notes`,
        wordCount: 6,
      });
    }
  });
  insertMany(5000);
  largeDb.close();

  const largeService = new HistoryService(largeDbPath);
  const initStarted = Date.now();
  largeService.initialize();
  const initMs = Date.now() - initStarted;
  assert.ok(initMs < 1500, `large initialize took ${initMs}ms`);

  const insightsStarted = Date.now();
  const largeInsights = largeService.getInsights('all');
  const insightsMs = Date.now() - insightsStarted;
  assert.ok(insightsMs < 1500, `large getInsights(all) took ${insightsMs}ms`);
  assert.ok(largeInsights.summary.totalDictations <= 1250);
  assert.equal(largeInsights.indexing.isIndexing, true);
  assert.equal(largeInsights.indexing.totalEntries, 5000);
  assert.equal(largeInsights.indexing.processedEntries, 1250);
  largeService.close();

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
