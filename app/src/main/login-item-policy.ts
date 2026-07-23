export const LOGIN_ITEM_CUTOVER_DEFERRED = 'LOGIN_ITEM_CUTOVER_DEFERRED';

export function validateLaunchOnBootUpdate(enabled: boolean): void {
  if (enabled) {
    throw new Error(LOGIN_ITEM_CUTOVER_DEFERRED);
  }
}
