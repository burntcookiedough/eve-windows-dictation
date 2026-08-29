import type { ServerSettingsResponse, EngineStatus, AvailableEngine } from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ServerSettings');
const SERVER_SETTINGS_REQUEST_TIMEOUT_MS = 2000;

/**
 * Derive the server base URL from a WebSocket endpoint.
 * e.g. "ws://localhost:51717/transcribe" → "http://localhost:51717"
 */
function getBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  // Strip path (e.g. /transcribe) to get the base
  url.pathname = '';
  return url.origin;
}

async function fetchJson<T>(path: string, options: RequestInit | undefined, serverUrl: string): Promise<T> {
  const base = getBaseUrl(serverUrl);
  const url = `${base}${path}`;
  log.debug('Fetching', { url, method: options?.method ?? 'GET' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVER_SETTINGS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Server returned ${response.status}: ${body}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getServerSettings(serverUrl: string): Promise<ServerSettingsResponse> {
  return fetchJson<ServerSettingsResponse>('/settings', undefined, serverUrl);
}

export async function updateServerSettings(
  patch: Record<string, unknown>,
  serverUrl: string,
): Promise<ServerSettingsResponse> {
  return fetchJson<ServerSettingsResponse>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }, serverUrl);
}

export async function getEngineStatus(serverUrl: string): Promise<EngineStatus> {
  return fetchJson<EngineStatus>('/engine/status', undefined, serverUrl);
}

export async function getAvailableEngines(serverUrl: string): Promise<AvailableEngine[]> {
  const data = await fetchJson<{ engines: AvailableEngine[] }>('/engines', undefined, serverUrl);
  return data.engines;
}
