import type { HistoryExportRequest, HistoryFilters } from './types.js';

const HISTORY_FILTER_KEYS = new Set([
  'text',
  'dateFrom',
  'dateTo',
  'minDuration',
  'maxDuration',
  'minConfidence',
  'editedOnly',
]);

const NUMERIC_HISTORY_FILTER_KEYS = [
  'dateFrom',
  'dateTo',
  'minDuration',
  'maxDuration',
  'minConfidence',
] as const;

export function isHistoryFilters(value: unknown): value is HistoryFilters | undefined {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const filters = value as Record<string, unknown>;
  if (Object.keys(filters).some((key) => !HISTORY_FILTER_KEYS.has(key))) return false;
  if (filters.text !== undefined && typeof filters.text !== 'string') return false;
  if (filters.editedOnly !== undefined && typeof filters.editedOnly !== 'boolean') return false;

  return NUMERIC_HISTORY_FILTER_KEYS.every((key) => {
    const candidate = filters[key];
    return candidate === undefined || (typeof candidate === 'number' && Number.isFinite(candidate));
  });
}

export function isHistoryExportRequest(value: unknown): value is HistoryExportRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;

  const request = value as Record<string, unknown>;
  if (request.format !== 'json' && request.format !== 'csv') return false;

  if (request.scope === 'all') {
    return Object.keys(request).every((key) => key === 'format' || key === 'scope');
  }

  if (request.scope !== 'selected') return false;
  if (Object.keys(request).some((key) => !['format', 'scope', 'ids'].includes(key))) return false;
  return Array.isArray(request.ids)
    && request.ids.length > 0
    && request.ids.every(
      (id) => typeof id === 'string' && id.trim() === id && id.length > 0 && id.length <= 512,
    );
}
