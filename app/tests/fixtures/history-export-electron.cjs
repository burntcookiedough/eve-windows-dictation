const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureUrl = process.argv[2];
if (!fixtureUrl) throw new Error('fixture URL is required');
const screenshotDir = path.resolve(process.env.EVE_HISTORY_EXPORT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-history-export-screenshots'));
const userData = path.resolve(os.tmpdir(), `eve-history-export-${process.pid}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readEntryIds(window) {
  return window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-history-entry]'), (entry) => entry.getAttribute('data-history-entry'))`);
}

async function clickSelector(window, selector) {
  await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('Missing History control: ' + ${JSON.stringify(selector)});
    target.click();
    return true;
  })()`);
}

async function waitForEntryIds(window, expected, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let actual = [];
  while (Date.now() < deadline) {
    actual = await readEntryIds(window);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    await wait(25);
  }
  throw new Error(`${label} did not render the expected entries: ${JSON.stringify(actual)}`);
}

async function waitForFixtureState(window, expression, isReady, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await window.webContents.executeJavaScript(expression);
    if (isReady(state)) return state;
    await wait(25);
  }
  throw new Error(`${label} did not reach the expected state: ${JSON.stringify(state)}`);
}

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function measure(window, state, zoom) {
  await window.webContents.setZoomFactor(zoom);
  await wait(100);
  return window.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('[data-history-selection-toolbar]');
    const historyToolbar = document.querySelector('.history-toolbar');
    const owner = document.querySelector('[data-scroll-owner="history"]');
    const controls = [...(toolbar?.querySelectorAll('.selection-actions > button, .dropdown-trigger') ?? [])];
    const rect = (element) => element ? (() => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    })() : null;
    return {
      state: ${JSON.stringify(state)},
      zoom: ${zoom},
      viewport: { width: innerWidth, height: innerHeight },
      toolbar: rect(toolbar),
      historyToolbar: rect(historyToolbar),
      filterControlRow: rect(historyToolbar?.querySelector('.filter-control-row')),
      moreFilters: rect(historyToolbar?.querySelector('[data-history-more-filters]')),
      toolbarActions: rect(historyToolbar?.querySelector('.toolbar-actions')),
      owner: owner ? { scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth } : null,
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      controlHeights: controls.map((control) => rect(control)?.height ?? 0),
      hasFormat: !!toolbar?.querySelector('[data-eve-dropdown]'),
      hasExportAll: !!document.querySelector('[data-history-export-all]'),
      hasExportSelected: !!document.querySelector('[data-history-export-selected]'),
      selectedCount: toolbar?.querySelector('[data-history-selection-count]')?.textContent?.trim() ?? null,
    };
  })()`);
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 960,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#08090a',
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false },
  });
  const measurements = [];
  const screenshots = [];
  let allExportRequest = null;
  let selectedExportRequest = null;
  let deleteDialogFocus = null;
  let historyControls = null;
  let bulkDeleteRequest = null;
  try {
    await window.loadURL(fixtureUrl);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await wait(500);
    for (const [width, height] of [[960, 900], [360, 720]]) {
      window.setContentSize(width, height);
      for (const zoom of [1, 2]) measurements.push(await measure(window, 'all', zoom));
    }

    await window.webContents.setZoomFactor(1);
    window.setContentSize(960, 900);
    await waitForEntryIds(window, ['fixture-1', 'fixture-2'], 'initial History list');
    const tabIds = {};
    for (const [filter, expected] of [
      ['all', ['fixture-1', 'fixture-2']],
      ['quick', ['fixture-1']],
      ['long', ['fixture-2']],
      ['edited', ['fixture-1']],
    ]) {
      await clickSelector(window, `[data-history-session-filter="${filter}"]`);
      tabIds[filter] = await waitForEntryIds(window, expected, `${filter} tab`);
    }
    await clickSelector(window, '[data-history-session-filter="all"]');
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[type="search"]');
      input.value = 'release';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(350);
    const searchIds = await waitForEntryIds(window, ['fixture-1'], 'text search');
    const searchHighlight = await window.webContents.executeJavaScript(`document.querySelector('[data-history-entry="fixture-1"] mark')?.textContent ?? null`);
    const searchFilter = await window.webContents.executeJavaScript('window.historyFixtureCalls.historyRequests.at(-1) ?? null');
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[type="search"]');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(350);
    await waitForEntryIds(window, ['fixture-1', 'fixture-2'], 'cleared search');

    await clickSelector(window, '[data-history-more-filters]');
    const moreFiltersOpened = await window.webContents.executeJavaScript(`document.querySelector('[data-history-more-filters]')?.getAttribute('aria-expanded') === 'true'`);
    await window.webContents.executeJavaScript(`(() => {
      const inputs = Array.from(document.querySelectorAll('.filters-panel input'));
      ['2026-09-19', '2026-09-19', '8', '9', '95'].forEach((value, index) => {
        inputs[index].value = value;
        inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
      });
      inputs.at(-1).dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const detailedFilterIds = await waitForEntryIds(window, ['fixture-1'], 'date, duration, and confidence filters');
    const detailedFilters = await window.webContents.executeJavaScript('window.historyFixtureCalls.historyRequests.at(-1) ?? null');
    await clickSelector(window, '.clear-filters');
    await waitForEntryIds(window, ['fixture-1', 'fixture-2'], 'cleared extended filters');
    await clickSelector(window, '[data-history-more-filters]');
    const moreFiltersClosed = await window.webContents.executeJavaScript(`document.querySelector('[data-history-more-filters]')?.getAttribute('aria-expanded') === 'false'`);

    await clickSelector(window, '[data-history-entry="fixture-1"] .entry-preview');
    const expandedEntry = await waitForFixtureState(window, `(() => {
      const article = document.querySelector('[data-history-entry="fixture-1"]');
      const details = article?.querySelector('[data-history-entry-metrics]');
      const region = article?.querySelector('.entry-more');
      return { visible: region?.getAttribute('aria-hidden') === 'false' && !region.hasAttribute('inert'), metrics: details?.textContent?.replace(/\\s+/g, ' ').trim() ?? '' };
    })()`, (state) => state?.visible, 'expanded entry metrics');
    await clickSelector(window, '[data-history-entry="fixture-1"] [data-history-entry-copy]');
    const copyText = await waitForFixtureState(window, 'window.historyFixtureCalls.copyRequests.at(-1) ?? null', (value) => value !== null, 'copy action');
    const copyToast = await waitForFixtureState(window, 'window.historyToastState().at(-1) ?? null', (value) => value?.message === 'Copied to clipboard', 'copy success toast');
    await window.webContents.executeJavaScript('window.historyFixtureCalls.rejectNextCopy = true');
    await clickSelector(window, '[data-history-entry="fixture-1"] [data-history-entry-copy]');
    const copyFailureToast = await waitForFixtureState(window, 'window.historyToastState().at(-1) ?? null', (value) => value?.message === 'Could not copy dictation', 'copy failure recovery');
    await clickSelector(window, '[data-history-entry="fixture-2"] .entry-preview');
    await clickSelector(window, '[data-history-entry="fixture-2"] [data-history-entry-delete]');
    const pendingDelete = await waitForFixtureState(window, `(() => ({
      hasUndo: !!document.querySelector('.undo-list button'),
      rowHidden: !document.querySelector('[data-history-entry="fixture-2"]'),
    }))()`, (state) => state?.hasUndo && state?.rowHidden, 'deferred single delete');
    await clickSelector(window, '.undo-list button');
    const restoredIds = await waitForEntryIds(window, ['fixture-1', 'fixture-2'], 'single delete Undo');
    const deleteRequestsAfterUndo = await window.webContents.executeJavaScript('window.historyFixtureCalls.singleDeleteRequests.slice()');
    await clickSelector(window, '[data-history-entry="fixture-2"] .entry-preview');
    await clickSelector(window, '[data-history-entry="fixture-2"] [data-history-entry-delete]');
    await waitForFixtureState(window, 'window.historyFixtureCalls.singleDeleteRequests.slice()', (ids) => ids.includes('fixture-2'), 'single delete bridge commit', 6500);
    const afterSingleDeleteIds = await waitForEntryIds(window, ['fixture-1'], 'committed single delete');
    historyControls = {
      tabIds,
      search: { ids: searchIds, highlight: searchHighlight, filter: searchFilter },
      moreFilters: { opened: moreFiltersOpened, ids: detailedFilterIds, filters: detailedFilters, closed: moreFiltersClosed },
      expandedEntry: { visible: expandedEntry.visible, metrics: expandedEntry.metrics },
      copy: { text: copyText, success: copyToast, failure: copyFailureToast },
      singleDelete: { undo: pendingDelete.hasUndo && pendingDelete.rowHidden, restoredIds, requestsAfterUndo: deleteRequestsAfterUndo, committedIds: afterSingleDeleteIds },
    };

    allExportRequest = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-history-export-all]')?.click();
      return window.historyExportRequests.at(-1) ?? null;
    })()`);
    await wait(50);
    await window.webContents.executeJavaScript(`document.querySelector('[data-history-selection-toggle]')?.click()`);
    await clickSelector(window, '[data-history-select-all]');
    const selectAll = await waitForFixtureState(window, `({ count: document.querySelector('[data-history-selection-count]')?.textContent?.trim(), ids: window.historyFixtureCalls.idRequests.at(-1) ?? null })`, (state) => state?.count === '1 selected', 'select all current filter');
    historyControls.selectAll = selectAll;
    await clickSelector(window, '[data-history-clear-selection]');
    await waitForFixtureState(window, `document.querySelector('[data-history-selection-count]')?.textContent?.trim()`, (count) => count === '0 selected', 'clear selection');
    await clickSelector(window, '[data-history-select-entry="fixture-1"]');
    await wait(100);
    measurements.push(await measure(window, 'selected', 1));
    selectedExportRequest = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('[data-history-export-selected]')?.click();
      return window.historyExportRequests.at(-1) ?? null;
    })()`);
    await wait(50);
    await window.webContents.executeJavaScript(`(() => {
      const trigger = document.querySelector('[data-history-delete-selected]');
      trigger?.focus();
      trigger?.click();
      return true;
    })()`);
    let focusState = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      focusState = await window.webContents.executeJavaScript(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const buttons = [...(dialog?.querySelectorAll('button:not([disabled])') ?? [])];
        return {
          initiallyFocusedCancel: !!dialog && document.activeElement === buttons[0],
        };
      })()`);
      if (focusState.initiallyFocusedCancel) break;
      await wait(25);
    }
    if (!focusState?.initiallyFocusedCancel) throw new Error('bulk-delete dialog did not receive focus within the fixture timeout');
    const tabState = await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const buttons = [...(dialog?.querySelectorAll('button:not([disabled])') ?? [])];
      buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      const shiftTabWrapsToDelete = document.activeElement === buttons.at(-1);
      buttons.at(-1)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const tabWrapsToCancel = document.activeElement === buttons[0];
      buttons[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        shiftTabWrapsToDelete,
        tabWrapsToCancel,
      };
    })()`);
    let restoredFocus = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      restoredFocus = await window.webContents.executeJavaScript(`(() => ({
        closedOnEscape: !document.querySelector('[role="dialog"]'),
        restoredToSelectionToggle: document.activeElement === document.querySelector('[data-history-selection-toggle]'),
      }))()`);
      if (restoredFocus.closedOnEscape && restoredFocus.restoredToSelectionToggle) break;
      await wait(25);
    }
    deleteDialogFocus = { initiallyFocusedCancel: focusState.initiallyFocusedCancel, ...tabState, ...restoredFocus };

    await clickSelector(window, '[data-history-selection-toggle]');
    await clickSelector(window, '[data-history-select-entry="fixture-1"]');
    await clickSelector(window, '[data-history-delete-selected]');
    await waitForFixtureState(window, `document.activeElement === document.querySelector('[role="dialog"] .dialog-actions button:not([disabled])')`, (focused) => focused, 'bulk-delete confirmation focus');
    await clickSelector(window, '[role="dialog"] .primary-action');
    bulkDeleteRequest = await waitForFixtureState(window, 'window.historyFixtureCalls.bulkDeleteRequests.at(-1) ?? null', (ids) => Array.isArray(ids), 'bulk delete bridge call');
    await waitForEntryIds(window, [], 'committed bulk delete');
    historyControls.bulkDeleteRequest = bulkDeleteRequest;

    fs.mkdirSync(screenshotDir, { recursive: true });
    for (const [name, setup] of [
      ['history-export-all.png', async () => {}],
      ['history-export-selected.png', async () => {
        await window.webContents.executeJavaScript(`document.querySelector('[data-history-selection-toggle]')?.click()`);
        await wait(50);
        await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]')?.click()`);
      }],
    ]) {
      await window.loadURL(fixtureUrl);
      await wait(300);
      await setup();
      await wait(100);
      const state = await window.webContents.executeJavaScript(`({
        hasAll: !!document.querySelector('[data-history-export-all]'),
        hasSelected: !!document.querySelector('[data-history-export-selected]'),
      })`);
      if (name.includes('-all') && (!state.hasAll || state.hasSelected)) throw new Error('all-history screenshot state is incorrect');
      if (name.includes('-selected') && (state.hasAll || !state.hasSelected)) throw new Error('selected-history screenshot state is incorrect');
      const target = path.join(screenshotDir, name);
      fs.writeFileSync(target, (await window.webContents.capturePage()).toPNG());
      screenshots.push(target);
    }
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
  process.stdout.write(JSON.stringify({ measurements, screenshots, exportRequests: { all: allExportRequest, selected: selectedExportRequest }, historyControls, bulkDeleteRequest, deleteDialogFocus, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
