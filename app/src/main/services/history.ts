import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import {
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

export class HistoryService {
  private db: Database.Database | null = null;
  private dbPath: string;

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
    this.rebuildInsights();
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

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    // Build WHERE clause from filters
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

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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

  delete(id: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM transcriptions WHERE id = @id');
    const result = stmt.run({ id });
    if (result.changes > 0) {
      this.rebuildInsights();
    }
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

  getInsights(range: InsightsRange): InsightsResponse {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const rangeStart = getRangeStart(range, now);
    const dayStart = rangeStart === null ? null : getLocalDayKey(rangeStart);
    const rows = this.getDailyRows(dayStart);
    const trends = this.buildTrends(rows, range, now);
    const summary = this.buildSummary(rows);
    const commonWords = this.getCommonWords(dayStart, 18);
    const sourceEntries = this.getSourceEntries(rangeStart);
    const commonPhrases = buildPhraseStats(sourceEntries, 12);
    const entryStats = sourceEntries.map(toEntryStat);
    const longestEntries = [...entryStats]
      .sort((a, b) => b.audioDuration - a.audioDuration || b.wordCount - a.wordCount)
      .slice(0, 5);
    const slowestEntries = [...entryStats]
      .filter((entry) => entry.transcriptionTime > 0 && entry.processingRatio > 0)
      .sort((a, b) => a.processingRatio - b.processingRatio || b.transcriptionTime - a.transcriptionTime)
      .slice(0, 5);

    return {
      range,
      generatedAt: now,
      hasData: summary.totalDictations > 0,
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

      CREATE INDEX IF NOT EXISTS idx_insights_word_counts_word ON insights_word_counts(word);
    `);
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
  }

  private getDailyRows(dayStart: string | null): DailyRollupRow[] {
    if (!this.db) throw new Error('Database not initialized');
    if (dayStart === null) {
      return this.db.prepare(`
        SELECT day, dictations, words, audioSeconds, processingMs, confidenceSum, confidenceCount
        FROM insights_daily_rollups
        ORDER BY day ASC
      `).all() as DailyRollupRow[];
    }

    return this.db.prepare(`
      SELECT day, dictations, words, audioSeconds, processingMs, confidenceSum, confidenceCount
      FROM insights_daily_rollups
      WHERE day >= @dayStart
      ORDER BY day ASC
    `).all({ dayStart }) as DailyRollupRow[];
  }

  private buildTrends(rows: DailyRollupRow[], range: InsightsRange, now: number): InsightsTrendPoint[] {
    const rowMap = new Map(rows.map((row) => [row.day, row]));
    const activeRows = range === 'all'
      ? rows
      : buildRangeDayKeys(range, now).map((day) => rowMap.get(day) ?? emptyDailyRow(day));

    return activeRows.map((row) => ({
      date: row.day,
      label: formatTrendLabel(row.day),
      dictations: row.dictations,
      words: row.words,
      audioSeconds: row.audioSeconds,
      processingMs: row.processingMs,
      avgWpm: calcWordsPerMinute(row.words, row.audioSeconds),
      avgConfidence: row.confidenceCount > 0 ? row.confidenceSum / row.confidenceCount : 0,
      avgProcessingRatio: calcProcessingRatio(row.audioSeconds, row.processingMs),
    }));
  }

  private buildSummary(rows: DailyRollupRow[]): InsightsSummary {
    const totalDictations = rows.reduce((sum, row) => sum + row.dictations, 0);
    const totalWords = rows.reduce((sum, row) => sum + row.words, 0);
    const totalAudioSeconds = rows.reduce((sum, row) => sum + row.audioSeconds, 0);
    const totalProcessingMs = rows.reduce((sum, row) => sum + row.processingMs, 0);
    const confidenceSum = rows.reduce((sum, row) => sum + row.confidenceSum, 0);
    const confidenceCount = rows.reduce((sum, row) => sum + row.confidenceCount, 0);
    const busiest = [...rows].sort((a, b) => b.words - a.words || b.dictations - a.dictations)[0];

    return {
      totalDictations,
      totalWords,
      totalAudioSeconds,
      totalProcessingMs,
      avgConfidence: confidenceCount > 0 ? confidenceSum / confidenceCount : 0,
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

  private getSourceEntries(rangeStart: number | null): InsightSourceEntry[] {
    if (!this.db) throw new Error('Database not initialized');
    if (rangeStart === null) {
      return this.db.prepare(`
        SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
        FROM transcriptions
        ORDER BY timestamp DESC
      `).all().map(mapInsightSourceEntry);
    }

    return this.db.prepare(`
        SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, wordCount
        FROM transcriptions
        WHERE timestamp >= @rangeStart
        ORDER BY timestamp DESC
      `).all({ rangeStart }).map(mapInsightSourceEntry);
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
  return Array.from({ length: days }, (_, index) => getLocalDayKey(start + index * 86400000));
}

function computeLongestStreak(rows: DailyRollupRow[]): number {
  let longest = 0;
  let current = 0;
  let previousTime: number | null = null;

  for (const row of rows.filter((item) => item.dictations > 0)) {
    const timestamp = new Date(`${row.day}T00:00:00`).getTime();
    if (previousTime !== null && timestamp - previousTime === 86400000) {
      current += 1;
    } else {
      current = 1;
    }
    longest = Math.max(longest, current);
    previousTime = timestamp;
  }

  return longest;
}

function toEntryStat(entry: InsightSourceEntry): InsightsEntryStat {
  const wordCount = entry.wordCount ?? countWords(entry.text);
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    text: entry.text,
    wordCount,
    audioDuration: entry.audioDuration || 0,
    transcriptionTime: entry.transcriptionTime || 0,
    processingRatio: calcProcessingRatio(entry.audioDuration || 0, entry.transcriptionTime || 0),
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
