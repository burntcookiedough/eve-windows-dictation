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
  window.webContents.focus();
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
    const panel = [...document.querySelectorAll('[data-speech-model-panel]')].find((candidate) => !candidate.closest('.sheet-layer'));
    const options = [...(panel?.querySelectorAll('[data-speech-model-option]') ?? [])];
    const radios = [...(panel?.querySelectorAll('input[type="radio"]') ?? [])];
    const states = [...(panel?.querySelectorAll('[data-speech-model-state]') ?? [])].map((node) => node.textContent?.trim() ?? '');
    const compatibilitySection = document.querySelector('[data-fixture-compatibility]')?.closest('details');
    const compatibilitySummary = compatibilitySection?.querySelector('summary');
    const focusTarget = radios[0] ?? compatibilitySummary;
    focusTarget?.focus({ preventScroll: true, focusVisible: true });
    const focusLabel = focusTarget?.closest('label');
    const focusStyle = focusLabel ? getComputedStyle(focusLabel) : focusTarget ? getComputedStyle(focusTarget) : null;
    const rect = (element) => element ? (() => { const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height }; })() : null;
    const ownerRect = rect(owner);
    const optionRects = options.map(rect);
    const compatibilityControls = document.querySelector('[data-fixture-compatibility-controls]');
    const compatibilityDropdowns = [...document.querySelectorAll('[data-settings-row]')]
      .filter((row) => ['Compute type. Precision used by Faster-Whisper', 'Device. Hardware device for inference'].includes(row.getAttribute('aria-label')))
      .map((row) => ({
        control: rect(row.querySelector('[data-settings-control]')),
        dropdown: rect(row.querySelector('[role="combobox"]')),
      }));
    return {
      ...meta,
      viewport: { width: innerWidth, height: innerHeight },
      owner: owner ? { overflowX: getComputedStyle(owner).overflowX, overflowY: getComputedStyle(owner).overflowY, clientHeight: owner.clientHeight, scrollHeight: owner.scrollHeight, scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth, rect: ownerRect } : null,
      main: rect(main),
      panel: rect(panel),
      optionCount: options.length,
      checkedCount: radios.filter((radio) => radio.checked).length,
      states,
      optionContained: !!ownerRect && optionRects.every((option) => option && option.left >= ownerRect.left && option.right <= ownerRect.right),
      focus: focusStyle ? { focusWithin: !!focusLabel?.matches(':focus-within'), outlineWidth: focusStyle.outlineWidth, boxShadow: focusStyle.boxShadow } : null,
      document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      compatibilityExpanded: compatibilitySection?.open === true,
      compatibilityAssociation: !!compatibilitySection && compatibilitySummary?.parentElement === compatibilitySection,
      compatibilityControlsPresent: !!compatibilityControls?.isConnected,
      compatibilityControlsVisible: compatibilitySection?.open === true && !!compatibilityControls?.getClientRects().length,
      compatibilitySummaryHeading: compatibilitySummary?.querySelector('[id]')?.textContent?.trim() ?? '',
      inlineOptionReasonCount: document.querySelectorAll('[data-setting-option-reason]').length,
      compatibilityDropdowns,
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

async function captureCompatibilityOptions(window, width, filename) {
  await window.webContents.setZoomFactor(1);
  await window.setContentSize(width, 900);
  await wait(120);
  await window.webContents.executeJavaScript(`(() => {
    [...document.querySelectorAll('[data-settings-row]')]
      .find((row) => row.getAttribute('aria-label')?.startsWith('Compute type.'))
      ?.scrollIntoView({ block: 'center' });
  })()`);
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
    const panel = [...document.querySelectorAll('[data-speech-model-panel]')].find((candidate) => !candidate.closest('.sheet-layer'));
    const radios = [...(panel?.querySelectorAll('input[type="radio"]') ?? [])];
    const owner = document.querySelector('[data-fixture-scroll-owner]');
    const results = [];
    for (const radio of radios) {
      radio.scrollIntoView({ block: 'center' });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const scrollTopBefore = owner.scrollTop;
      radio.closest('label').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      results.push({
        label: radio.getAttribute('aria-label'),
        checked: radio.checked,
        panelPresent: !!panel?.isConnected,
        optionCount: panel?.querySelectorAll('[data-speech-model-option]').length ?? 0,
        rendererFailed: window.__eveRendererFailed === true,
        scrollDelta: Math.abs(owner.scrollTop - scrollTopBefore),
      });
    }
    return results;
  })()`);
}

async function exerciseModelSheetDraft(window) {
  await loadFixture(window, 'speech', 'ready', false);
  return window.webContents.executeJavaScript(`(async () => {
    const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const openButton = document.querySelector('[data-fixture-sheet-open]');
    const openSheet = async () => {
      openButton?.click();
      await flush();
      return document.querySelector('.sheet-layer.open .sheet-panel');
    };
    const panel = await openSheet();
    const radios = () => [...(panel?.querySelectorAll('input[type="radio"]') ?? [])];
    const current = () => radios().find((radio) => radio.getAttribute('aria-label')?.startsWith('Recommended Multilingual'));
    const target = () => radios().find((radio) => radio.getAttribute('aria-label')?.startsWith('Maximum Multilingual Accuracy'));

    target()?.click();
    await flush();
    const draftChangedBeforeCancel = target()?.checked === true && current()?.checked === false;
    const useButton = panel?.querySelector('.model-sheet-primary');
    const useEnabledBeforeCancel = useButton instanceof HTMLButtonElement && !useButton.disabled;
    const pendingBeforeCancel = document.querySelector('[data-sheet-pending]')?.textContent?.trim() ?? '';
    const startedBeforeCancel = document.querySelector('[data-sheet-preparation-started]')?.textContent?.trim() ?? '';
    panel?.querySelector('[data-model-sheet-actions] .model-sheet-secondary')?.click();
    await flush();
    const pendingAfterCancel = document.querySelector('[data-sheet-pending]')?.textContent?.trim() ?? '';
    const startedAfterCancel = document.querySelector('[data-sheet-preparation-started]')?.textContent?.trim() ?? '';

    const reopened = await openSheet();
    const reopenedRadios = [...(reopened?.querySelectorAll('input[type="radio"]') ?? [])];
    const reopenedCurrent = reopenedRadios.find((radio) => radio.getAttribute('aria-label')?.startsWith('Recommended Multilingual'));
    const reopenedTarget = reopenedRadios.find((radio) => radio.getAttribute('aria-label')?.startsWith('Maximum Multilingual Accuracy'));
    const reopensWithCurrent = reopenedCurrent?.checked === true && reopenedTarget?.checked === false;
    reopenedTarget?.click();
    await flush();
    const useModel = reopened?.querySelector('.model-sheet-primary');
    const useEnabledAfterSelection = useModel instanceof HTMLButtonElement && !useModel.disabled;
    useModel?.click();
    await flush();
    const pendingAfterUse = document.querySelector('[data-sheet-pending]')?.textContent?.trim() ?? '';
    const startedAfterUse = document.querySelector('[data-sheet-preparation-started]')?.textContent?.trim() ?? '';
    const closedAfterUse = !document.querySelector('.sheet-layer.open');
    return {
      draftChangedBeforeCancel,
      useEnabledBeforeCancel,
      pendingBeforeCancel,
      startedBeforeCancel,
      pendingAfterCancel,
      startedAfterCancel,
      reopensWithCurrent,
      useEnabledAfterSelection,
      pendingAfterUse,
      startedAfterUse,
      closedAfterUse,
      submittedPatch: JSON.parse(document.querySelector('[data-model-apply-patch]')?.textContent ?? '{}'),
      pendingEngineSettings: JSON.parse(document.querySelector('[data-pending-engine-settings]')?.textContent ?? '{}'),
      committedAdvancedSettings: JSON.parse(document.querySelector('[data-committed-advanced-settings]')?.textContent ?? '{}'),
    };
  })()`);
}

async function exerciseCompatibilityDisclosure(window) {
  await loadFixture(window, 'speech', 'ready', false);
  return window.webContents.executeJavaScript(`(async () => {
    const details = document.querySelector('[data-fixture-compatibility]')?.closest('details');
    const summary = details?.querySelector('summary');
    const controls = document.querySelector('[data-fixture-compatibility-controls]');
    const attention = document.querySelector('[data-fixture-compatibility-attention]');
    const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const setAttention = async (value) => {
      attention.checked = value;
      attention.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    };
    const initiallyClosed = !!details && !details.open;
    const controlsMountedInitially = !!controls?.isConnected;
    await setAttention(true);
    const openedForAttention = !!details?.open;
    summary?.click();
    await flush();
    const manuallyClosedWhileAttention = !!details && !details.open;
    document.querySelector('input[type="radio"]:not(:checked)')?.click();
    await flush();
    const stayedClosedAfterRerender = !!details && !details.open;
    await setAttention(false);
    const remainedClosedAfterAttentionCleared = !!details && !details.open;
    summary?.click();
    await flush();
    await setAttention(true);
    await setAttention(false);
    const stayedOpenAfterAttentionCleared = !!details?.open;
    const controlsVisible = !!controls?.getClientRects().length;
    return {
      initiallyClosed,
      controlsMountedInitially,
      openedForAttention,
      manuallyClosedWhileAttention,
      stayedClosedAfterRerender,
      remainedClosedAfterAttentionCleared,
      stayedOpenAfterAttentionCleared,
      controlsVisible,
      controlsRemainMounted: !!controls?.isConnected,
      summaryHeading: summary?.querySelector('[id]')?.textContent?.trim() ?? '',
    };
  })()`);
}

async function exerciseAdvancedApplyRetry(window) {
  await loadFixture(window, 'speech', 'ready', true);
  return window.webContents.executeJavaScript(`(async () => {
    const flush = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const button = document.querySelector('[data-fixture-advanced-apply]');
    button?.click();
    await flush();
    const stagedAfterFailure = JSON.parse(document.querySelector('[data-pending-engine-settings]')?.textContent ?? '{}');
    const errorShownAfterFailure = !!document.querySelector('[data-fixture-advanced-error]');
    const retryLabel = button?.textContent?.trim() ?? '';
    button?.click();
    await flush();
    return {
      firstPatch: JSON.parse(document.querySelector('[data-advanced-apply-patches]')?.textContent ?? '[]')[0] ?? {},
      stagedAfterFailure,
      errorShownAfterFailure,
      retryLabel,
      retryPatch: JSON.parse(document.querySelector('[data-advanced-apply-patches]')?.textContent ?? '[]')[1] ?? {},
      stagedAfterRetry: JSON.parse(document.querySelector('[data-pending-engine-settings]')?.textContent ?? '{}'),
    };
  })()`);
}

async function main() {
  let window = null;
  const measurements = [];
  const screenshots = [];
  let interactions = [];
  let modelSheetDraftInteraction = null;
  let advancedApplyRetryInteraction = null;
  let disclosureInteraction = null;
  await app.whenReady();
  try {
    window = new BrowserWindow({
      width: 960,
      height: 900,
      show: false,
      frame: false,
      resizable: false,
      backgroundColor: '#08090a',
      webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true },
    });
    window.webContents.on('console-message', ({ level, message, lineNumber: line, sourceId }) => {
      process.stderr.write(`renderer console ${level} ${sourceId}:${line}: ${message}\n`);
    });
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      process.stderr.write(`renderer load failed ${errorCode} ${errorDescription} ${validatedURL}\n`);
    });
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
    await loadFixture(window, 'speech', 'ready', true);
    screenshots.push(await captureCompatibilityOptions(window, 810, 'compatibility-disabled-options-810.png'));
    screenshots.push(await captureCompatibilityOptions(window, 320, 'compatibility-disabled-options-320.png'));
    disclosureInteraction = await exerciseCompatibilityDisclosure(window);
    interactions = await exerciseModelSelection(window);
    modelSheetDraftInteraction = await exerciseModelSheetDraft(window);
    advancedApplyRetryInteraction = await exerciseAdvancedApplyRetry(window);
  } finally {
    if (window && !window.isDestroyed()) await window.close();
  }

  process.stdout.write(JSON.stringify({ measurements, screenshots, interactions, disclosureInteraction, modelSheetDraftInteraction, advancedApplyRetryInteraction, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
