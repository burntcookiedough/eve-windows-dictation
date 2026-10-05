export interface DeferredDeleteState {
  committing: boolean;
}

export function markDeferredDeleteCommitting<T extends DeferredDeleteState>(item: T): T {
  return { ...item, committing: true };
}

export function canUndoDeferredDelete(item: DeferredDeleteState): boolean {
  return !item.committing;
}
