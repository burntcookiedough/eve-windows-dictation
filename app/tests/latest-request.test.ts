import { describe, expect, test } from 'bun:test';
import { createLatestRequestGuard } from '../src/renderer/app/latest-request.js';

describe('latest request guard', () => {
  test('rejects stale responses after a newer request starts', () => {
    const requests = createLatestRequestGuard();
    const first = requests.begin();
    const second = requests.begin();

    expect(requests.isCurrent(first)).toBeFalse();
    expect(requests.isCurrent(second)).toBeTrue();
  });

  test('invalidates an in-flight request during teardown', () => {
    const requests = createLatestRequestGuard();
    const request = requests.begin();
    requests.invalidate();

    expect(requests.isCurrent(request)).toBeFalse();
  });
});
