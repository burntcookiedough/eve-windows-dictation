const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const baseUrl = process.argv[2];
if (!baseUrl) throw new Error('fixture URL is required');
const screenshotDir = path.resolve(process.env.EVE_HOME_SCREENSHOT_DIR || path.join(os.tmpdir(), 'eve-home-screenshots'));
const userData = path.resolve(os.tmpdir(), `eve-home-${process.pid}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 960,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#0b0b0b',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const measurements = [];
  const screenshots = [];
  let indexingRefresh;
  try {
    for (const phase of ['ready', 'downloading', 'error']) {
      await window.loadURL(`${baseUrl}?phase=${phase}`);
      await wait(200);
      for (const [width, height, zoom] of [[600, 900, 1], [400, 600, 1], [600, 900, 1.5]]) {
        window.setContentSize(width, height);
        await wait(80);
        await window.webContents.setZoomFactor(zoom);
        await wait(80);
        measurements.push(await window.webContents.executeJavaScript(`(() => {
          const owner = document.querySelector('[data-home-scroll-owner]');
          return {
            phase: '${phase}', zoom: ${zoom}, viewport: { width: innerWidth, height: innerHeight },
            owner: owner ? {
              overflowY: getComputedStyle(owner).overflowY,
              scrollWidth: owner.scrollWidth,
              clientWidth: owner.clientWidth,
              scrollHeight: owner.scrollHeight,
              clientHeight: owner.clientHeight,
            } : null,
            presence: !!document.querySelector('.home-presence'),
            cactus: !!document.querySelector('[data-home-cactus="true"]'),
            stats: !!document.querySelector('.home-activity-grid'),
            transcript: !!document.querySelector('.home-last'),
            shortcuts: !!document.querySelector('.home-keys'),
            retryButton: !!document.querySelector('.home-status button'),
            document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
            status: document.querySelector('.home-status')?.textContent?.trim().replace(/\\s+/g, ' '),
          };
        })()`));
      }
      await window.webContents.setZoomFactor(1);
      window.setContentSize(960, 900);
      await wait(100);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const target = path.join(screenshotDir, `home-${phase}.png`);
      fs.writeFileSync(target, (await window.webContents.capturePage()).toPNG());
      screenshots.push(target);
    }
    await window.loadURL(`${baseUrl}?phase=ready&indexing=1`);
    await wait(200);
    const initial = await window.webContents.executeJavaScript(`document.querySelector('.home-words > span')?.textContent`);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await window.webContents.executeJavaScript(`document.querySelector('.home-words > span')?.textContent === '123'`)) break;
      await wait(50);
    }
    const completed = await window.webContents.executeJavaScript(`({words:document.querySelector('.home-words > span')?.textContent,streak:document.querySelector('.home-stat-row:last-child b span')?.textContent,calls:window.getHomeInsightsCalls()})`);
    await wait(1300);
    const settledCalls = await window.webContents.executeJavaScript(`window.getHomeInsightsCalls()`);
    indexingRefresh = { initial, completed, settledCalls };
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
  process.stdout.write(JSON.stringify({ measurements, screenshots, indexingRefresh, userDataPath: userData }));
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
