import { describe, expect, test } from 'bun:test';
import { canUndoDeferredDelete, markDeferredDeleteCommitting } from '../src/renderer/app/history-delete-policy';

describe('deferred history delete boundary', () => {
  test('Undo stops being available as soon as the database commit starts', () => {
    const waiting = { id: 'entry-1', remainingMs: 0, committing: false };
    expect(canUndoDeferredDelete(waiting)).toBe(true);

    const committing = markDeferredDeleteCommitting(waiting);
    expect(committing.committing).toBe(true);
    expect(canUndoDeferredDelete(committing)).toBe(false);
    expect(canUndoDeferredDelete(waiting)).toBe(true);
  });
});
