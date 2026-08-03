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
    backgroundColor: '#08090a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const measurements = [];
  const screenshots = [];
  try {
    for (const phase of ['ready', 'downloading', 'error']) {
      await window.loadURL(`${baseUrl}?phase=${phase}`);
      await wait(200);
      for (const [width, height] of [[960, 900], [360, 720]]) {
        window.setContentSize(width, height);
        await wait(80);
        for (const zoom of [1, 1.5]) {
          await window.webContents.setZoomFactor(zoom);
          await wait(80);
          measurements.push(await window.webContents.executeJavaScript(`(() => {
            const owner = document.querySelector('[data-home-scroll-owner]');
            const hero = document.querySelector('[data-home-hero]');
            const orb = document.querySelector('[data-home-voice-orb]');
            return {
              phase: '${phase}', zoom: ${zoom}, viewport: { width: innerWidth, height: innerHeight },
              owner: owner ? { overflowY: getComputedStyle(owner).overflowY, scrollWidth: owner.scrollWidth, clientWidth: owner.clientWidth } : null,
              hero: !!hero, orb: !!orb,
              document: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
              heading: document.querySelector('#home-readiness-heading')?.textContent?.trim(),
              actionCount: document.querySelectorAll('nav[aria-label="Home actions"] button').length,
            };
          })()`));
        }
      }
      await window.webContents.setZoomFactor(1);
      window.setContentSize(960, 900);
      await wait(100);
      fs.mkdirSync(screenshotDir, { recursive: true });
      const target = path.join(screenshotDir, `home-${phase}.png`);
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
