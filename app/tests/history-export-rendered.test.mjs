import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dir, '..');
const screenshotDir = resolve(tmpdir(), `eve-history-export-screenshots-${process.pid}`);
const vitePort = 53600 + (process.pid % 100);
const fixtureTimeoutMs = 45_000;
const fixtureUrl = `http://127.0.0.1:${vitePort}/app/fixtures/history-export-fixture.html`;
const vite = Bun.spawn(['node', resolve(appRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], {
  cwd: appRoot,
  env: { ...process.env, MURMUR_DEV_PORT: String(vitePort) },
  stdout: 'ignore',
  stderr: 'pipe',
  windowsHide: true,
});

let viteStopped = false;
async function stopVite() {
  if (viteStopped) return;
  viteStopped = true;
  vite.kill();
  await vite.exited;
}

afterAll(stopVite);

let result;
try {
  let fixtureReady = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(fixtureUrl)).ok) {
        fixtureReady = true;
        break;
      }
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (!fixtureReady) {
    await stopVite();
    const stderr = await new Response(vite.stderr).text();
    throw new Error(`History export fixture server did not start: ${stderr}`);
  }

  const child = Bun.spawn([
    resolve(appRoot, 'node_modules/electron/dist/electron.exe'),
    resolve(appRoot, 'tests/fixtures/history-export-electron.cjs'),
    fixtureUrl,
  ], {
    cwd: appRoot,
    env: { ...process.env, EVE_HISTORY_EXPORT_SCREENSHOT_DIR: screenshotDir },
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  let watchdog;
  const completed = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, code]) => ({ kind: 'completed', stdout, stderr, code }));
  const timedOut = new Promise((resolveTimeout) => {
    watchdog = setTimeout(() => resolveTimeout({ kind: 'timeout' }), fixtureTimeoutMs);
  });
  const outcome = await Promise.race([completed, timedOut]);
  clearTimeout(watchdog);
  if (outcome.kind === 'timeout') {
    child.kill();
    await Promise.race([child.exited, new Promise((resolveWait) => setTimeout(resolveWait, 5000))]);
    await fs.rm(resolve(tmpdir(), `eve-history-export-${child.pid}`), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    throw new Error(`History export fixture exceeded its ${fixtureTimeoutMs}ms watchdog and was terminated`);
  }
  const { stdout, stderr, code } = outcome;
  if (code !== 0) {
    await fs.rm(resolve(tmpdir(), `eve-history-export-${child.pid}`), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    throw new Error(`History export fixture exited ${code}: ${stderr || stdout}`);
  }
  result = JSON.parse(stdout);
  await fs.rm(result.userDataPath, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} catch (error) {
  await stopVite();
  throw error;
}

describe('rendered History export controls', () => {
  test('contains controls without horizontal overflow at narrow widths and 200% zoom', () => {
    expect(result.measurements.length).toBe(5);
    for (const measurement of result.measurements) {
      expect(measurement.owner.scrollWidth).toBeLessThanOrEqual(measurement.owner.clientWidth);
      expect(measurement.document.scrollWidth).toBeLessThanOrEqual(measurement.document.clientWidth);
      if (measurement.state === 'selected') {
        expect(measurement.hasFormat).toBeTrue();
        expect(measurement.controlHeights.length).toBeGreaterThan(0);
        for (const height of measurement.controlHeights) expect(height).toBeGreaterThan(14);
        expect(measurement.deleteActionStyle.background).toBe('rgba(0, 0, 0, 0)');
        expect(measurement.deleteActionStyle.decoration).toBe('underline');
      } else {
        expect(measurement.hasFormat).toBeFalse();
      }
    }
  });

  test('renders explicit all and selected export states', () => {
    const all = result.measurements.find((measurement) => measurement.state === 'all');
    const selected = result.measurements.find((measurement) => measurement.state === 'selected');
    expect(all.hasExportAll).toBeTrue();
    expect(all.hasExportSelected).toBeFalse();
    expect(selected.hasExportAll).toBeFalse();
    expect(selected.hasExportSelected).toBeTrue();
    expect(selected.selectedCount).toBe('1 selected');
  });

  test('keeps type tabs and the quiet More Filters control together above the action row', () => {
    const compact = result.measurements.find((measurement) => measurement.state === 'all' && measurement.zoom === 1 && measurement.viewport.width === 360);
    expect(compact).toBeDefined();
    expect(compact?.filterControlRow).not.toBeNull();
    if (!compact) return;
    expect(Math.abs((compact.moreFilters.top + compact.moreFilters.height / 2) - (compact.filterControlRow.top + compact.filterControlRow.height / 2))).toBeLessThan(1);
    expect(compact.toolbarActions.top).toBeGreaterThanOrEqual(compact.filterControlRow.bottom);
    expect(result.historyControls.tabIds).toEqual({
      all: ['fixture-1', 'fixture-2'],
      quick: ['fixture-1'],
      long: ['fixture-2'],
      edited: ['fixture-1'],
    });
  });

  test('search, extended filters, expansion, copy, deferred Undo, and delete use History handlers', () => {
    expect(result.historyControls.shortcuts).toEqual({ ignoredInactive: true, focusesSearchWhenActive: true });
    expect(result.historyControls.search).toEqual({
      ids: ['fixture-1'],
      highlight: 'release',
      filter: { text: 'release' },
    });
    expect(result.historyControls.moreFilters.opened).toBeTrue();
    expect(result.historyControls.moreFilters.closed).toBeTrue();
    expect(result.historyControls.moreFilters.ids).toEqual(['fixture-1']);
    expect(result.historyControls.moreFilters.filters).toMatchObject({
      minDuration: 8,
      maxDuration: 9,
      minConfidence: 0.95,
    });
    expect(result.historyControls.moreFilters.filters.dateTo - result.historyControls.moreFilters.filters.dateFrom).toBe(86_399_999);
    expect(result.historyControls.expandedEntry.visible).toBeTrue();
    expect(result.historyControls.expandedEntry.metrics).toContain('10 words');
    expect(result.historyControls.expandedEntry.metrics).toContain('96% confidence');
    expect(result.historyControls.expandedEntry.metrics).toContain('71 wpm');
    expect(result.historyControls.copy.text).toBe('Plan the next Eve release and verify the export workflow.');
    expect(result.historyControls.copy.success.message).toBe('Copied to clipboard');
    expect(result.historyControls.copy.failure.message).toBe('Could not copy dictation');
    expect(result.historyControls.copy.failure.type).toBe('error');
    expect(result.historyControls.singleDelete.undo).toBeTrue();
    expect(result.historyControls.singleDelete.restoredIds).toEqual(['fixture-1', 'fixture-2']);
    expect(result.historyControls.singleDelete.requestsAfterUndo).toEqual([]);
    expect(result.historyControls.singleDelete.committedIds).toEqual(['fixture-1']);
    expect(result.historyControls.singleDelete.retainedSelection).toMatchObject({
      count: '1 selected',
      selected: true,
      undoVisible: false,
    });
    expect(result.historyControls.singleDelete.retainedSelection.historyRequests)
      .toBe(result.historyControls.singleDelete.requestsBeforeBackgroundCommit);
    expect(result.historyControls.queueFlush).toEqual({
      waitedForAcknowledgement: true,
      completed: true,
      recovery: { entryRestored: true, undoHidden: true, failureToast: 'Delete failed; transcription restored' },
    });
  });

  test('selects the current filtered IDs and confirms bulk deletion through the bridge', () => {
    expect(result.historyControls.selectAll.count).toBe('1 selected');
    expect(result.historyControls.selectAll.ids.ids).toEqual(['fixture-1']);
    expect(result.bulkDeleteRequest).toEqual(['fixture-1']);
    expect(result.historyControls.bulkDeleteRequest).toEqual(['fixture-1']);
  });

  test('sends the correct export scope and selected IDs to the history bridge', () => {
    expect(result.exportRequests.all).toEqual({ format: 'json', scope: 'all' });
    expect(result.exportRequests.selected).toEqual({ format: 'json', scope: 'selected', ids: ['fixture-1'] });
  });

  test('moves focus into bulk-delete confirmation, traps it, and restores the selection control', () => {
    expect(result.deleteDialogFocus).toEqual({
      initiallyFocusedCancel: true,
      deleteStyle: { background: 'rgba(0, 0, 0, 0)', decoration: 'underline' },
      shiftTabWrapsToDelete: true,
      tabWrapsToCancel: true,
      closedOnEscape: true,
      restoredToSelectionToggle: true,
    });
  });

  test('captures deterministic screenshots for visual review', () => {
    expect(result.screenshots).toHaveLength(2);
    for (const screenshot of result.screenshots) expect(existsSync(screenshot)).toBeTrue();
  });
});
