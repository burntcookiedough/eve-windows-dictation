import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function probe() {
  // Exercise the actual listener, with only Electron and the clock controlled.
  const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main/windows/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = source.statements.filter(node => {
    const text = node.getText(source);
    return /^(let (isQuitting|quitFlushPending|mainWindowForQuit)\b|const QUIT_FLUSH_TIMEOUT_MS\b|app\.on\('before-quit'|export function showMainWindow\b)/.test(text);
  });
  const script = ts.transpileModule(statements.map(node => node.getText(source)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let listener: (event: { preventDefault: () => void }) => void = () => { throw new Error('Missing actual listener'); };
  let quitCount = 0;
  let shown = 0;
  let attempts = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let nextTimer = 0;
  let acknowledge: () => Promise<void> = () => new Promise(() => {});
  const window = {
    isDestroyed: () => false, isMinimized: () => false,
    show: () => { shown++; }, focus: () => {},
    webContents: { isDestroyed: () => false, executeJavaScript: () => { attempts++; return acknowledge(); } },
  };
  const context = {
    exports: {} as { setWindow: (window: unknown) => void; pending: () => boolean }, console: { error: () => {} },
    app: { on: (_: string, callback: typeof listener) => { listener = callback; }, quit: () => { quitCount++; } },
    setTimeout: (callback: () => void, delay: number) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  runInNewContext(script + '\nexports.setWindow = value => { mainWindowForQuit = value; }; exports.pending = () => quitFlushPending;', context);
  context.exports.setWindow(window);
  return {
    fire: () => { let prevented = false; listener({ preventDefault: () => { prevented = true; } }); return prevented; },
    setAck: (callback: () => Promise<void>) => { acknowledge = callback; },
    pending: context.exports.pending,
    noWindow: () => context.exports.setWindow(null),
    timers, window,
    counts: () => ({ quitCount, shown, attempts }),
    expire: () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.callback(); } },
  };
}
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('quit timeout keeps deletion owner open; retry ignores the expired acknowledgement', async () => {
  const p = probe();
  let late!: () => void;
  p.setAck(() => new Promise(resolve => { late = resolve; }));
  expect(p.fire()).toBeTrue();
  p.fire();
  await settle();
  expect(p.counts().attempts).toBe(1);
  expect(p.timers.size).toBe(1);
  expect([...p.timers.values()][0]!.delay).toBeGreaterThan(5300);
  p.expire();
  await settle();
  expect(p.pending()).toBeFalse();
  expect(p.counts()).toEqual({ quitCount: 0, shown: 1, attempts: 1 });
  let retry!: () => void;
  p.setAck(() => new Promise(resolve => { retry = resolve; }));
  p.fire();
  await settle();
  late();
  await settle();
  expect(p.counts().quitCount).toBe(0);
  expect(p.pending()).toBeTrue();
  retry();
  await settle();
  expect(p.counts().quitCount).toBe(1);
  expect(p.timers.size).toBe(0);
});

test('rejected quit flush permits retry; success clears its deadline', async () => {
  const p = probe();
  p.setAck(() => Promise.reject(new Error('synthetic rejected flush')));
  p.fire();
  await settle();
  expect(p.pending()).toBeFalse();
  expect(p.counts().quitCount).toBe(0);
  expect(p.counts().shown).toBe(1);
  expect(p.timers.size).toBe(0);
  p.setAck(() => Promise.resolve());
  p.fire();
  await settle();
  expect(p.counts().quitCount).toBe(1);
  expect(p.timers.size).toBe(0);
});

test('no renderer or a destroyed window does not block ordinary quit', () => {
  const missing = probe();
  missing.noWindow();
  expect(missing.fire()).toBeFalse();
  const destroyed = probe();
  destroyed.window.isDestroyed = () => true;
  expect(destroyed.fire()).toBeFalse();
});
