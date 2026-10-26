import '../app.css';
import { mount, unmount } from 'svelte';
import HistoryView from '../views/HistoryView.svelte';
import type { HistoryFilters } from '$shared/types';

const entries = Array.from({ length: 65 }, (_, index) => ({
  id: `pagination-${index}`, timestamp: 1782900000000 - index * 1000,
  text: `Synthetic pagination entry ${index}`, confidence: 0.9,
  audioDuration: 5, transcriptionTime: 500, dateGroup: 'Today',
}));
const requests: Array<{ offset: number; text?: string }> = [];
const targets = new Map<IntersectionObserver, Set<Element>>();
const NativeObserver = window.IntersectionObserver;
window.IntersectionObserver = class extends NativeObserver {
  override observe(target: Element) {
    if (!targets.has(this)) targets.set(this, new Set());
    targets.get(this)!.add(target);
    super.observe(target);
  }
  override unobserve(target: Element) { targets.get(this)?.delete(target); super.unobserve(target); }
  override disconnect() { targets.delete(this); super.disconnect(); }
};
Object.assign(window, {
  murmurMain: {
    getHistoryEntries: async (offset: number, limit: number, filters?: HistoryFilters) => {
      requests.push({ offset, text: filters?.text });
      const matching = entries.filter(entry => !filters?.text || entry.text.includes(filters.text));
      return { entries: matching.slice(offset, offset + limit), hasMore: offset + limit < matching.length };
    },
    onNewHistoryEntry: () => () => {},
  },
});
const component = mount(HistoryView, { target: document.getElementById('fixture-root')! });
Object.assign(window, {
  paginationProbe: {
    requests,
    targets: () => [...targets.values()].flatMap(targets => [...targets]).map(target => ({ connected: target.isConnected })),
    unmount: () => unmount(component),
  },
});
