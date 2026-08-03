const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const baseUrl = process.argv[2];
const screenshotDir = path.resolve(process.env.EVE_PHASE3_SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-phase3-settings-server-screenshots'));
if (!baseUrl) throw new Error('fixture URL is required');

const tempRoot = path.resolve(os.tmpdir());
const userData = path.resolve(tempRoot, `eve-settings-server-${process.pid}`);
const cases = [
  ['managed-ready', false, 'managed-ready.png'],
  ['managed-error', false, 'managed-error.png'],
  ['external-ready', false, 'external-ready.png'],
  ['managed-ready', true, 'logs-expanded.png'],
  ['managed-long', false, 'long-strings.png'],
];

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixtureUrl(state) {
  return `${baseUrl}?${new URLSearchParams({ state })}`;
}

async function loadFixture(window, state, logsExpanded) {
  await window.loadURL(fixtureUrl(state));
  await wait(300);
  if (logsExpanded) {
    await window.webContents.executeJavaScript(`document.querySelector('[data-server-logs-toggle]')?.click()`);
    await wait(120);
  }
}

async function measure(window, state, logsExpanded, zoom) {
  await window.webContents.setZoomFactor(zoom);
  await wait(80);
  const serialized = JSON.stringify({ state, logsExpanded, zoom });
  return window.webContents.executeJavaScript(`(() => {
    const meta = ${serialized};
    const owner = document.querySelector('[data-server-fixture-scroll-owner]');
    const main = document.querySelector('[data-server-fixture-main]');
    const serverView = document.querySelector('[data-server-view]');
    const sections = [...document.querySelectorAll('section[aria-labelledby]')];
    const headingIds = sections.map((section) => section.getAttribute('aria-labelledby'));
    const headings = headingIds.map((headingId) => headingId ? document.getElementById(headingId) : null);
    const logsToggle = document.querySelector('[data-server-logs-toggle]');
    const logPanelId = logsToggle?.getAttribute('aria-controls');
    const logPanel = logPanelId ? document.getElementById(logPanelId) : null;
    const logOutput = document.querySelector('[data-server-log-output]');
    const controls = [...document.querySelectorAll('[data-server-mode-surface] button, [data-server-mode-surface] input, [data-server-health-surface] button, [data-server-diagnostics-surface] button, [data-server-logs-surface] button')].filter((control) => control.offsetParent !== null);
    const focusTarget = logsToggle ?? controls[0];
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    focusTarget?.focus({ preventScroll: true, focusVisible: true });
    const focusStyle = focusTarget ? getComputedStyle(focusTarget) : null;
    const focusContainer = focusTarget?.closest('[data-server-logs-surface]');
    const focusContainerStyle = focusContainer ? getComputedStyle(focusContainer) : null;
    const rect = (element) => element ? (() => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }; })() : null;
    const ownerRect = rect(owner);
    const ownerBox = owner?.getBoundingClientRect();
    const controlBounds = controls.map((control) => {
      const box = control.getBoundingClientRect();
      return { tag: control.tagName, text: control.textContent?.trim().slice(0, 30), left: box.left, right: box.right };
    });
    const controlsContained = ownerBox ? controlBounds.every((box) => box.left >= ownerBox.left - 1 && box.right <= ownerBox.right + 1) : false;
    const scrollersOutsideLogs = [...document.querySelectorAll('*')].filter((element) => {
      return getComputedStyle(element).overflowY === 'auto' && !element.matches('[data-server-log-output]');
    });
    return {
      ...meta,
      viewport: { width: innerWidth, height: innerHeight },
      owner: owner ? { overflowY: getComputedStyle(owner).overflowY, clientHeight: owner.clientHeight, scrollHeight: owner.scrollHeight, scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth, rect: ownerRect } : null,
      main: rect(main),
      serverView: rect(serverView),
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      controlsContained,
      controlBounds,
      controlCount: controls.length,
      focus: focusStyle ? { focused: document.activeElement === focusTarget, focusVisible: focusTarget.matches(':focus-visible'), outlineWidth: focusStyle.outlineWidth, boxShadow: focusStyle.boxShadow, containerBoxShadow: focusContainerStyle?.boxShadow ?? 'none' } : null,
      headingAssociation: sections.length > 0 && headings.every((heading, index) => !!heading && heading.id === headingIds[index]),
      headingIdsUnique: headingIds.every(Boolean) && new Set(headingIds).size === headingIds.length,
      headingLevels: [...document.querySelectorAll('h1, h2, h3')].map((heading) => Number(heading.tagName.slice(1))),
      serverSubsectionCount: serverView?.querySelectorAll('[data-server-section]').length ?? 0,
      external: !!document.querySelector('[data-server-external-notice]'),
      restriction: !!document.querySelector('[data-server-action-restriction]'),
      status: document.querySelector('[data-server-status]')?.textContent?.trim() ?? '',
      healthButtonsDisabled: [...document.querySelectorAll('[data-server-health-surface] button')].map((button) => button.disabled),
      autoStartDisabled: document.querySelector('[data-server-management-surface] [role="switch"]')?.disabled ?? false,
      logsAssociation: !!logsToggle && !!logPanel && logsToggle.getAttribute('aria-controls') === logPanel.id,
      logsExpanded: logPanel ? !logPanel.hidden : false,
      logsScroller: logOutput ? { overflowY: getComputedStyle(logOutput).overflowY, overscrollBehaviorY: getComputedStyle(logOutput).overscrollBehaviorY, clientHeight: logOutput.clientHeight, scrollHeight: logOutput.scrollHeight } : null,
      privacyWarning: !!document.querySelector('[data-server-logs-privacy]'),
      scrollersOutsideLogs: scrollersOutsideLogs.length,
    };
  })()`);
}

async function capture(window, state, logsExpanded, filename) {
  await window.webContents.setZoomFactor(1);
  await window.setContentSize(960, 900);
  await wait(120);
  if (logsExpanded) {
    await window.webContents.executeJavaScript(`document.querySelector('[data-server-logs-surface]')?.scrollIntoView({ block: 'start' })`);
    await wait(120);
  }
  fs.mkdirSync(screenshotDir, { recursive: true });
  const image = await window.webContents.capturePage();
  const target = path.resolve(screenshotDir, filename);
  fs.writeFileSync(target, image.toPNG());
  return target;
}

async function main() {
  let window = null;
  const measurements = [];
  const screenshots = [];
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

    for (const [state, logsExpanded, filename] of cases) {
      await loadFixture(window, state, logsExpanded);
      if (filename) screenshots.push(await capture(window, state, logsExpanded, filename));

      for (const [width, height] of [[960, 900], [320, 700]]) {
        await window.setContentSize(width, height);
        await wait(100);
        for (const zoom of [1, 1.5, 2]) {
          measurements.push(await measure(window, state, logsExpanded, zoom));
        }
      }
    }
  } finally {
    if (window && !window.isDestroyed()) await window.close();
  }

  process.stdout.write(JSON.stringify({ measurements, screenshots, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
