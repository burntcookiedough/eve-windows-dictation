import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import {
  addLocalDays,
  buildPhraseStats,
  calcProcessingRatio,
  calcWordsPerMinute,
  countWords,
  formatTrendLabel,
  getLocalDayKey,
  getRangeStart,
  sortWordStats,
  tokenizeInsightWords,
} from '../../shared/insights.js';
import type {
  HistoryDeleteResult,
  HistoryFilters,
  HistoryEntryWithGroup,
  HistoryResponse,
  InsightSourceEntry,
  InsightsEntryStat,
  InsightsRange,
  InsightsResponse,
  InsightsSummary,
  InsightsTrendPoint,
  InsightsWordStat,
  TranscriptionEntry,
} from '../../shared/types.js';

const INSIGHTS_PHRASE_ENTRY_LIMIT = 5000;
const HISTORY_ID_CHUNK_SIZE = 500;

function computeDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  if (date >= weekAgo) return 'This Week';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface HistoryQuery {
  whereClause: string;
  params: Record<string, unknown>;
}

function buildHistoryQuery(filters?: HistoryFilters): HistoryQuery {
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters?.text) {
    conditions.push('text LIKE @textSearch');
    params.textSearch = `%${filters.text}%`;
  }
  if (filters?.dateFrom !== undefined) {
    conditions.push('timestamp >= @dateFrom');
    params.dateFrom = filters.dateFrom;
  }
  if (filters?.dateTo !== undefined) {
    conditions.push('timestamp <= @dateTo');
    params.dateTo = filters.dateTo;
  }
  if (filters?.minDuration !== undefined) {
    conditions.push('audioDuration >= @minDuration');
    params.minDuration = filters.minDuration;
  }
  if (filters?.maxDuration !== undefined) {
    conditions.push('audioDuration <= @maxDuration');
    params.maxDuration = filters.maxDuration;
  }
  if (filters?.minConfidence !== undefined) {
    conditions.push('confidence >= @minConfidence');
    params.minConfidence = filters.minConfidence;
  }
  if (filters?.editedOnly) {
    conditions.push('editedAt IS NOT NULL');
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function buildIdParams(ids: string[]): Record<string, string> {
  return Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));
}

function buildIdPlaceholders(ids: string[]): string {
  return ids.map((_id, index) => `@id${index}`).join(', ');
}

export class HistoryService {
  private db: Database.Database | null = null;
  private dbPath: string;
  private readonly startupCatchupLimit = 250;
  private readonly queryCatchupLimit = 1000;
  private readonly backgroundCatchupLimit = 500;
  private catchupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? path.join(app.getPath('userData'), 'history.db');
  }

  initialize(): void {
    this.db = new Database(this.dbPath);

    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');

    // Create table and index
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcriptions (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        text TEXT NOT NULL,
        confidence REAL,
        audioDuration REAL,
        transcriptionTime INTEGER,
        wordCount INTEGER,
        sessionMode TEXT,
        engine TEXT,
        model TEXT,
        device TEXT,
        computeType TEXT,
        cudaActive INTEGER,
        editedAt INTEGER,
        originalText TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON transcriptions(timestamp DESC);
    `);

    this.migrateSchema();
    this.createInsightsTables();
    this.prepareInsightsLedgerMigration();
    if (this.processPendingInsights(this.startupCatchupLimit) >= this.startupCatchupLimit) {
      this.scheduleInsightsCatchup();
    }
  }

  save(entry: TranscriptionEntry): void {
    if (!this.db) throw new Error('Database not initialized');
    const wordCount = entry.wordCount ?? countWords(entry.text);

    const stmt = this.db.prepare(`
      INSERT INTO transcriptions (
        id,
        timestamp,
        text,
        confidence,
        audioDuration,
        transcriptionTime,
        wordCount,
        sessionMode,
        engine,
        model,
        device,
        computeType,
        cudaActive,
        editedAt,
        originalText
      )
      VALUES (
        @id,
        @timestamp,
        @text,
        @confidence,
        @audioDuration,
        @transcriptionTime,
        @wordCount,
        @sessionMode,
        @engine,
        @model,
        @device,
        @computeType,
        @cudaActive,
        @editedAt,
        @originalText
      )
    `);

    stmt.run({
      id: entry.id,
      timestamp: entry.timestamp,
      text: entry.text,
      confidence: entry.confidence,
      audioDuration: entry.audioDuration,
      transcriptionTime: entry.transcriptionTime,
      wordCount,
      sessionMode: entry.sessionMode ?? null,
      engine: entry.engine ?? null,
      model: entry.model ?? null,
      device: entry.device ?? null,
      computeType: entry.computeType ?? null,
      cudaActive: entry.cudaActive === undefined ? null : Number(entry.cudaActive),
      editedAt: entry.editedAt ?? null,
      originalText: entry.originalText ?? null,
    });

    this.addEntryToInsights({ ...entry, wordCount });
  }

  getEntries(offset: number, limit: number, filters?: HistoryFilters): HistoryResponse {
    if (!this.db) throw new Error('Database not initialized');
    const { whereClause, params } = buildHistoryQuery(filters);

    // Fetch one extra to determine if there are more entries
    const query = `
      SELECT
        id,
        timestamp,
        text,
        confidence,
        audioDuration,
        transcriptionTime,
        wordCount,
        sessionMode,
        engine,
        model,
        device,
        computeType,
        cudaActive,
        editedAt,
        originalText
      FROM transcriptions
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset
    `;

    const stmt = this.db.prepare(query);
    const rows = stmt.all({
      ...params,
      limit: limit + 1,
      offset,
    }).map(mapTranscriptionEntry);

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;

    // Add date groups to each entry
    const entriesWithGroups: HistoryEntryWithGroup[] = entries.map((entry) => ({
      ...entry,
      dateGroup: computeDateGroup(entry.timestamp),
    }));

    return {
      entries: entriesWithGroups,
      hasMore,
    };
  }

  getEntryIds(filters?: HistoryFilters): string[] {
    if (!this.db) throw new Error('Database not initialized');
    const { whereClause, params } = buildHistoryQuery(filters);
    const rows = this.db.prepare(`
      SELECT id
      FROM transcriptions
      ${whereClause}
      ORDER BY timestamp DESC
    `).all(params) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  delete(id: string): void {
    this.deleteMany([id]);
  }

  deleteMany(ids: string[]): HistoryDeleteResult {
    if (!this.db) throw new Error('Database not initialized');

    const requestedIds = [...new Set(ids.filter((id) => id.length > 0))];
    if (requestedIds.length === 0) {
      return {
        requestedCount: 0,
        deletedCount: 0,
        deletedIds: [],
        missingIds: [],
      };
    }

    const remove = this.db.transaction((selectedIds: string[]): HistoryDeleteResult => {
      const existing = this.getEntriesByIds(selectedIds);
      const existingIds = new Set(existing.map((entry) => entry.id));
      const missingIds = selectedIds.filter((id) => !existingIds.has(id));
      let deletedCount = 0;

      for (let offset = 0; offset < selectedIds.length; offset += HISTORY_ID_CHUNK_SIZE) {
        const chunk = selectedIds.slice(offset, offset + HISTORY_ID_CHUNK_SIZE);
        const result = this.db!.prepare(
          `DELETE FROM transcriptions WHERE id IN (${buildIdPlaceholders(chunk)})`
        ).run(buildIdParams(chunk));
        deletedCount += result.changes;
      }

      this.removeEntriesFromInsightsWithinTransaction(existing);

      const deletedIds = selectedIds.filter((id) => existingIds.has(id));
      return {
        requestedCount: selectedIds.length,
        deletedCount,
        deletedIds,
        missingIds,
      };
    });

    return remove.immediate(requestedIds);
  }

  getById(id: string): TranscriptionEntry | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT
        id,
        timestamp,
        text,
        confidence,
        audioDuration,
        transcriptionTime,
        wordCount,
        sessionMode,
        engine,
        model,
        device,
        computeType,
        cudaActive,
        editedAt,
        originalText
      FROM transcriptions
      WHERE id = @id
    `);

    const row = stmt.get({ id });
    return row ? mapTranscriptionEntry(row) : null;
  }

  private getEntriesByIds(ids: string[]): TranscriptionEntry[] {
    if (!this.db || ids.length === 0) return [];
    const entries: TranscriptionEntry[] = [];

    for (let offset = 0; offset < ids.length; offset += HISTORY_ID_CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + HISTORY_ID_CHUNK_SIZE);
      const rows = this.db.prepare(`
        SELECT
          id,
          timestamp,
          text,
          confidence,
          audioDuration,
          transcriptionTime,
          wordCount,
          sessionMode,
          engine,
          model,
          device,
          computeType,
          cudaActive,
          editedAt,
          originalText
        FROM transcriptions
        WHERE id IN (${buildIdPlaceholders(chunk)})
      `).all(buildIdParams(chunk));
      entries.push(...rows.map(mapTranscriptionEntry));
    }

    return entries;
  }

  getInsights(range: InsightsRange, now = Date.now()): InsightsResponse {
    if (!this.db) throw new Error('Database not initialized');
    if (this.processPendingInsights(this.queryCatchupLimit) >= this.queryCatchupLimit) {
      this.scheduleInsightsCatchup();
    }

    const generatedAt = Number.isFinite(now) ? now : Date.now();
    const rangeStart = getRangeStart(range, generatedAt);
    const dayStart = rangeStart === null ? null : getLocalDayKey(rangeStart);
    const rows = this.getDailyRows(dayStart);
    const trends = this.buildTrends(rows, range, generatedAt);
    const summary = this.buildSummary(rows);
    const indexing = this.getIndexingStatus();
    const commonWords = this.getCommonWords(dayStart, 18);
    const sourceEntries = this.getSourceEntries(rangeStart, INSIGHTS_PHRASE_ENTRY_LIMIT);
    const commonPhrases = buildPhraseStats(sourceEntries, 12);
    const longestEntries = this.getLongestEntries(rangeStart, 5);
    const slowestEntries = this.getSlowestEntries(rangeStart, 5);

    return {
      range,
      generatedAt,
      hasData: summary.totalDictations > 0,
      indexing,
      summary,
      trends,
      commonWords,
      commonPhrases,
      longestEntries,
      slowestEntries,
    };
  }

  rebuildInsights(): void {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db.prepare(`
      SELECT
        id,
        timestamp,
        text,
        confidence,
        audioDuration,
        transcriptionTime,
        wordCount,
        sessionMode,
        engine,
        model,
        device,
        computeType,
        cudaActive,
        editedAt,
        originalText
      FROM transcriptions
    `).all().map(mapTranscriptionEntry);

    const reset = this.db.transaction((entries: TranscriptionEntry[]) => {
      this.db!.prepare('DELETE FROM insights_daily_rollups').run();
      this.db!.prepare('DELETE FROM insights_word_counts').run();
      this.db!.prepare('DELETE FROM insights_processed_entries').run();

      const updateWords = this.db!.prepare(`
        UPDATE transcriptions
        SET wordCount = @wordCount
        WHERE id = @id
      `);

      for (const entry of entries) {
        const wordCount = entry.wordCount ?? countWords(entry.text);
        if (entry.wordCount !== wordCount) {
          updateWords.run({ id: entry.id, wordCount });
        }
        this.addEntryToInsights({ ...entry, wordCount });
      }
    });

    reset(rows);
  }

  close(): void {
    if (this.catchupTimer) {
      clearTimeout(this.catchupTimer);
      this.catchupTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private migrateSchema(): void {
    if (!this.db) throw new Error('Database not initialized');
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(transcriptions)').all() as Array<{ name: string }>)
        .map((column) => column.name)
    );

    const migrations: Array<[string, string]> = [
      ['wordCount', 'ALTER TABLE transcriptions ADD COLUMN wordCount INTEGER'],
      ['sessionMode', 'ALTER TABLE transcriptions ADD COLUMN sessionMode TEXT'],
      ['engine', 'ALTER TABLE transcriptions ADD COLUMN engine TEXT'],
      ['model', 'ALTER TABLE transcriptions ADD COLUMN model TEXT'],
      ['device', 'ALTER TABLE transcriptions ADD COLUMN device TEXT'],
      ['computeType', 'ALTER TABLE transcriptions ADD COLUMN computeType TEXT'],
      ['cudaActive', 'ALTER TABLE transcriptions ADD COLUMN cudaActive INTEGER'],
    ];

    for (const [column, sql] of migrations) {
      if (!columns.has(column)) {
        this.db.exec(sql);
      }
    }
  }

  private createInsightsTables(): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS insights_daily_rollups (
        day TEXT PRIMARY KEY,
        dictations INTEGER NOT NULL,
        words INTEGER NOT NULL,
        audioSeconds REAL NOT NULL,
        processingMs INTEGER NOT NULL,
        confidenceSum REAL NOT NULL,
        confidenceCount INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS insights_word_counts (
        day TEXT NOT NULL,
        word TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (day, word)
      );

      CREATE TABLE IF NOT EXISTS insights_processed_entries (
        id TEXT PRIMARY KEY,
        processedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_insights_word_counts_word ON insights_word_counts(word);
    `);
  }

  private prepareInsightsLedgerMigration(): void {
    if (!this.db) throw new Error('Database not initialized');
    const processed = this.db.prepare('SELECT COUNT(*) as count FROM insights_processed_entries').get() as { count: number };
    if (processed.count > 0) return;

    const rollups = this.db.prepare('SELECT COUNT(*) as count FROM insights_daily_rollups').get() as { count: number };
    const words = this.db.prepare('SELECT COUNT(*) as count FROM insights_word_counts').get() as { count: number };
    if (rollups.count === 0 && words.count === 0) return;

    this.db.prepare('DELETE FROM insights_daily_rollups').run();
    this.db.prepare('DELETE FROM insights_word_counts').run();
  }

  private addEntryToInsights(entry: TranscriptionEntry): void {
    if (!this.db) throw new Error('Database not initialized');
    const wordCount = entry.wordCount ?? countWords(entry.text);
    const day = getLocalDayKey(entry.timestamp);
    const confidence = Number.isFinite(entry.confidence) ? entry.confidence : 0;
    const confidenceCount = Number.isFinite(entry.confidence) ? 1 : 0;

    this.db.prepare(`
      INSERT INTO insights_daily_rollups (
        day,
        dictations,
        words,
        audioSeconds,
        processingMs,
        confidenceSum,
        confidenceCount
      )
      VALUES (@day, 1, @words, @audioSeconds, @processingMs, @confidenceSum, @confidenceCount)
      ON CONFLICT(day) DO UPDATE SET
        dictations = dictations + excluded.dictations,
        words = words + excluded.words,
        audioSeconds = audioSeconds + excluded.audioSeconds,
        processingMs = processingMs + excluded.processingMs,
        confidenceSum = confidenceSum + excluded.confidenceSum,
        confidenceCount = confidenceCount + excluded.confidenceCount
    `).run({
      day,
      words: wordCount,
      audioSeconds: entry.audioDuration || 0,
      processingMs: entry.transcriptionTime || 0,
      confidenceSum: confidence,
      confidenceCount,
    });

    const counts = new Map<string, number>();
    for (const word of tokenizeInsightWords(entry.text)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }

    const stmt = this.db.prepare(`
      INSERT INTO insights_word_counts (day, word, count)
      VALUES (@day, @word, @count)
      ON CONFLICT(day, word) DO UPDATE SET
        count = count + excluded.count
    `);

    for (const [word, count] of counts) {
      stmt.run({ day, word, count });
    }

    this.db.prepare(`
      INSERT INTO insights_processed_entries (id, processedAt)
      VALUES (@id, @processedAt)
      ON CONFLICT(id) DO UPDATE SET processedAt = excluded.processedAt
    `).run({
      id: entry.id,
      processedAt: Date.now(),
    });
  }

  private removeEntriesFromInsightsWithinTransaction(entries: TranscriptionEntry[]): void {
    if (!this.db) throw new Error('Database not initialized');
    if (entries.length === 0) return;

    const wasProcessed = this.db.prepare(`
      SELECT 1 FROM insights_processed_entries WHERE id = @id
    `);

    const updateRollup = this.db.prepare(`
      UPDATE insights_daily_rollups
      SET
        dictations = MAX(dictations - 1, 0),
        words = MAX(words - @words, 0),
        audioSeconds = MAX(audioSeconds - @audioSeconds, 0),
        processingMs = MAX(processingMs - @processingMs, 0),
        confidenceSum = MAX(confidenceSum - @confidenceSum, 0),
        confidenceCount = MAX(confidenceCount - @confidenceCount, 0)
      WHERE day = @day
    `);

    const decrementWord = this.db.prepare(`
      UPDATE insights_word_counts
      SET count = MAX(count - @count, 0)
      WHERE day = @day AND word = @word
    `);

    const deleteZeroWords = this.db.prepare(
      'DELETE FROM insights_word_counts WHERE day = @day AND count <= 0'
    );
    const deleteZeroRollup = this.db.prepare(
      'DELETE FROM insights_daily_rollups WHERE day = @day AND dictations <= 0'
    );
    const deleteProcessed = this.db.prepare(
      'DELETE FROM insights_processed_entries WHERE id = @id'
    );

    for (const entry of entries) {
      if (!wasProcessed.get({ id: entry.id })) continue;

      const wordCount = entry.wordCount ?? countWords(entry.text);
      const day = getLocalDayKey(entry.timestamp);
      const confidence = Number.isFinite(entry.confidence) ? entry.confidence : 0;
      const confidenceCount = Number.isFinite(entry.confidence) ? 1 : 0;

      updateRollup.run({
        day,
        words: wordCount,
        audioSeconds: entry.audioDuration || 0,
        processingMs: entry.transcriptionTime || 0,
        confidenceSum: confidence,
        confidenceCount,
      });

      const counts = new Map<string, number>();
      for (const word of tokenizeInsightWords(entry.text)) {
        counts.set(word, (counts.get(word) ?? 0) + 1);
      }

      for (const [word, count] of counts) {
        decrementWord.run({ day, word, count });
      }

      deleteZeroWords.run({ day });
      deleteZeroRollup.run({ day });
      deleteProcessed.run({ id: entry.id });
    }
  }

  private processPendingInsights(limit: number): number {
    if (!this.db) throw new Error('Database not initialized');
    if (limit <= 0) return 0;

    const rows = this.db.prepare(`
      SELECT
        t.id,
        t.timestamp,
        t.text,
        t.confidence,
        t.audioDuration,
        t.transcriptionTime,
        t.wordCount,
        t.sessionMode,
        t.engine,
        t.model,
        t.device,
        t.computeType,
        t.cudaActive,
        t.editedAt,
        t.originalText
      FROM transcriptions t
      LEFT JOIN insights_processed_entries p ON p.id = t.id
      WHERE p.id IS NULL
      ORDER BY t.timestamp ASC
      LIMIT @limit
    `).all({ limit }).map(mapTranscriptionEntry);

    if (rows.length === 0) return 0;

    const catchup = this.db.transaction((entries: TranscriptionEntry[]) => {
      const updateWords = this.db!.prepare(`
        UPDATE transcriptions
        SET wordCount = @wordCount
        WHERE id = @id
      `);

      for (const entry of entries) {
        const wordCount = entry.wordCount ?? countWords(entry.text);
        if (entry.wordCount !== wordCount) {
          updateWords.run({ id: entry.id, wordCount });
        }
        this.addEntryToInsights({ ...entry, wordCount });
      }
    });

    catchup(rows);
    return rows.length;
  }

  private getIndexingStatus(): InsightsResponse['indexing'] {
    if (!this.db) throw new Error('Database not initialized');
    const total = this.db.prepare('SELECT COUNT(*) as count FROM transcriptions').get() as { count: number };
    const processed = this.db.prepare('SELECT COUNT(*) as count FROM insights_processed_entries').get() as { count: number };

    return {
      isIndexing: processed.count < total.count,
      processedEntries: Math.min(processed.count, total.count),
      totalEntries: total.count,
    };
  }

  private scheduleInsightsCatchup(): void {
    if (this.catchupTimer || !this.db) return;

    this.catchupTimer = setTimeout(() => {
      this.catchupTimer = null;
      if (!this.db) return;

      try {
        const processed = this.processPendingInsights(this.backgroundCatchupLimit);
        if (processed >= this.backgroundCatchupLimit) {
          this.scheduleInsightsCatchup();
        }
      } catch {
        // A later explicit rebuild or insights query can retry catch-up.
      }
    }, 50);
  }

  private getDailyRows(dayStart: string | null): DailyRollupRow[] {
    if (!this.db) throw new Error('Database not initialized');
    if (dayStart === null) {
      return (this.db.prepare(`
        SELECT day, dictations, words, audioSeconds, processingMs, confidenceSum, confidenceCount
        FROM insights_daily_rollups
        ORDER BY day ASC
      `).all() as DailyRollupRow[]).map(normalizeDailyRow);
    }

    return (this.db.prepare(`
      SELECT day, dictations, words, audioSeconds, processingMs, confidenceSum, confidenceCount
      FROM insights_daily_rollups
      WHERE day >= @dayStart
      ORDER BY day ASC
    `).all({ dayStart }) as DailyRollupRow[]).map(normalizeDailyRow);
  }

  private buildTrends(rows: DailyRollupRow[], range: InsightsRange, now: number): InsightsTrendPoint[] {
    const normalizedRows = rows.map(normalizeDailyRow);
    const rowMap = new Map(normalizedRows.map((row) => [row.day, row]));
    const activeRows = range === 'all'
      ? normalizedRows
      : buildRangeDayKeys(range, now).map((day) => rowMap.get(day) ?? emptyDailyRow(day));

    return activeRows.map((row) => ({
      date: row.day,
      label: formatTrendLabel(row.day),
      dictations: row.dictations,
      words: row.words,
      audioSeconds: row.audioSeconds,
      processingMs: row.processingMs,
      avgWpm: calcWordsPerMinute(row.words, row.audioSeconds),
      avgConfidence: safeConfidence(row.confidenceSum, row.confidenceCount),
      avgProcessingRatio: calcProcessingRatio(row.audioSeconds, row.processingMs),
    }));
  }

  private buildSummary(rows: DailyRollupRow[]): InsightsSummary {
    const normalizedRows = rows.map(normalizeDailyRow);
    const totalDictations = normalizedRows.reduce((sum, row) => safeAdd(sum, row.dictations), 0);
    const totalWords = normalizedRows.reduce((sum, row) => safeAdd(sum, row.words), 0);
    const totalAudioSeconds = normalizedRows.reduce((sum, row) => safeAdd(sum, row.audioSeconds), 0);
    const totalProcessingMs = normalizedRows.reduce((sum, row) => safeAdd(sum, row.processingMs), 0);
    const confidenceSum = normalizedRows.reduce((sum, row) => safeAdd(sum, row.confidenceSum), 0);
    const confidenceCount = normalizedRows.reduce((sum, row) => safeAdd(sum, row.confidenceCount), 0);
    const busiest = [...normalizedRows].sort((a, b) => b.words - a.words || b.dictations - a.dictations)[0];

    return {
      totalDictations,
      totalWords,
      totalAudioSeconds,
      totalProcessingMs,
      avgConfidence: safeConfidence(confidenceSum, confidenceCount),
      // Weighted by recorded audio duration so a one-word clip cannot skew the speaking pace.
      avgWpm: calcWordsPerMinute(totalWords, totalAudioSeconds),
      avgProcessingRatio: calcProcessingRatio(totalAudioSeconds, totalProcessingMs),
      avgWordsPerDictation: totalDictations > 0 ? totalWords / totalDictations : 0,
      longestStreakDays: computeLongestStreak(rows),
      busiestDay: busiest && busiest.dictations > 0
        ? {
            date: busiest.day,
            label: formatTrendLabel(busiest.day),
            words: busiest.words,
            dictations: busiest.dictations,
          }
        : undefined,
    };
  }

  private getCommonWords(dayStart: string | null, limit: number): InsightsWordStat[] {
    if (!this.db) throw new Error('Database not initialized');
    const rows = dayStart === null
      ? this.db.prepare(`
          SELECT word, SUM(count) as count
          FROM insights_word_counts
          GROUP BY word
          ORDER BY count DESC, word ASC
          LIMIT @limit
        `).all({ limit }) as Array<{ word: string; count: number }>
      : this.db.prepare(`
          SELECT word, SUM(count) as count
          FROM insights_word_counts
          WHERE day >= @dayStart
          GROUP BY word
          ORDER BY count DESC, word ASC
          LIMIT @limit
        `).all({ dayStart, limit }) as Array<{ word: string; count: number }>;

    return sortWordStats(new Map(rows.map((row) => [row.word, row.count])), limit);
  }

  private getSourceEntries(rangeStart: number | null, limit: number): InsightSourceEntry[] {
    if (!this.db) throw new Error('Database not initialized');
    if (rangeStart === null) {
      return this.db.prepare(`
        SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
        FROM transcriptions
        ORDER BY timestamp DESC, id DESC
        LIMIT @limit
      `).all({ limit }).map(mapInsightSourceEntry);
    }

    return this.db.prepare(`
        SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
        FROM transcriptions
        WHERE timestamp >= @rangeStart
        ORDER BY timestamp DESC, id DESC
        LIMIT @limit
      `).all({ rangeStart, limit }).map(mapInsightSourceEntry);
  }

  private getLongestEntries(rangeStart: number | null, limit: number): InsightsEntryStat[] {
    if (!this.db) throw new Error('Database not initialized');
    const whereClause = rangeStart === null ? '' : 'WHERE timestamp >= @rangeStart';
    return this.db.prepare(`
      SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
      FROM transcriptions
      ${whereClause}
      ORDER BY COALESCE(audioDuration, 0) DESC, COALESCE(wordCount, 0) DESC
      LIMIT @limit
    `).all({ rangeStart, limit }).map(mapInsightSourceEntry).map(toEntryStat);
  }

  private getSlowestEntries(rangeStart: number | null, limit: number): InsightsEntryStat[] {
    if (!this.db) throw new Error('Database not initialized');
    const whereClause = rangeStart === null ? '' : 'AND timestamp >= @rangeStart';
    return this.db.prepare(`
      SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
      FROM transcriptions
      WHERE COALESCE(audioDuration, 0) > 0
        AND COALESCE(transcriptionTime, 0) > 0
        ${whereClause}
      ORDER BY (COALESCE(audioDuration, 0) / (COALESCE(transcriptionTime, 0) / 1000.0)) ASC,
        transcriptionTime DESC
      LIMIT @limit
    `).all({ rangeStart, limit }).map(mapInsightSourceEntry).map(toEntryStat);
  }
}

interface DailyRollupRow {
  day: string;
  dictations: number;
  words: number;
  audioSeconds: number;
  processingMs: number;
  confidenceSum: number;
  confidenceCount: number;
}

function normalizeDailyRow(row: DailyRollupRow): DailyRollupRow {
  return {
    day: typeof row.day === 'string' ? row.day : '',
    dictations: safeCount(row.dictations),
    words: safeCount(row.words),
    audioSeconds: safeNonNegative(row.audioSeconds),
    processingMs: safeNonNegative(row.processingMs),
    confidenceSum: safeNonNegative(row.confidenceSum),
    confidenceCount: safeCount(row.confidenceCount),
  };
}

function safeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeConfidence(sum: number, count: number): number {
  if (!Number.isFinite(sum) || !Number.isFinite(count) || count <= 0) return 0;
  return Math.min(1, Math.max(0, sum / count));
}

function safeAdd(first: number, second: number): number {
  const sum = first + second;
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function emptyDailyRow(day: string): DailyRollupRow {
  return {
    day,
    dictations: 0,
    words: 0,
    audioSeconds: 0,
    processingMs: 0,
    confidenceSum: 0,
    confidenceCount: 0,
  };
}

function buildRangeDayKeys(range: Exclude<InsightsRange, 'all'>, now: number): string[] {
  const start = getRangeStart(range, now) ?? now;
  const days = range === 'today' ? 1 : range === '7d' ? 7 : 30;
  return Array.from({ length: days }, (_, index) => getLocalDayKey(addLocalDays(start, index)));
}

function computeLongestStreak(rows: DailyRollupRow[]): number {
  let longest = 0;
  let current = 0;
  let previousDay: string | null = null;

  for (const row of rows.filter((item) => item.dictations > 0)) {
    const isConsecutive = previousDay !== null && getNextLocalDayKey(previousDay) === row.day;
    if (isConsecutive) {
      current += 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    previousDay = row.day;
  }

  return longest;
}

function getNextLocalDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split('-').map(Number);
  const localMidnight = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).getTime();
  return getLocalDayKey(addLocalDays(localMidnight, 1));
}

function toEntryStat(entry: InsightSourceEntry): InsightsEntryStat {
  const wordCount = safeCount(entry.wordCount ?? countWords(entry.text));
  const audioDuration = safeNonNegative(entry.audioDuration);
  const transcriptionTime = safeNonNegative(entry.transcriptionTime);
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    text: entry.text,
    wordCount,
    audioDuration,
    transcriptionTime,
    processingRatio: calcProcessingRatio(audioDuration, transcriptionTime),
  };
}

function mapTranscriptionEntry(row: unknown): TranscriptionEntry {
  const item = row as Record<string, unknown>;
  return {
    id: String(item.id),
    timestamp: Number(item.timestamp),
    text: String(item.text ?? ''),
    confidence: Number(item.confidence ?? 0),
    audioDuration: Number(item.audioDuration ?? 0),
    transcriptionTime: Number(item.transcriptionTime ?? 0),
    wordCount: item.wordCount === null || item.wordCount === undefined ? undefined : Number(item.wordCount),
    sessionMode: item.sessionMode === 'quick' || item.sessionMode === 'long' ? item.sessionMode : undefined,
    engine: optionalString(item.engine),
    model: optionalString(item.model),
    device: optionalString(item.device),
    computeType: optionalString(item.computeType),
    cudaActive: item.cudaActive === null || item.cudaActive === undefined ? undefined : Boolean(item.cudaActive),
    editedAt: item.editedAt === null || item.editedAt === undefined ? undefined : Number(item.editedAt),
    originalText: optionalString(item.originalText),
  };
}

function mapInsightSourceEntry(row: unknown): InsightSourceEntry {
  const item = row as Record<string, unknown>;
  return {
    id: String(item.id),
    timestamp: Number(item.timestamp),
    text: String(item.text ?? ''),
    confidence: Number(item.confidence ?? 0),
    audioDuration: Number(item.audioDuration ?? 0),
    transcriptionTime: Number(item.transcriptionTime ?? 0),
    wordCount: item.wordCount === null || item.wordCount === undefined ? undefined : Number(item.wordCount),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
