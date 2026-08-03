const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const baseUrl = process.argv[2];
const screenshotDir = path.resolve(process.env.EVE_PHASE2_SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-phase2-settings-screenshots'));
if (!baseUrl) throw new Error('fixture URL is required');

const tempRoot = path.resolve(os.tmpdir());
const userData = path.resolve(tempRoot, `eve-settings-speech-${process.pid}`);
const electronScreenshots = [
  ['general', 'ready', false, 'general-hotwords.png'],
  ['speech', 'ready', false, 'speech-ready.png'],
  ['speech', 'preparing', false, 'speech-preparing.png'],
  ['speech', 'error', false, 'speech-error.png'],
  ['speech', 'external', false, null],
  ['speech', 'ready', true, 'compatibility-expanded.png'],
];

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureUrl(view, state, compatibility) {
  const params = new URLSearchParams({ view, state });
  if (compatibility) params.set('compatibility', 'expanded');
  return `${baseUrl}?${params}`;
}

async function loadFixture(window, view, state, compatibility) {
  await window.loadURL(fixtureUrl(view, state, compatibility));
  await wait(250);
}

async function measure(window, view, state, compatibility, zoom) {
  await window.webContents.setZoomFactor(zoom);
  await wait(80);
  const serialized = JSON.stringify({ view, state, compatibility, zoom });
  return window.webContents.executeJavaScript(`(() => {
    const meta = ${serialized};
    const owner = document.querySelector('[data-fixture-scroll-owner]');
    const main = document.querySelector('[data-fixture-main]');
    const panel = document.querySelector('[data-speech-model-panel]');
    const options = [...document.querySelectorAll('[data-speech-model-option]')];
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    const states = [...document.querySelectorAll('[data-speech-model-state]')].map((node) => node.textContent?.trim() ?? '');
    const focusTarget = radios[0] ?? document.querySelector('[data-fixture-compatibility-toggle]');
    focusTarget?.focus({ preventScroll: true, focusVisible: true });
    const focusLabel = focusTarget?.closest('label');
    const focusStyle = focusLabel ? getComputedStyle(focusLabel) : focusTarget ? getComputedStyle(focusTarget) : null;
    const rect = (element) => element ? (() => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }; })() : null;
    const ownerRect = rect(owner);
    const optionRects = options.map(rect);
    const compatibilityButton = document.querySelector('[data-fixture-compatibility-toggle]');
    const compatibilityControls = document.querySelector('[data-fixture-compatibility-controls]');
    return {
      ...meta,
      viewport: { width: innerWidth, height: innerHeight },
      owner: owner ? { overflowY: getComputedStyle(owner).overflowY, clientHeight: owner.clientHeight, scrollHeight: owner.scrollHeight, scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth, rect: ownerRect } : null,
      main: rect(main),
      panel: rect(panel),
      optionCount: options.length,
      checkedCount: radios.filter((radio) => radio.checked).length,
      states,
      optionContained: !!ownerRect && optionRects.every((option) => option && option.left >= ownerRect.left && option.right <= ownerRect.right),
      focus: focusStyle ? { focusWithin: !!focusLabel?.matches(':focus-within'), outlineWidth: focusStyle.outlineWidth, boxShadow: focusStyle.boxShadow } : null,
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      external: !!document.querySelector('[data-speech-model-external]'),
      compatibilityExpanded: compatibilityButton?.getAttribute('aria-expanded') === 'true' && !!compatibilityControls,
      compatibilityAssociation: !!compatibilityButton && compatibilityButton.getAttribute('aria-controls') === compatibilityControls?.id,
    };
  })()`);
}

async function capture(window, view, state, compatibility, filename) {
  await window.webContents.setZoomFactor(1);
  await window.setContentSize(960, 900);
  await wait(120);
  fs.mkdirSync(screenshotDir, { recursive: true });
  const image = await window.webContents.capturePage();
  const target = path.resolve(screenshotDir, filename);
  fs.writeFileSync(target, image.toPNG());
  return target;
}

async function exerciseModelSelection(window) {
  await loadFixture(window, 'speech', 'ready', false);
  return window.webContents.executeJavaScript(`(async () => {
    const radios = [...document.querySelectorAll('input[type="radio"]')];
    const results = [];
    for (const radio of radios) {
      radio.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      results.push({
        label: radio.getAttribute('aria-label'),
        checked: radio.checked,
        panelPresent: !!document.querySelector('[data-speech-model-panel]'),
        optionCount: document.querySelectorAll('[data-speech-model-option]').length,
      });
    }
    return results;
  })()`);
}

async function main() {
  let window = null;
  const measurements = [];
  const screenshots = [];
  let interactions = [];
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
    window.show();
    window.focus();
    window.webContents.focus();
    await wait(500);

    for (const [view, state, compatibility, filename] of electronScreenshots) {
      await loadFixture(window, view, state, compatibility);
      if (filename) screenshots.push(await capture(window, view, state, compatibility, filename));

      for (const [width, height] of [[960, 900], [320, 700]]) {
        await window.setContentSize(width, height);
        await wait(100);
        for (const zoom of [1, 1.5, 2]) {
          measurements.push(await measure(window, view, state, compatibility, zoom));
        }
      }
    }
    interactions = await exerciseModelSelection(window);
  } finally {
    if (window && !window.isDestroyed()) await window.close();
  }

  process.stdout.write(JSON.stringify({ measurements, screenshots, interactions, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
