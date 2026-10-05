import { toast } from '$lib/toast.svelte';
import { canUndoDeferredDelete, markDeferredDeleteCommitting } from './history-delete-policy.js';

const DELETE_DELAY_MS = 5000;

export interface PendingHistoryDelete {
  id: string;
  committing: boolean;
}

class HistoryDeleteQueueState {
  items = $state<PendingHistoryDelete[]>([]);

  add(item: PendingHistoryDelete): void {
    this.items = [...this.items.filter((current) => current.id !== item.id), item];
  }

  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id);
  }
}

export const pendingHistoryDeletes = new HistoryDeleteQueueState();

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const deadlines = new Map<string, number>();
const committing = new Map<string, Promise<void>>();

export function deferHistoryDelete(id: string): void {
  if (pendingHistoryDeletes.items.some((item) => item.id === id)) return;
  pendingHistoryDeletes.add({ id, committing: false });
  scheduleCommit(id, DELETE_DELAY_MS);
}

export function undoDeferredHistoryDelete(id: string): void {
  const pending = pendingHistoryDeletes.items.find((item) => item.id === id);
  if (pending && !canUndoDeferredDelete(pending)) return;
  clearTimer(id);
  pendingHistoryDeletes.remove(id);
}

export function flushExpiredDeferredHistoryDeletes(): void {
  const now = Date.now();
  for (const item of pendingHistoryDeletes.items) {
    const deadline = deadlines.get(item.id);
    if (item.committing || deadline === undefined || deadline > now) continue;
    clearTimer(item.id);
    void commitDeferredDelete(item.id);
  }
}

export async function flushDeferredHistoryDeletes(): Promise<void> {
  await Promise.all(pendingHistoryDeletes.items.map(({ id }) => commitDeferredDelete(id)));
}

function scheduleCommit(id: string, delayMs: number): void {
  clearTimer(id);
  deadlines.set(id, Date.now() + Math.max(0, delayMs));
  const timer = setTimeout(() => {
    timers.delete(id);
    deadlines.delete(id);
    void commitDeferredDelete(id);
  }, Math.max(0, delayMs));
  timers.set(id, timer);
}

function commitDeferredDelete(id: string): Promise<void> {
  const currentCommit = committing.get(id);
  if (currentCommit) return currentCommit;
  const pending = pendingHistoryDeletes.items.find((item) => item.id === id);
  if (!pending || !canUndoDeferredDelete(pending)) return Promise.resolve();
  clearTimer(id);
  pendingHistoryDeletes.add(markDeferredDeleteCommitting(pending));
  const request = finishDeferredDelete(id);
  committing.set(id, request);
  void request.finally(() => committing.delete(id));
  return request;
}

async function finishDeferredDelete(id: string): Promise<void> {
  try {
    await window.murmurMain.deleteHistoryEntry(id);
    pendingHistoryDeletes.remove(id);
    toast('Dictation deleted', 'info');
    dispatchDeleteCommitted(id, true);
  } catch (error) {
    console.error('Failed to delete transcription:', error);
    pendingHistoryDeletes.remove(id);
    toast('Delete failed; transcription restored', 'error');
    dispatchDeleteCommitted(id, false);
  }
}

function clearTimer(id: string): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
  deadlines.delete(id);
}

function dispatchDeleteCommitted(id: string, deleted: boolean): void {
  window.dispatchEvent(new CustomEvent('history-delete-committed', { detail: { ids: [id], deleted } }));
}

const quitFlushWindow = window as Window & { __flushDeferredHistoryDeletesOnQuit?: () => Promise<void> };
quitFlushWindow.__flushDeferredHistoryDeletesOnQuit = flushDeferredHistoryDeletes;

window.addEventListener('pagehide', () => {
  void flushDeferredHistoryDeletes();
});
