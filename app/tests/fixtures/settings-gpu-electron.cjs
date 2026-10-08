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
    webPreferences: { contextIsolation: true, nodeIntegration: false, offscreen: true } });
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
    throw new Error(`Fixture state did not settle: ${expression}`);
  };
  try {
    await window.loadURL(process.argv[2]);
    await waitFor(`!!window.gpuFixture && !!document.querySelector('[data-gpu-pack-repair]')`);
    await evaluate(`document.querySelector('summary').click()`);
    await wait(250);
    const ready = await evaluate(`({status: document.querySelector('[data-gpu-pack-status]').textContent, repair: !!document.querySelector('[data-gpu-pack-repair]')})`);
    await evaluate(`document.querySelector('[data-gpu-pack-remove]').focus(); document.querySelector('[data-gpu-pack-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-confirm-remove]')`);
    const confirmation = await evaluate(`({calls: [...gpuFixture.calls], focus: document.activeElement.textContent.trim(), dialog: document.querySelector('.sheet-layer.open [role="dialog"]')?.textContent})`);
    await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await waitFor(`!document.querySelector('.sheet-layer.open [role="dialog"]')`);
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
    await evaluate(`document.querySelector('[data-gpu-pack-remove]').click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-confirm-remove]')`);
    await evaluate(`document.querySelector('[data-gpu-pack-confirm-remove]').click(); document.querySelector('[data-gpu-pack-confirm-remove]')?.click()`);
    await waitFor(`!!document.querySelector('[data-gpu-pack-action]')`);
    const removed = await evaluate(`({calls: [...gpuFixture.calls], status: document.querySelector('[data-gpu-pack-status]').textContent, download: !!document.querySelector('[data-gpu-pack-action]')})`);
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
    process.stdout.write(JSON.stringify({ userDataPath: userData, ready, confirmation, cancelled, repairing, fallback, deviceUnknown, removed, interrupted, broken, repairedBroken, layouts }));
  } finally { window.destroy(); }
  app.quit();
}
main().catch((error) => { process.stderr.write(error.stack || String(error)); app.exit(1); });
