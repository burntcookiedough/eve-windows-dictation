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
  const migrationDb = new Database(migrationDbPath);
  migrationDb.exec(`
    CREATE TABLE transcriptions (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      text TEXT NOT NULL,
      confidence REAL,
      audioDuration REAL,
      transcriptionTime INTEGER,
      editedAt INTEGER,
      originalText TEXT
    );

    CREATE INDEX idx_timestamp ON transcriptions(timestamp DESC);
  `);
  migrationDb.prepare(`
    INSERT INTO transcriptions (
      id, timestamp, text, confidence, audioDuration, transcriptionTime, editedAt, originalText
    ) VALUES (
      'm-legacy', @timestamp, 'Migration project notes', 0.85, 30, 15000, @editedAt, 'Migration notes'
    )
  `).run({ timestamp: now, editedAt: now + 1000 });
  migrationDb.close();

  const migratedService = new HistoryService(migrationDbPath);
  migratedService.initialize();
  const migrated = migratedService.getInsights('all');
  assert.equal(migrated.summary.totalDictations, 1);
  assert.equal(migrated.summary.totalWords, 3);
  const migratedLegacy = migratedService.getById('m-legacy');
  assert.equal(migratedLegacy?.wordCount, 3);
  assert.equal(migratedLegacy?.editedAt, now + 1000);
  assert.equal(migratedLegacy?.originalText, 'Migration notes');
  assert.equal(migratedLegacy?.sessionMode, undefined);
  assert.equal(migratedLegacy?.engine, undefined);
  assert.equal(migratedLegacy?.model, undefined);
  assert.equal(migratedLegacy?.device, undefined);
  assert.equal(migratedLegacy?.computeType, undefined);
  assert.equal(migratedLegacy?.cudaActive, undefined);

  migratedService.save({
    ...transcription('m-current', now + 2000, 'Current metadata entry', 10, 5000),
    sessionMode: 'long',
    engine: 'whisper',
    model: 'large-v3-turbo',
    device: 'cuda',
    computeType: 'float16',
    cudaActive: true,
  });
  assert.deepEqual(
    (({ sessionMode, engine, model, device, computeType, cudaActive }) => ({
      sessionMode,
      engine,
      model,
      device,
      computeType,
      cudaActive,
    }))(migratedService.getById('m-current')),
    {
      sessionMode: 'long',
      engine: 'whisper',
      model: 'large-v3-turbo',
      device: 'cuda',
      computeType: 'float16',
      cudaActive: true,
    },
  );
  migratedService.close();

  const phrasesDbPath = join(workDir, 'full-range-phrases.db');
  const phrasesSetup = new HistoryService(phrasesDbPath);
  phrasesSetup.initialize();
  phrasesSetup.close();

  const phrasesDb = new Database(phrasesDbPath);
  const insertPhraseEntry = phrasesDb.prepare(`
    INSERT INTO transcriptions (id, timestamp, text, confidence, audioDuration, transcriptionTime)
    VALUES (@id, @timestamp, @text, 0.9, 1, 100)
  `);
  const insertPhraseEntries = phrasesDb.transaction(() => {
    insertPhraseEntry.run({
      id: 'phrase-older-than-500',
      timestamp: now - 502000,
      text: 'complete selected range',
    });
    for (let index = 0; index < 501; index += 1) {
      insertPhraseEntry.run({
        id: `phrase-recent-${index}`,
        timestamp: now - index * 1000,
        text: `recent${index}`,
      });
    }
  });
  insertPhraseEntries();
  phrasesDb.close();

  const phrasesService = new HistoryService(phrasesDbPath);
  phrasesService.initialize();
  const fullRangePhrases = phrasesService.getInsights('all').commonPhrases;
  assert.ok(
    fullRangePhrases.some(({ text, count }) => text === 'complete selected' && count === 1),
    'common phrases should include entries older than the newest 500',
  );
  phrasesService.close();

  const originalTimezone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const streakService = new HistoryService(join(workDir, 'dst-streak.db'));
    streakService.initialize();
    streakService.save(transcription('dst-1', new Date(2026, 2, 7, 12).getTime(), 'first day', 1, 100));
    streakService.save(transcription('dst-2', new Date(2026, 2, 8, 12).getTime(), 'second day', 1, 100));
    streakService.save(transcription('dst-3', new Date(2026, 2, 9, 12).getTime(), 'third day', 1, 100));
    assert.equal(streakService.getInsights('all').summary.longestStreakDays, 3);
    streakService.close();
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }

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
