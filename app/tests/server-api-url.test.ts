import { describe, expect, test } from 'bun:test';
import { resolveServerApiUrl } from '../src/main/services/server-api-url';

describe('server API endpoint selection', () => {
  const configured = 'ws://localhost:51717/transcribe';
  const dynamic = 'ws://localhost:51490/transcribe';

  test('uses the manager-reported dynamic endpoint for managed running servers', () => {
    expect(resolveServerApiUrl(configured, { status: 'running', wsUrl: dynamic })).toBe(dynamic);
    expect(resolveServerApiUrl(configured, { status: 'starting' })).toBe(configured);
  });

  test('falls back to localhost until the manager reports a running server', () => {
    expect(resolveServerApiUrl(configured, null)).toBe(configured);
    expect(resolveServerApiUrl(configured, { status: 'stopped', wsUrl: dynamic })).toBe(configured);
  });
});
