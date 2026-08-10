export const MAX_SERVER_LOG_ENTRIES = 500;
export const SHORT_SERVER_LOG_ENTRY_LIMIT = 12;
export const SERVER_LOG_LOAD_ERROR = 'Server logs are unavailable right now.';

export type ServerLogLoadState = 'loading' | 'ready' | 'error';
export type ServerLogBodySize = 'empty' | 'short' | 'long';

function normalizeLogCount(count: number): number {
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.floor(count));
}

export function getServerLogBodySize(state: ServerLogLoadState, count: number): ServerLogBodySize {
  const normalizedCount = normalizeLogCount(count);
  if (state !== 'ready' || normalizedCount === 0) return 'empty';
  return normalizedCount <= SHORT_SERVER_LOG_ENTRY_LIMIT ? 'short' : 'long';
}

export function getServerLogCountLabel(state: ServerLogLoadState, count: number): string {
  if (state === 'loading') return 'Loading';
  if (state === 'error') return 'Unavailable';

  const normalizedCount = normalizeLogCount(count);
  if (normalizedCount === 0) return 'No logs';
  return `${normalizedCount} ${normalizedCount === 1 ? 'log' : 'logs'}`;
}
