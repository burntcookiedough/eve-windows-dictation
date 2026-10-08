const { app, BrowserWindow } = require('electron');
const os = require('node:os');
const path = require('node:path');
const userData = path.join(os.tmpdir(), `eve-settings-gpu-${process.pid}`);
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ width: 960, height: 900, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') process.stderr.write(`Renderer fixture error: ${details.message}\n`);
  });
  const evaluate = (code) => window.webContents.executeJavaScript(code).catch((error) => {
    throw new Error(`Fixture step failed: ${code.slice(0, 120)}: ${error.message}`);
  });
  const waitFor = async (expression) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await wait(25);
    }
    const focus = await evaluate(`(() => { const target = document.querySelector('.sheet-layer.open [data-sheet-initial-focus]'); return {
      hasFocus: document.hasFocus(), active: document.activeElement?.outerHTML?.slice(0, 500),
      target: target?.outerHTML, disabled: target?.disabled, inert: !!target?.closest('[inert]'),
      visibility: target ? getComputedStyle(target).visibility : null,
      panel: document.querySelector('.sheet-layer.open [role="dialog"]')?.outerHTML?.slice(0, 1500),
    }; })()`);
    throw new Error(`Fixture state did not settle: ${expression}; focus=${JSON.stringify(focus)}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    window.webContents.focus();
    await waitFor(`!!window.gpuFixture && !!document.querySelector('[data-gpu-pack-repair]')`);
    await evaluate(`document.querySelector('summary').click()`);
    await wait(250);
    const ready = await evaluate(`({status: document.querySelector('[data-gpu-pack-status]').textContent, repair: !!document.querySelector('[data-gpu-pack-repair]')})`);
    await evaluate(`document.querySelector('[data-gpu-pack-remove]').focus(); document.querySelector('[data-gpu-pack-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-confirm-remove]') && document.activeElement === document.querySelector('.sheet-layer.open [data-sheet-initial-focus]')`);
    const confirmation = await evaluate(`({calls: [...gpuFixture.calls], focus: document.activeElement.textContent.trim(), reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches, dialog: document.querySelector('.sheet-layer.open [role="dialog"]')?.textContent})`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('.sheet-layer.open [role="dialog"]') && document.activeElement?.hasAttribute?.('data-gpu-pack-remove')`);
    const cancelled = await evaluate(`({calls: [...gpuFixture.calls], focus: document.activeElement.hasAttribute('data-gpu-pack-remove')})`);
    await evaluate(`document.querySelector('[data-gpu-pack-repair]').click(); document.querySelector('[data-gpu-pack-repair]')?.click()`);
    await waitFor(`document.querySelector('[data-gpu-pack-status]').textContent.includes('Verifying')`);
    const repairing = await evaluate(`({calls: [...gpuFixture.calls], status: document.querySelector('[data-gpu-pack-status]').textContent, enabled: [...document.querySelectorAll('[data-gpu-pack-card] button')].some(x => !x.disabled)})`);
    await evaluate(`gpuFixture.finish(); gpuFixture.cpuFallback()`);
    await waitFor(`document.querySelector('[data-gpu-pack-status]').textContent.includes('CPU fallback')`);
    const fallback = await evaluate(`document.querySelector('[data-gpu-pack-status]').textContent`);
    await evaluate(`gpuFixture.deviceUnknown()`);
    await waitFor(`document.querySelector('[data-gpu-pack-status]').textContent.includes('not reported')`);
    const deviceUnknown = await evaluate(`document.querySelector('[data-gpu-pack-status]').textContent`);
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
    });
    await evaluate(`document.querySelector('[data-gpu-pack-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-confirm-remove]') && document.activeElement === document.querySelector('.sheet-layer.open [data-sheet-initial-focus]')`);
    const normalMotionFocus = await evaluate(`!matchMedia('(prefers-reduced-motion: reduce)').matches && document.activeElement.textContent.trim() === 'cancel'`);
    await evaluate(`document.querySelector('[data-gpu-pack-confirm-remove]').click(); document.querySelector('[data-gpu-pack-confirm-remove]')?.click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-action]')`);
    const removed = { ...await evaluate(`({calls: [...gpuFixture.calls], status: document.querySelector('[data-gpu-pack-status]').textContent, download: !!document.querySelector('[data-gpu-pack-action]')})`), normalMotionFocus };
    await evaluate(`gpuFixture.publish({status:'failed',code:'download_failed',retryable:true})`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-remove]')`);
    const interrupted = await evaluate(`!!document.querySelector('[data-gpu-pack-remove]')`);
    await evaluate(`gpuFixture.publish({status:'failed',code:'integrity_failed',retryable:false})`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-repair]')`);
    const broken = await evaluate(`({repair:!!document.querySelector('[data-gpu-pack-repair]'),remove:!!document.querySelector('[data-gpu-pack-remove]')})`);
    await evaluate(`document.querySelector('[data-gpu-pack-repair]').click()`);
    await waitFor(`document.querySelector('[data-gpu-pack-status]').textContent.includes('Verifying')`);
    const repairedBroken = await evaluate(`gpuFixture.calls.slice()`);
    await evaluate(`gpuFixture.finish()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-repair]')`);
    await evaluate(`gpuFixture.rejectNext('repair', false)`);
    await evaluate(`document.querySelector('[data-gpu-pack-repair]').click()`);
    await waitFor(`document.querySelector('[data-gpu-pack-card] [role="alert"]')?.textContent.includes('could not be repaired') && !document.querySelector('[data-gpu-pack-repair]').disabled`);
    const rejectedRepair = await evaluate(`({
      alert: document.querySelector('[data-gpu-pack-card] [role="alert"]')?.textContent?.trim(),
      hasRepair: !!document.querySelector('[data-gpu-pack-repair]'),
      hasRemove: !!document.querySelector('[data-gpu-pack-remove]'),
      hasAction: !!document.querySelector('[data-gpu-pack-action]'),
      repairDisabled: document.querySelector('[data-gpu-pack-repair]')?.disabled,
      calls: [...gpuFixture.calls],
    })`);
    await evaluate(`gpuFixture.rejectNext('remove', true)`);
    await evaluate(`document.querySelector('[data-gpu-pack-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-confirm-remove]')`);
    await evaluate(`document.querySelector('[data-gpu-pack-confirm-remove]').click()`);
    await waitFor(`!document.querySelector('.sheet-layer.open [role="dialog"]')`);
    await waitFor(`document.querySelector('[data-gpu-pack-card] [role="alert"]')?.textContent.includes('could not be removed') && !document.querySelector('[data-gpu-pack-remove]').disabled`);
    const rejectedRemove = await evaluate(`({
      alert: document.querySelector('[data-gpu-pack-card] [role="alert"]')?.textContent?.trim(),
      hasRepair: !!document.querySelector('[data-gpu-pack-repair]'),
      hasRemove: !!document.querySelector('[data-gpu-pack-remove]'),
      hasAction: !!document.querySelector('[data-gpu-pack-action]'),
      removeDisabled: document.querySelector('[data-gpu-pack-remove]')?.disabled,
      sheetOpen: !!document.querySelector('.sheet-layer.open [role="dialog"]'),
      calls: [...gpuFixture.calls],
    })`);
    await evaluate(`gpuFixture.publish({status:'downloading',packId:'a'.repeat(64),receivedBytes:62,totalBytes:100})`);
    await waitFor(`document.querySelector('[data-gpu-pack-card] progress')?.value === 62`);
    const layouts = [];
    for (const width of [960, 320]) {
      window.setContentSize(width, 900);
      for (const zoom of [1, 1.5, 2]) {
        window.webContents.setZoomFactor(zoom);
        await wait(80);
        layouts.push(await evaluate(`(() => { const card=document.querySelector('[data-gpu-pack-card]');const bar=card.querySelector('progress');return {width:innerWidth,overflow:document.documentElement.scrollWidth>document.documentElement.clientWidth, local:!!bar,value:bar.value, height:getComputedStyle(bar).height, color:getComputedStyle(card).color}; })()`));
      }
    }
    process.stdout.write(JSON.stringify({ userDataPath: userData, ready, confirmation, cancelled, repairing, fallback, deviceUnknown, removed, interrupted, broken, repairedBroken, rejectedRepair, rejectedRemove, layouts }));
  } finally {
    try {
      if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    } catch {}
    if (!window.isDestroyed()) window.destroy();
  }
  app.quit();
}
main().catch((error) => { process.stderr.write(error.stack || String(error)); app.exit(1); });
