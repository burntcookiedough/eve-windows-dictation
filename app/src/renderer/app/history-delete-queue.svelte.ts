import { toast } from '$lib/toast.svelte';
import { canUndoDeferredDelete, markDeferredDeleteCommitting } from './history-delete-policy.js';

const DELETE_DELAY_MS = 5000;

export interface PendingHistoryDelete {
  id: string;
  remainingMs: number;
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
let paused = true;

export function deferHistoryDelete(id: string): void {
  if (pendingHistoryDeletes.items.some((item) => item.id === id)) return;
  const remainingMs = DELETE_DELAY_MS;
  pendingHistoryDeletes.add({ id, remainingMs, committing: false });
  if (!paused) scheduleCommit(id, remainingMs);
}

export function undoDeferredHistoryDelete(id: string): void {
  const pending = pendingHistoryDeletes.items.find((item) => item.id === id);
  if (pending && !canUndoDeferredDelete(pending)) return;
  clearTimer(id);
  pendingHistoryDeletes.remove(id);
}

export function pauseDeferredHistoryDeletes(): void {
  if (paused) return;
  paused = true;
  for (const item of pendingHistoryDeletes.items) {
    if (item.committing) continue;
    const deadline = deadlines.get(item.id);
    const remainingMs = deadline === undefined ? item.remainingMs : Math.max(0, deadline - Date.now());
    clearTimer(item.id);
    pendingHistoryDeletes.add({ ...item, remainingMs });
  }
}

export function resumeDeferredHistoryDeletes(): void {
  if (!paused) return;
  paused = false;
  for (const item of pendingHistoryDeletes.items) {
    if (!item.committing) scheduleCommit(item.id, item.remainingMs);
  }
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

async function commitDeferredDelete(id: string): Promise<void> {
  const pending = pendingHistoryDeletes.items.find((item) => item.id === id);
  if (!pending || !canUndoDeferredDelete(pending)) return;
  pendingHistoryDeletes.add(markDeferredDeleteCommitting(pending));
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
