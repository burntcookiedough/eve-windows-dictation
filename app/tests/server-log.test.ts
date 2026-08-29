import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  getServerLogBodySize,
  getServerLogCountLabel,
  MAX_SERVER_LOG_ENTRIES,
  SHORT_SERVER_LOG_ENTRY_LIMIT,
  SERVER_LOG_LOAD_ERROR,
} from '../src/renderer/app/server-log.js';
import {
  BoundedLogDeliveryQueue,
  MAX_PENDING_FRAME_BYTES,
  ServerLogFramer,
} from '../src/main/services/server-log-transport.js';

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

const serverView = source('../src/renderer/app/views/ServerView.svelte');
const fixture = source('../src/renderer/app/fixtures/settings-server-fixture.ts');

describe('Server log state and sizing contracts', () => {
  test('keeps loading, empty, short, and long body states deterministic', () => {
    expect(getServerLogBodySize('loading', 0)).toBe('empty');
    expect(getServerLogBodySize('error', 42)).toBe('empty');
    expect(getServerLogBodySize('ready', 0)).toBe('empty');
    expect(getServerLogBodySize('ready', 1)).toBe('short');
    expect(getServerLogBodySize('ready', SHORT_SERVER_LOG_ENTRY_LIMIT)).toBe('short');
    expect(getServerLogBodySize('ready', SHORT_SERVER_LOG_ENTRY_LIMIT + 1)).toBe('long');
    expect(getServerLogBodySize('ready', MAX_SERVER_LOG_ENTRIES)).toBe('long');
    expect(getServerLogBodySize('ready', Number.NaN)).toBe('empty');
  });

  test('uses honest accessible count labels for every retrieval state', () => {
    expect(getServerLogCountLabel('loading', 0)).toBe('Loading');
    expect(getServerLogCountLabel('error', 42)).toBe('Unavailable');
    expect(getServerLogCountLabel('ready', 0)).toBe('No logs');
    expect(getServerLogCountLabel('ready', 1)).toBe('1 log');
    expect(getServerLogCountLabel('ready', 3)).toBe('3 logs');
  });

  test('exposes loading, empty, and unavailable states with a safe retry', () => {
    expect(serverView).toContain("let logsLoadState = $state<ServerLogLoadState>('loading')");
    expect(serverView).toContain('data-server-logs-state="loading"');
    expect(serverView).toContain('role="status" aria-live="polite"');
    expect(serverView).toContain('data-server-logs-state="empty"');
    expect(serverView).toContain('data-server-logs-state="error"');
    expect(serverView).toContain('role="alert"');
    expect(serverView).toContain('onclick={retryLogs}');
    expect(serverView).toContain('await window.murmurMain.getServerLogs()');
    expect(serverView).toContain('SERVER_LOG_LOAD_ERROR');
    expect(SERVER_LOG_LOAD_ERROR).toBe('Server logs are unavailable right now.');

    const logPanelStart = serverView.indexOf('<div id={logOutputId} hidden={!showLogs}');
    const logStateStart = serverView.indexOf('{#if logsLoadState === \'loading\'}');
    expect(logPanelStart).toBeGreaterThanOrEqual(0);
    expect(logStateStart).toBeGreaterThan(logPanelStart);
  });

  test('keeps short content natural and bounds only long content to the nested log scroller', () => {
    expect(serverView).toContain('data-log-size={logBodySize}');
    expect(serverView).toContain("'max-h-64 overflow-y-auto overscroll-contain'");
    expect(serverView).toContain("'min-h-16 overflow-hidden'");
    expect(serverView).toContain('MAX_SERVER_LOG_ENTRIES');
    expect(serverView).toContain('pendingLogs.length > MAX_SERVER_LOG_ENTRIES');
  });

  test('preserves privacy, keyboard access, auto-follow, copy guards, and listener cleanup', () => {
    expect(serverView).toContain('data-server-logs-privacy');
    expect(serverView).toContain('tabindex="0"');
    expect(serverView).toContain('role="log"');
    expect(serverView).toContain('aria-label="Server log output"');
    expect(serverView).toContain('aria-describedby={privacyWarningId}');
    expect(serverView).toContain('disabled={logsLoadState !== \'ready\' || logs.length === 0}');
    expect(serverView).toContain('if (logsLoadState !== \'ready\' || logs.length === 0) return;');
    expect(serverView).toContain('scrollAfterLogBatch ||= showLogs && isScrolledToBottom()');
    expect(serverView).toContain('removeLogListener?.()');
    expect(serverView).toContain('if (logsCopiedTimer !== null) clearTimeout(logsCopiedTimer);');
  });

  test('provides deterministic fixture states without private or random log content', () => {
    for (const state of ['managed-short', 'managed-empty', 'managed-log-error', 'managed-log-loading']) {
      expect(fixture).toContain(`'${state}'`);
    }
    expect(fixture).toContain('if (logLoading) return new Promise<ServerLogEntry[]>(() => {})');
    expect(fixture).toContain("if (logError) throw new Error('fixture log retrieval failed')");
    expect(fixture).toContain('Array.from({ length: logCount }');
  });

  test('frames fragmented UTF-8 output and bare carriage-return progress updates', () => {
    const framer = new ServerLogFramer();

    expect(framer.push(Buffer.from('ready: 50'))).toEqual([]);
    expect(framer.push(Buffer.from('%\rready: 100%\nnext '))).toEqual([
      'ready: 50%',
      'ready: 100%',
    ]);
    expect(framer.push(Buffer.from('entry\r\nlast'))).toEqual(['next entry']);
    expect(framer.flush()).toEqual(['last']);
  });

  test('bounds delimiter-free UTF-8 output without losing code points', () => {
    const framer = new ServerLogFramer();
    const payload = '🙂'.repeat(Math.ceil(MAX_PENDING_FRAME_BYTES / 4) + 7);

    const firstFrames = framer.push(payload);
    const finalFrames = framer.flush();
    const frames = [...firstFrames, ...finalFrames];

    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => Buffer.byteLength(frame, 'utf8') <= MAX_PENDING_FRAME_BYTES)).toBeTrue();
    expect(frames.join('')).toBe(payload);
  });

  test('bounds high-rate delivery queue while retaining the newest diagnostics', () => {
    const queue = new BoundedLogDeliveryQueue<number>(3);

    for (let entry = 1; entry <= 6; entry += 1) queue.enqueue(entry);

    expect(queue.size).toBe(3);
    expect(queue.drain(2)).toEqual([4, 5]);
    expect(queue.drain(2)).toEqual([6]);
    expect(queue.size).toBe(0);
  });
});
