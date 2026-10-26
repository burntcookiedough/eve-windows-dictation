const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

app.setPath('userData', path.join(os.tmpdir(), `eve-pagination-${process.pid}`));
app.commandLine.appendSwitch('disable-gpu');
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 960, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false } });
  const run = expression => window.webContents.executeJavaScript(expression);
  async function until(expression, label) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (await run(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Pagination fixture timed out: ${label}`);
  }
  try {
    await window.loadURL(process.argv[2]);
    await until('document.querySelectorAll("[data-history-entry]").length === 30', 'initial page');
    for (let round = 0; round < 3; round++) {
      await run(`(() => { const input = document.querySelector('input[type="search"]'); input.value = 'no-matching-entry'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until('!document.querySelector(".list-end")', 'empty filter removes sentinel');
      await run(`(() => { const input = document.querySelector('input[type="search"]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await until('document.querySelectorAll("[data-history-entry]").length === 30', 'cleared filter first page');
      await run(`(() => { const owner = document.querySelector('[data-scroll-owner="history"]'); owner.scrollTop = owner.scrollHeight; })()`);
      await until('document.querySelectorAll("[data-history-entry]").length >= 60', 'next page after clearing filter');
      const targets = await run('window.paginationProbe.targets()');
      assert.deepEqual(targets, [{ connected: true }], 'exactly one current target, no stale observers');
    }
    const requests = await run('window.paginationProbe.requests');
    assert.equal(requests.filter(request => request.offset === 30).length, 3);
    await run('window.paginationProbe.unmount()');
    assert.deepEqual(await run('window.paginationProbe.targets()'), []);
    process.stdout.write('PAGINATION_PROOF=3 filter/reset/scroll cycles; native intersection; no stale targets; unmount clean\n');
  } finally { window.destroy(); }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
