import { describe, expect, test } from 'bun:test';
import { resolveServerApiUrl } from '../src/main/services/server-api-url';

describe('server API endpoint selection', () => {
  const configured = 'ws://localhost:51717/transcribe';
  const dynamic = 'ws://localhost:51490/transcribe';

  test('uses the manager-reported dynamic endpoint for managed running servers', () => {
    expect(resolveServerApiUrl(configured, { status: 'running', wsUrl: dynamic }, false)).toBe(dynamic);
    expect(resolveServerApiUrl(configured, { status: 'starting' }, false)).toBe(configured);
  });

  test('preserves the configured endpoint for external-server mode', () => {
    expect(resolveServerApiUrl(configured, { status: 'running', wsUrl: dynamic }, true)).toBe(configured);
  });
});
