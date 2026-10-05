const { app, BrowserWindow } = require('electron');
const os = require('os');
const path = require('path');

const fixtureUrl = process.argv[2];
if (!fixtureUrl) throw new Error('fixture URL is required');
const userData = path.resolve(os.tmpdir(), `eve-insights-chart-${process.pid}`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function measure(window) {
  return window.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('[data-insights-word-chart]');
    const svg = host?.querySelector('svg');
    const values = svg?.getAttribute('viewBox')?.trim().split(/\\s+/).map(Number);
    const head = document.querySelector('.page-head');
    const heroNumber = document.querySelector('.hero-number');
    const metricValue = document.querySelector('.metric-value');
    const secondMetric = document.querySelector('.metric:nth-child(2)');
    return {
      viewportWidth: innerWidth,
      hostWidth: host?.getBoundingClientRect().width ?? 0,
      viewBoxWidth: values?.[2] ?? null,
      hasChart: !!svg,
      headPaddingTop: head ? getComputedStyle(head).paddingTop : null,
      heroFontSize: heroNumber ? getComputedStyle(heroNumber).fontSize : null,
      metricFontSize: metricValue ? getComputedStyle(metricValue).fontSize : null,
      metricPaddingLeft: secondMetric ? getComputedStyle(secondMetric).paddingLeft : null,
      requestCount: window.getInsightsRequestCount?.() ?? null,
      indexingMessageVisible: !!document.querySelector('.indexing-message'),
    };
  })()`);
}

async function measureWhenAligned(window) {
  let measurement = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    measurement = await measure(window);
    if (measurement.hasChart && measurement.hostWidth > 0 && measurement.viewBoxWidth === Math.floor(measurement.hostWidth)) {
      return measurement;
    }
    await wait(25);
  }
  throw new Error(`Insights chart did not match its host width: ${JSON.stringify(measurement)}`);
}

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 400,
    height: 900,
    show: false,
    frame: false,
    backgroundColor: '#08090a',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadURL(fixtureUrl);
    await wait(100);
    const at400 = await measureWhenAligned(window);
    const initialIndexing = await measure(window);
    if (initialIndexing.requestCount !== 1 || !initialIndexing.indexingMessageVisible) {
      throw new Error(`Insights fixture did not render the initial indexing state: ${JSON.stringify(initialIndexing)}`);
    }

    window.setContentSize(560, 900);
    const afterResize = await measureWhenAligned(window);
    if (afterResize.hostWidth === at400.hostWidth) throw new Error('Insights chart fixture host did not resize');

    let afterIndexingComplete = null;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      afterIndexingComplete = await measure(window);
      if (afterIndexingComplete.requestCount === 2 && !afterIndexingComplete.indexingMessageVisible) break;
      await wait(25);
    }
    if (afterIndexingComplete?.requestCount !== 2 || afterIndexingComplete.indexingMessageVisible) {
      throw new Error(`Insights did not refresh after indexing completed: ${JSON.stringify(afterIndexingComplete)}`);
    }
    await wait(1100);
    const afterCompleteWait = await measure(window);

    process.stdout.write(JSON.stringify({ at400, initialIndexing, afterResize, afterIndexingComplete, afterCompleteWait, userDataPath: userData }));
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
  app.quit();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  app.exit(1);
});
