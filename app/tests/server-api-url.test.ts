import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveServerApiUrl } from '../src/main/services/server-api-url';

describe('server API endpoint selection', () => {
  const configured = 'ws://localhost:51717/transcribe';
  const dynamic = 'ws://localhost:51490/transcribe';

  test('uses the manager-reported dynamic endpoint for managed running servers', () => {
    expect(resolveServerApiUrl(configured, { status: 'running', wsUrl: dynamic })).toBe(dynamic);
    expect(resolveServerApiUrl(configured, { status: 'starting' })).toBe(configured);
  });

  test('requires a discovered endpoint in packaged mode while preserving the development fallback', () => {
    expect(resolveServerApiUrl(configured, null)).toBe(configured);
    expect(resolveServerApiUrl(undefined, null)).toBeUndefined();
    expect(resolveServerApiUrl(undefined, { status: 'stopped', wsUrl: dynamic })).toBeUndefined();
  });

  test('fails closed before packaged API settings calls can use localhost', () => {
    const source = readFileSync(new URL('../src/main/ipc/handlers.ts', import.meta.url), 'utf8');
    expect(source).toContain('const configuredUrl = app.isPackaged ? undefined : LOCAL_SERVER_URL;');
    expect(source).toContain("throw new Error('Managed server URL unavailable');");
  });
});
