export const LOGIN_ITEM_CUTOVER_DEFERRED = 'LOGIN_ITEM_CUTOVER_DEFERRED';

export function validateLaunchOnBootUpdate(enabled: unknown): asserts enabled is boolean {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('launchOnBoot must be a boolean');
  }
  if (enabled) {
    throw new Error(LOGIN_ITEM_CUTOVER_DEFERRED);
  }
}
