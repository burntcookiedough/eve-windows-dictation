import { describe, expect, test } from 'bun:test';
import {
  LOGIN_ITEM_CUTOVER_DEFERRED,
  validateLaunchOnBootUpdate,
} from '../src/main/login-item-policy';

describe('launch-on-login Gate 2 boundary', () => {
  test('rejects enabling launch-on-login before settings persistence', () => {
    expect(() => validateLaunchOnBootUpdate(true)).toThrow(LOGIN_ITEM_CUTOVER_DEFERRED);
  });

  test('allows the fresh-profile disabled value without an OS write', () => {
    expect(() => validateLaunchOnBootUpdate(false)).not.toThrow();
  });
});
