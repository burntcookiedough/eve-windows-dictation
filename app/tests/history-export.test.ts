import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  exportHistoryToFile,
  HISTORY_EXPORT_CSV_HEADER,
  serializeHistoryCsvEntry,
  serializeHistoryJsonEntry,
  type HistoryExportEntrySource,
} from '../src/main/services/history-export.js';
import { isHistoryExportRequest } from '../src/shared/history-validation.js';
import type { TranscriptionEntry } from '../src/shared/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function entry(overrides: Partial<TranscriptionEntry> = {}): TranscriptionEntry {
  return {
    id: 'entry-1',
    timestamp: 1_750_000_000_000,
    text: 'Hello, "Eve"\nSecond line',
    audioDuration: 12.5,
    confidence: 0.91,
    transcriptionTime: 1450,
    wordCount: 4,
    sessionMode: 'quick',
    engine: 'whisper',
    model: 'large-v3-turbo',
    device: 'cuda',
    computeType: 'float16',
    cudaActive: true,
    editedAt: 1_750_000_001_000,
    originalText: '=2+2',
    ...overrides,
  };
}

describe('History export request validation', () => {
  test('accepts only the two supported scopes and formats', () => {
    expect(isHistoryExportRequest({ format: 'json', scope: 'all' })).toBe(true);
    expect(isHistoryExportRequest({ format: 'csv', scope: 'selected', ids: ['a', 'b'] })).toBe(true);

    expect(isHistoryExportRequest({ format: 'xml', scope: 'all' })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'selected', ids: [] })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'selected', ids: [''] })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'selected', ids: ['   '] })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'selected', ids: [' padded '] })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'selected', ids: ['a'.repeat(513)] })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'all', ids: ['a'] })).toBe(false);
    expect(isHistoryExportRequest({ format: 'json', scope: 'all', extra: true })).toBe(false);
  });
});

describe('History export serialization', () => {
  test('emits a stable JSON record with nullable optional fields', () => {
    expect(serializeHistoryJsonEntry(entry({
      wordCount: undefined,
      sessionMode: undefined,
      cudaActive: undefined,
      editedAt: undefined,
      originalText: undefined,
    }))).toBe(JSON.stringify({
      id: 'entry-1',
      timestamp: 1_750_000_000_000,
      text: 'Hello, "Eve"\nSecond line',
      audioDuration: 12.5,
      confidence: 0.91,
      transcriptionTime: 1450,
      wordCount: null,
      sessionMode: null,
      engine: 'whisper',
      model: 'large-v3-turbo',
      device: 'cuda',
      computeType: 'float16',
      cudaActive: null,
      editedAt: null,
      originalText: null,
    }));
  });

  test('quotes CSV fields and neutralizes spreadsheet formulas without changing JSON', () => {
    expect(HISTORY_EXPORT_CSV_HEADER).toBe(
      'id,timestamp,text,audioDuration,confidence,transcriptionTime,wordCount,sessionMode,engine,model,device,computeType,cudaActive,editedAt,originalText\r\n',
    );
    expect(serializeHistoryCsvEntry(entry())).toBe(
      '"entry-1",1750000000000,"Hello, ""Eve""\nSecond line",12.5,0.91,1450,4,"quick","whisper","large-v3-turbo","cuda","float16",true,1750000001000,"\'=2+2"\r\n',
    );
    expect(JSON.parse(serializeHistoryJsonEntry(entry())).originalText).toBe('=2+2');
    expect(serializeHistoryCsvEntry(entry({ text: '\n@formula' }))).toContain('"\'\n@formula"');
  });
});

describe('History export file boundary', () => {
  test('writes a valid empty export', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'eve-history-export-'));
    temporaryDirectories.push(directory);
    const destination = path.join(directory, 'empty.json');
    const source: HistoryExportEntrySource = {
      *iterateExportEntries() {},
    };

    expect(await exportHistoryToFile(
      source,
      { format: 'json', scope: 'all' },
      destination,
      new Date('2026-09-18T12:00:00.000Z'),
    )).toEqual({ status: 'saved', requestedCount: 0, exportedCount: 0, missingCount: 0 });
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
      schemaVersion: 1,
      exportedAt: '2026-09-18T12:00:00.000Z',
      entries: [],
      entryCount: 0,
    });
  });

  test('writes selected JSON atomically and reports missing IDs', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'eve-history-export-'));
    temporaryDirectories.push(directory);
    const destination = path.join(directory, 'history.json');
    writeFileSync(destination, 'previous file', 'utf8');
    const source: HistoryExportEntrySource = {
      *iterateExportEntries(ids) {
        expect(ids).toEqual(['entry-1', 'missing']);
        yield entry();
      },
    };

    const result = await exportHistoryToFile(
      source,
      { format: 'json', scope: 'selected', ids: ['entry-1', 'missing', 'entry-1'] },
      destination,
      new Date('2026-09-18T12:00:00.000Z'),
    );

    expect(result).toEqual({
      status: 'saved',
      requestedCount: 2,
      exportedCount: 1,
      missingCount: 1,
    });
    expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({
      schemaVersion: 1,
      exportedAt: '2026-09-18T12:00:00.000Z',
      entries: [JSON.parse(serializeHistoryJsonEntry(entry()))],
      entryCount: 1,
    });
    expect(readdirSync(directory)).toEqual(['history.json']);
  });

  test('leaves an existing destination untouched when export fails', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'eve-history-export-'));
    temporaryDirectories.push(directory);
    const destination = path.join(directory, 'history.csv');
    writeFileSync(destination, 'existing', 'utf8');
    const source: HistoryExportEntrySource = {
      *iterateExportEntries() {
        yield entry();
        throw new Error('forced export failure');
      },
    };

    await expect(exportHistoryToFile(
      source,
      { format: 'csv', scope: 'all' },
      destination,
    )).rejects.toThrow('forced export failure');

    expect(readFileSync(destination, 'utf8')).toBe('existing');
    expect(readdirSync(directory)).toEqual(['history.csv']);
  });
});
