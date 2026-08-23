import type { ServerStatePayload } from '../../shared/types.js';

export const LOCAL_SERVER_URL = 'ws://localhost:51717/transcribe';

/**
 * Resolve the HTTP API endpoint for server settings and engine operations.
 *
 * Managed servers bind an available port and publish it through ServerManager.
 * Callers may provide a fallback for development; packaged callers must omit it
 * until a managed endpoint has been discovered.
 */
export function resolveServerApiUrl(
  configuredUrl: string | undefined,
  state: Pick<ServerStatePayload, 'status' | 'wsUrl'> | null | undefined,
): string | undefined {
  if (state?.status === 'running' && state.wsUrl) {
    return state.wsUrl;
  }
  return configuredUrl;
}
