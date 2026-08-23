import type { ServerStatePayload } from '../../shared/types.js';

export const LOCAL_SERVER_URL = 'ws://localhost:51717/transcribe';

/**
 * Resolve the HTTP API endpoint for server settings and engine operations.
 *
 * Managed servers bind an available port and publish it through ServerManager.
 * The localhost URL is only a development fallback while no server is running.
 */
export function resolveServerApiUrl(
  configuredUrl: string,
  state: Pick<ServerStatePayload, 'status' | 'wsUrl'> | null | undefined,
): string {
  if (state?.status === 'running' && state.wsUrl) {
    return state.wsUrl;
  }
  return configuredUrl;
}
