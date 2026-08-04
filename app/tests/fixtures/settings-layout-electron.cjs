const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');

const url = process.argv[2];
if (!url) throw new Error('fixture URL is required');

const tempRoot = path.resolve(os.tmpdir());
const userData = path.resolve(tempRoot, `eve-settings-layout-${process.pid}`);

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function measure(window, zoom) {
  await window.webContents.setZoomFactor(zoom);
  await wait(80);
  try {
    return await window.webContents.executeJavaScript(`(() => {
    const owner = document.querySelector('[data-layout-scroll-owner]');
    const main = document.querySelector('[data-layout-main]');
    const status = document.querySelector('[data-status-region="model-progress"]');
    const row = document.querySelector('[data-settings-row]');
    const control = row?.querySelector('[data-settings-control]');
    const toggleRows = [...document.querySelectorAll('[data-settings-row]')]
      .map((toggleRow) => ({ row: toggleRow, toggle: toggleRow.querySelector('[role="switch"]') }))
      .filter(({ toggle }) => !!toggle);
    const sections = [...document.querySelectorAll('section[aria-labelledby]')];
    const headingIds = sections.map((section) => section.getAttribute('aria-labelledby'));
    const headings = headingIds.map((headingId) => headingId ? document.getElementById(headingId) : null);
    const focusTarget = row?.querySelector('button');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    focusTarget?.focus({ preventScroll: true, focusVisible: true });
    const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
    const rect = (element) => element ? (() => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }; })() : null;
    return {
      zoom: ${zoom},
      viewport: { width: innerWidth, height: innerHeight },
      owner: owner ? { overflowY: getComputedStyle(owner).overflowY, clientHeight: owner.clientHeight, scrollHeight: owner.scrollHeight, scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth, rect: rect(owner) } : null,
      main: rect(main),
      status: status ? { position: getComputedStyle(status).position, rect: rect(status) } : null,
      row: { rect: rect(row), control: rect(control) },
      toggles: toggleRows.map(({ row: toggleRow, toggle }) => ({ row: rect(toggleRow), toggle: rect(toggle) })),
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      focus: focusStyle ? { focusVisible: focusTarget.matches(':focus-visible'), outlineStyle: focusStyle.outlineStyle, outlineWidth: focusStyle.outlineWidth, boxShadow: focusStyle.boxShadow } : null,
      headingAssociation: sections.length > 0 && headings.every((heading, index) => !!heading && heading.id === headingIds[index]),
      headingIdsUnique: headingIds.every(Boolean) && new Set(headingIds).size === headingIds.length,
      explicitHeadingId: headingIds.includes('fixture-explicit-section'),
    };
    })()`);
  } catch (error) {
    throw new Error(`Rendered measurement failed at zoom ${zoom}: ${error}`);
  }
}

async function main() {
  let window = null;
  let measurements;
  await app.whenReady();
  try {
    window = new BrowserWindow({
      width: 960,
      height: 900,
      show: false,
      frame: false,
      resizable: false,
      backgroundColor: '#08090a',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      process.stderr.write(`renderer console ${level} ${sourceId}:${line}: ${message}\n`);
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      process.stderr.write(`renderer load failed ${errorCode} ${errorDescription} ${validatedURL}\n`);
    });
    await window.loadURL(url);
    window.show();
    window.focus();
    window.webContents.focus();
    await wait(500);

    measurements = [];
    for (const [width, height] of [[960, 900], [320, 700]]) {
      window.setContentSize(width, height);
      await wait(100);
      for (const zoom of [1, 1.5, 2]) {
        measurements.push(await measure(window, zoom));
      }
    }
  } finally {
    if (window && !window.isDestroyed()) await window.close();
  }

  process.stdout.write(JSON.stringify({ measurements, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
