import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  HistoryExportRequest,
  HistoryExportResult,
  TranscriptionEntry,
} from '../../shared/types.js';

export interface HistoryExportEntrySource {
  iterateExportEntries(ids?: readonly string[]): Iterable<TranscriptionEntry>;
}

interface HistoryExportRecord {
  id: string;
  timestamp: number;
  text: string;
  audioDuration: number;
  confidence: number;
  transcriptionTime: number;
  wordCount: number | null;
  sessionMode: string | null;
  engine: string | null;
  model: string | null;
  device: string | null;
  computeType: string | null;
  cudaActive: boolean | null;
  editedAt: number | null;
  originalText: string | null;
}

const CSV_COLUMNS: ReadonlyArray<keyof HistoryExportRecord> = [
  'id',
  'timestamp',
  'text',
  'audioDuration',
  'confidence',
  'transcriptionTime',
  'wordCount',
  'sessionMode',
  'engine',
  'model',
  'device',
  'computeType',
  'cudaActive',
  'editedAt',
  'originalText',
];

export const HISTORY_EXPORT_CSV_HEADER = `${CSV_COLUMNS.join(',')}\r\n`;

function toHistoryExportRecord(entry: TranscriptionEntry): HistoryExportRecord {
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    text: entry.text,
    audioDuration: entry.audioDuration,
    confidence: entry.confidence,
    transcriptionTime: entry.transcriptionTime,
    wordCount: entry.wordCount ?? null,
    sessionMode: entry.sessionMode ?? null,
    engine: entry.engine ?? null,
    model: entry.model ?? null,
    device: entry.device ?? null,
    computeType: entry.computeType ?? null,
    cudaActive: entry.cudaActive ?? null,
    editedAt: entry.editedAt ?? null,
    originalText: entry.originalText ?? null,
  };
}

export function serializeHistoryJsonEntry(entry: TranscriptionEntry): string {
  return JSON.stringify(toHistoryExportRecord(entry));
}

function serializeCsvValue(value: HistoryExportRecord[keyof HistoryExportRecord]): string {
  if (value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  const protectedValue = /^\s*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

export function serializeHistoryCsvEntry(entry: TranscriptionEntry): string {
  const record = toHistoryExportRecord(entry);
  return `${CSV_COLUMNS.map((column) => serializeCsvValue(record[column])).join(',')}\r\n`;
}

function uniqueSelectedIds(request: HistoryExportRequest): string[] | undefined {
  return request.scope === 'selected' ? [...new Set(request.ids)] : undefined;
}

export async function exportHistoryToFile(
  source: HistoryExportEntrySource,
  request: HistoryExportRequest,
  destination: string,
  exportedAt = new Date(),
): Promise<HistoryExportResult> {
  const selectedIds = uniqueSelectedIds(request);
  const requestedIds = selectedIds ? new Set(selectedIds) : undefined;
  const foundIds = new Set<string>();
  const temporaryPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let moved = false;
  let exportedCount = 0;

  try {
    handle = await open(temporaryPath, 'wx');
    if (request.format === 'json') {
      await handle.writeFile(
        `{"schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt.toISOString())},"entries":[`,
        'utf8',
      );
    } else {
      await handle.writeFile(HISTORY_EXPORT_CSV_HEADER, 'utf8');
    }

    for (const entry of source.iterateExportEntries(selectedIds)) {
      if (requestedIds && !requestedIds.has(entry.id)) continue;
      if (foundIds.has(entry.id)) continue;
      foundIds.add(entry.id);

      if (request.format === 'json') {
        await handle.writeFile(
          `${exportedCount > 0 ? ',' : ''}${serializeHistoryJsonEntry(entry)}`,
          'utf8',
        );
      } else {
        await handle.writeFile(serializeHistoryCsvEntry(entry), 'utf8');
      }
      exportedCount += 1;
    }

    if (request.format === 'json') {
      await handle.writeFile(`],"entryCount":${exportedCount}}`, 'utf8');
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, destination);
    moved = true;

    const requestedCount = selectedIds?.length ?? exportedCount;
    return {
      status: 'saved',
      requestedCount,
      exportedCount,
      missingCount: requestedCount - exportedCount,
    };
  } finally {
    await handle?.close().catch(() => undefined);
    if (!moved) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
