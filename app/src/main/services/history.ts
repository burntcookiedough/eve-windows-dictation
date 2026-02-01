import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import type { TranscriptionEntry } from '../../shared/types.js';
import type { HistoryFilters, HistoryEntryWithGroup, HistoryResponse } from '../../shared/types.js';

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

  constructor() {
    const userDataPath = app.getPath('userData');
    this.dbPath = path.join(userDataPath, 'history.db');
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
        editedAt INTEGER,
        originalText TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_timestamp ON transcriptions(timestamp DESC);
    `);
  }

  save(entry: TranscriptionEntry): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO transcriptions (id, timestamp, text, confidence, audioDuration, transcriptionTime, editedAt, originalText)
      VALUES (@id, @timestamp, @text, @confidence, @audioDuration, @transcriptionTime, @editedAt, @originalText)
    `);

    stmt.run({
      id: entry.id,
      timestamp: entry.timestamp,
      text: entry.text,
      confidence: entry.confidence,
      audioDuration: entry.audioDuration,
      transcriptionTime: entry.transcriptionTime,
      editedAt: entry.editedAt ?? null,
      originalText: entry.originalText ?? null,
    });
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
      SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, editedAt, originalText
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
    }) as TranscriptionEntry[];

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
    stmt.run({ id });
  }

  getById(id: string): TranscriptionEntry | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT id, timestamp, text, confidence, audioDuration, transcriptionTime, editedAt, originalText
      FROM transcriptions
      WHERE id = @id
    `);

    return (stmt.get({ id }) as TranscriptionEntry) ?? null;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
