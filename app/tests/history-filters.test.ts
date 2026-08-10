import { describe, expect, test } from 'bun:test';
import { isHistoryFilters } from '../src/shared/history-validation.js';

describe('History filter IPC validation', () => {
  test('accepts the optional filter shape and finite numeric values', () => {
    expect(isHistoryFilters(undefined)).toBe(true);
    expect(isHistoryFilters({
      text: 'planning',
      dateFrom: 0,
      dateTo: 1,
      minDuration: 0,
      maxDuration: 60.5,
      minConfidence: 90,
      editedOnly: true,
    })).toBe(true);
  });

  test('rejects malformed, non-finite, and unknown filter payloads', () => {
    expect(isHistoryFilters(null)).toBe(false);
    expect(isHistoryFilters([])).toBe(false);
    expect(isHistoryFilters({ text: 42 })).toBe(false);
    expect(isHistoryFilters({ editedOnly: 'yes' })).toBe(false);
    expect(isHistoryFilters({ minDuration: Number.NaN })).toBe(false);
    expect(isHistoryFilters({ maxDuration: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isHistoryFilters({ unexpected: true })).toBe(false);
  });
});
