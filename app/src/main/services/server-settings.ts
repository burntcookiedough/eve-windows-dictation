import type { ServerSettingsResponse, EngineStatus, AvailableEngine } from '../../shared/types.js';
import { getSetting } from './settings.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ServerSettings');

/**
 * Derive the server base URL from the WebSocket URL in settings.
 * e.g. "ws://localhost:51717/transcribe" → "http://localhost:51717"
 */
function getBaseUrl(): string {
  const wsUrl = getSetting('serverUrl');
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  // Strip path (e.g. /transcribe) to get the base
  url.pathname = '';
  return url.origin;
}

async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const base = getBaseUrl();
  const url = `${base}${path}`;
  log.debug('Fetching', { url, method: options?.method ?? 'GET' });

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Server returned ${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}

export async function getServerSettings(): Promise<ServerSettingsResponse> {
  return fetchJson<ServerSettingsResponse>('/settings');
}

export async function updateServerSettings(
  patch: Record<string, unknown>
): Promise<ServerSettingsResponse> {
  return fetchJson<ServerSettingsResponse>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function getEngineStatus(): Promise<EngineStatus> {
  return fetchJson<EngineStatus>('/engine/status');
}

export async function getAvailableEngines(): Promise<AvailableEngine[]> {
  const data = await fetchJson<{ engines: AvailableEngine[] }>('/engines');
  return data.engines;
}
