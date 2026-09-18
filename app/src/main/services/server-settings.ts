import type { ServerSettingsResponse, EngineStatus, AvailableEngine, ModelCatalogItem } from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ServerSettings');
// Engine status can include a server-side GPU probe with a two-second ceiling.
const SERVER_SETTINGS_REQUEST_TIMEOUT_MS = 3000;

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
  const response = await fetchJson<ServerSettingsResponse>('/settings', undefined, serverUrl);
  return {
    ...response,
    // Older servers omit this field.  Normalize it to an empty list so callers
    // can render raw compatibility controls without inventing model metadata.
    model_catalog: normalizeModelCatalog(response.model_catalog),
  };
}

export async function updateServerSettings(
  patch: Record<string, unknown>,
  serverUrl: string,
): Promise<ServerSettingsResponse> {
  const response = await fetchJson<ServerSettingsResponse>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  }, serverUrl);
  return {
    ...response,
    model_catalog: normalizeModelCatalog(response.model_catalog),
  };
}

export async function getEngineStatus(serverUrl: string): Promise<EngineStatus> {
  return fetchJson<EngineStatus>('/engine/status', undefined, serverUrl);
}

export async function getAvailableEngines(serverUrl: string): Promise<AvailableEngine[]> {
  const data = await fetchJson<{ engines: AvailableEngine[] }>('/engines', undefined, serverUrl);
  return data.engines;
}

/**
 * Parse the optional server catalog at the transport seam.
 *
 * The function accepts unknown input because a renderer can be paired with a
 * previous server build.  Invalid entries are ignored rather than becoming
 * guessed choices; the raw settings editor remains available for custom/local
 * models in that case.
 */
export function normalizeModelCatalog(value: unknown): ModelCatalogItem[] {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { models?: unknown }).models)
      ? (value as { models: unknown[] }).models
      : [];

  const result: ModelCatalogItem[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const languages = raw.languages;
    if (
      typeof raw.model !== 'string' || raw.model.trim().length === 0
      || typeof raw.label !== 'string' || raw.label.trim().length === 0
      || typeof raw.repo_id !== 'string' || raw.repo_id.trim().length === 0
      || typeof raw.size_gb !== 'number' || !Number.isFinite(raw.size_gb) || raw.size_gb <= 0
      || !Array.isArray(languages) || languages.some((language) => typeof language !== 'string')
      || typeof raw.supports_hotwords !== 'boolean'
    ) {
      continue;
    }

    const normalizedLanguages = languages.map((language) => language.trim()).filter(Boolean);
    if (normalizedLanguages.length === 0) continue;

    const languageLabel = typeof raw.language_label === 'string' && raw.language_label.trim().length > 0
      ? raw.language_label.trim()
      : normalizedLanguages.join(', ');
    const summary = typeof raw.summary === 'string' ? raw.summary : '';
    result.push({
      model: raw.model.trim(),
      label: raw.label.trim(),
      summary,
      repo_id: raw.repo_id.trim(),
      size_gb: raw.size_gb,
      language_label: languageLabel,
      languages: normalizedLanguages,
      supports_hotwords: raw.supports_hotwords,
    });
  }
  return result;
}
