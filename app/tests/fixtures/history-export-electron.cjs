const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fixtureUrl = process.argv[2];
if (!fixtureUrl) throw new Error('fixture URL is required');
const screenshotDir = path.resolve(process.env.EVE_HISTORY_EXPORT_SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-history-export-screenshots'));
const userData = path.resolve(os.tmpdir(), `eve-history-export-${process.pid}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function measure(window, state, zoom) {
  await window.webContents.setZoomFactor(zoom);
  await wait(100);
  return window.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('[data-history-selection-toolbar]');
    const owner = document.querySelector('[data-scroll-owner="history"]');
    const controls = [...(toolbar?.querySelectorAll('button') ?? [])];
    const rect = (element) => element ? (() => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    })() : null;
    return {
      state: ${JSON.stringify(state)},
      zoom: ${zoom},
      viewport: { width: innerWidth, height: innerHeight },
      toolbar: rect(toolbar),
      owner: owner ? { scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth } : null,
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      controlHeights: controls.map((control) => rect(control)?.height ?? 0),
      hasFormat: !!toolbar?.querySelector('[data-eve-dropdown]'),
      hasExportAll: !!toolbar?.querySelector('[data-history-export-all]'),
      hasExportSelected: !!toolbar?.querySelector('[data-history-export-selected]'),
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
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const measurements = [];
  const screenshots = [];
  try {
    await window.loadURL(fixtureUrl);
    await wait(500);
    for (const [width, height] of [[960, 900], [360, 720]]) {
      window.setContentSize(width, height);
      for (const zoom of [1, 2]) measurements.push(await measure(window, 'all', zoom));
    }

    await window.webContents.setZoomFactor(1);
    window.setContentSize(960, 900);
    await window.webContents.executeJavaScript(`document.querySelector('[data-history-selection-toggle]')?.click()`);
    await wait(100);
    await window.webContents.executeJavaScript(`document.querySelector('input[type="checkbox"]')?.click()`);
    await wait(100);
    measurements.push(await measure(window, 'selected', 1));

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
  process.stdout.write(JSON.stringify({ measurements, screenshots, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
