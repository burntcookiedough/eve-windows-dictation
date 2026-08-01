import type { ServerStatePayload } from '../../shared/types.js';

/**
 * Resolve the HTTP API endpoint for server settings and engine operations.
 *
 * Managed production servers bind an available port and publish it through
 * ServerManager. External-server mode must continue to use the user's saved
 * endpoint instead.
 */
export function resolveServerApiUrl(
  configuredUrl: string,
  state: Pick<ServerStatePayload, 'status' | 'wsUrl'> | null | undefined,
  useExternalServer: boolean,
): string {
  if (!useExternalServer && state?.status === 'running' && state.wsUrl) {
    return state.wsUrl;
  }
  return configuredUrl;
}
