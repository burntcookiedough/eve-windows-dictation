// Actual packaged-app observations only; never starts recording or visits Settings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const sha256 = text => createHash('sha256').update(String(text)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function debuggerUrl(value, port, kind) {
  const url = new URL(value);
  assert.equal(url.protocol, 'ws:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.port, String(port));
  assert.ok(!url.username && !url.password && !url.search && !url.hash);
  assert.ok(url.pathname.startsWith(`/devtools/${kind}/`));
  return url.href;
}

export function selectMainTarget(targets, expectedUrl, port) {
  assert.equal(new URL(expectedUrl).protocol, 'file:');
  const matches = targets.filter(t => t.type === 'page' &&
    typeof t.url === 'string' && t.url.toLowerCase() === expectedUrl.toLowerCase());
  assert.equal(matches.length, 1, 'Expected one exact installed app renderer');
  debuggerUrl(matches[0].webSocketDebuggerUrl, port, 'page');
  return matches[0];
}

export function assertHistoryResponse(response, expected, hasMore = false) {
  assert.ok(Array.isArray(response?.entries), 'Missing History response');
  assert.equal(response.hasMore, hasMore, 'Unexpected History pagination');
  const actual = response.entries.map(row => ({
    id: row.id, timestamp: row.timestamp, textHash: sha256(row.text),
  }));
  assert.deepEqual(actual, expected, 'History records changed, duplicated or missing');
  return actual;
}

async function getJson(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}/json/${endpoint}`, {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  assert.ok(response.ok, 'CDP HTTP request failed');
  return response.json();
}

export class CdpSession {
  constructor(url) { this.url = url; this.callbacks = new Map(); this.nextId = 0; }
  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data);
      const callback = this.callbacks.get(msg.id);
      if (callback) {
        this.callbacks.delete(msg.id);
        msg.error ? callback.reject(new Error(msg.error.message)) : callback.resolve(msg.result);
      }
    });
    this.ws.addEventListener('close', () => {
      for (const callback of this.callbacks.values()) callback.reject(new Error('CDP connection closed'));
      this.callbacks.clear();
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.ws.close(); reject(new Error('CDP connect timeout')); }, 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed')); }, { once: true });
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.callbacks.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      this.callbacks.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!result.exceptionDetails, 'Packaged renderer operation failed');
    return result.result?.value;
  }
  close() { this.ws?.close(); }
}

async function waitFor(observe, accept) {
  const deadline = Date.now() + 15000;
  do {
    const value = await observe();
    if (accept(value)) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error('Packaged app observation timed out');
}

export async function observeHistory(session, phase, expected) {
  const version = phase.startsWith('candidate-') ? '0.8.2-alpha.8' : '0.8.2-alpha.5';
  assert.equal(await session.evaluate('window.murmurMain.getAppVersion()'), version);
  const settings = await session.evaluate('window.murmurMain.getSettings()');
  assert.equal(settings.serverAutoStart, false, 'Server auto-start must stay disabled');
  assert.equal(settings.startMinimized, false);
  const server = await session.evaluate('window.murmurMain.getServerStatus()');
  assert.ok(!server.pid && !server.port && ['idle','stopped'].includes(server.status), 'Unexpected backend process');
  const remaining = expected.filter(row => row.id !== 'fixture-hist-002-delete');
  const rows = phase === 'candidate-relaunch-verify' || phase === 'baseline-rollback-read' ? remaining : expected;
  const actual = assertHistoryResponse(await session.evaluate('window.murmurMain.getHistoryEntries(0,50)'), rows);
  if (rows.length > 1) {
    assertHistoryResponse(await session.evaluate('window.murmurMain.getHistoryEntries(1,1)'), rows.slice(1, 2), rows.length > 2);
  }
  await session.evaluate(`(() => {
    const button = document.querySelector('button[data-view="history"]') ||
      [...document.querySelectorAll('button')].find(b => b.textContent.trim().toLowerCase() === 'history');
    if (!button) throw new Error('History navigation missing');
    button.click();
  })()`);
  const rendered = await waitFor(() => session.evaluate(`(() => ({
    settingsMounted: !!document.querySelector('.settings-view,[data-settings-general]'),
    historyMounted: !!(document.querySelector('input[type="search"]') ||
      document.querySelector('input[type="text"][aria-label="Search transcriptions"]')),
    texts: [...document.querySelectorAll('p')].filter(p => !p.closest('[hidden],[inert]') &&
      p.getBoundingClientRect().width > 0 && p.getBoundingClientRect().height > 0).map(p => p.textContent.trim())
  }))()`), value => value?.historyMounted && !value.settingsMounted && rows.every(row =>
    value.texts.filter(text => sha256(text) === row.textHash).length === 1));
  assert.equal(rendered.settingsMounted, false);
  if (phase === 'candidate-upgrade-read-mutate') {
    assert.equal(settings.appearance, 'dark', 'Seeded appearance was not read');
    const filtered = rows.filter(row => row.id !== 'fixture-hist-002-delete');
    assertHistoryResponse(await session.evaluate("window.murmurMain.getHistoryEntries(0,50,{text:'baseline'})"), filtered);
    await session.evaluate(`(() => {
      const input = document.querySelector('input[type="search"]');
      if (!input) throw new Error('History search missing');
      input.value = 'baseline';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await waitFor(() => session.evaluate(`(() => ({
      settingsMounted: !!document.querySelector('.settings-view,[data-settings-general]'),
      texts: [...document.querySelectorAll('p')].filter(p => !p.closest('[hidden],[inert]') &&
        p.getBoundingClientRect().width > 0 && p.getBoundingClientRect().height > 0).map(p => p.textContent.trim())
    }))()`), value => value && !value.settingsMounted && rows.every(row =>
      value.texts.filter(text => sha256(text) === row.textHash).length === (filtered.includes(row) ? 1 : 0)));
    await session.evaluate("window.murmurMain.updateSetting('appearance','light')");
    assert.equal((await session.evaluate('window.murmurMain.getSettings()')).appearance, 'light');
    await session.evaluate("window.murmurMain.deleteHistoryEntry('fixture-hist-002-delete')");
    assertHistoryResponse(await session.evaluate('window.murmurMain.getHistoryEntries(0,50)'), remaining);
  } else if (phase === 'candidate-relaunch-verify' || phase === 'baseline-rollback-read') {
    assert.equal(settings.appearance, 'light', 'Saved appearance did not persist');
  }
  return { version, records: actual, renderedCount: rows.length, settingsMounted: false, backendRunning: false,
    searchControlVerified: phase === 'candidate-upgrade-read-mutate' };
}

export async function runProbePhase({ port, phase, installDir, expectations }) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  assert.ok(['baseline-initialize','baseline-read','candidate-upgrade-read-mutate',
    'candidate-relaunch-verify','baseline-rollback-read'].includes(phase));
  const expected = phase === 'baseline-initialize' ? [] : expectations.records;
  assert.ok(Array.isArray(expected));
  if (phase !== 'baseline-initialize') {
    assert.deepEqual(expected.map(row => row.id), ['fixture-hist-003','fixture-hist-002-delete','fixture-hist-001']);
    assert.ok(expected.every(row => Number.isInteger(row.timestamp) && /^[0-9a-f]{64}$/.test(row.textHash)));
  }
  const version = await getJson(port, 'version');
  const browser = new CdpSession(debuggerUrl(version.webSocketDebuggerUrl, port, 'browser'));
  const expectedUrl = pathToFileURL(join(installDir, 'resources/app.asar/dist/renderer/app/index.html')).href;
  const target = await waitFor(() => getJson(port, 'list'), targets =>
    targets.some(t => t.type === 'page' && t.url?.toLowerCase() === expectedUrl.toLowerCase()));
  const session = new CdpSession(selectMainTarget(target, expectedUrl, port).webSocketDebuggerUrl);
  try {
    await session.connect();
    await waitFor(() => session.evaluate("typeof window.murmurMain?.getHistoryEntries === 'function'"), Boolean);
    const observations = await observeHistory(session, phase, expected);
    await browser.connect();
    // Acknowledgement can race process exit. PowerShell independently requires actual graceful exit.
    try { await browser.send('Browser.close'); } catch (error) {
      if (error.message !== 'CDP connection closed') throw error;
    }
    return { phase, status: 'passed', observations, closeRequested: true };
  } finally { session.close(); browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).map(arg => {
      const match = /^--(port|phase|install-dir|expectations)=(.+)$/.exec(arg);
      assert.ok(match, 'Unknown or empty probe argument');
      return [match[1], match[2]];
    }));
    const evidence = await runProbePhase({ port: Number(args.port), phase: args.phase,
      installDir: args['install-dir'], expectations: JSON.parse(readFileSync(args.expectations, 'utf8')) });
    console.log(JSON.stringify(evidence));
  } catch {
    // Never expose unexpected renderer text, paths or protocol responses in uploaded diagnostics.
    console.error('Retained History probe failed; required packaged-app observation was not established.');
    process.exitCode = 1;
  }
}
