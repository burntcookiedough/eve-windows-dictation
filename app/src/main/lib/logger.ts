/**
 * Minimal structured logging for Murmur.
 *
 * Usage:
 *   import { createLogger } from '../lib/logger.js';
 *   const log = createLogger('MyModule');
 *   log.info('Something happened', { key: 'value' });
 *
 * Levels:
 *   trace - Very noisy internal details (enable: MURMUR_TRACE=1)
 *   debug - Development debugging (enable: MURMUR_DEBUG=1)
 *   info  - Notable events (always on)
 *   warn  - Something unexpected (always on)
 *   error - Failures (always on)
 *
 * Output format (slog-style):
 *   [2024-01-15 14:32:07] INFO  [Clipboard] Writing text length=12 text="Hello"
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: Date;
  level: LogLevel;
  context: string;
  message: string;
  data?: Record<string, unknown>;
}

export type Transport = (entry: LogEntry) => void;

// Configuration from environment
const config = {
  showTrace: process.env.MURMUR_TRACE === '1',
  showDebug: process.env.MURMUR_DEBUG === '1',
};

// Registered transports (console by default, UI can be added later)
const transports: Transport[] = [];

/**
 * Register a transport to receive all log entries.
 */
export function addTransport(transport: Transport): void {
  transports.push(transport);
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM:SS"
 */
function formatTimestamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format a single value for slog-style output.
 */
function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Error) return `"${value.message}"`;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Extract stack trace lines from an Error, indented for display.
 */
function formatErrorStack(error: Error): string[] {
  if (!error.stack) return [];
  const lines = error.stack.split('\n');
  // Skip the first line (it's the error message), take stack frames
  return lines.slice(1).map(line => '    ' + line.trim());
}

/**
 * Format data as slog-style key=value pairs.
 * Returns [inline string, extra lines for error stacks]
 */
function formatData(data: Record<string, unknown>): [string, string[]] {
  const parts: string[] = [];
  const extraLines: string[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value instanceof Error) {
      // Show error message inline, stack as extra lines
      parts.push(`${key}=${formatValue(value)}`);
      extraLines.push(...formatErrorStack(value));
    } else {
      parts.push(`${key}=${formatValue(value)}`);
    }
  }

  return [parts.join(' '), extraLines];
}

/**
 * Console transport - formats and writes to stdout/stderr.
 */
function consoleTransport(entry: LogEntry): void {
  const timestamp = formatTimestamp(entry.timestamp);
  const level = entry.level.toUpperCase().padEnd(5);
  const context = `[${entry.context}]`;

  let line = `[${timestamp}] ${level} ${context} ${entry.message}`;
  let extraLines: string[] = [];

  if (entry.data && Object.keys(entry.data).length > 0) {
    const [dataStr, stacks] = formatData(entry.data);
    if (dataStr) line += ' ' + dataStr;
    extraLines = stacks;
  }

  // Use stderr for warn/error, stdout for others
  const output = entry.level === 'warn' || entry.level === 'error' ? console.error : console.log;
  output(line);
  for (const extra of extraLines) {
    output(extra);
  }
}

// Register console transport by default
addTransport(consoleTransport);

/**
 * Check if a log level should be emitted.
 */
function shouldLog(level: LogLevel): boolean {
  switch (level) {
    case 'trace':
      return config.showTrace;
    case 'debug':
      return config.showDebug;
    default:
      return true;
  }
}

/**
 * Emit a log entry to all transports.
 */
function emit(entry: LogEntry): void {
  if (!shouldLog(entry.level)) return;
  for (const transport of transports) {
    try {
      transport(entry);
    } catch {
      // Don't let transport errors break the app
    }
  }
}

export interface Logger {
  trace(message: string, data?: Record<string, unknown>): void;
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Create a logger scoped to a specific context (module/component name).
 */
export function createLogger(context: string): Logger {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    emit({
      timestamp: new Date(),
      level,
      context,
      message,
      data,
    });
  };

  return {
    trace: (message, data) => log('trace', message, data),
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),
  };
}
