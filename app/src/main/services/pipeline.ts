import { isPerfTraceEnabled, perfTraceManager } from './perf-trace.js';
import { randomUUID } from 'crypto';
import type {
  DictationSessionMode,
  HistoryEntryWithGroup,
  Settings,
  TranscriptionEntry,
} from '../../shared/types.js';
import type { TextFrameFinal } from '../../shared/protocol.js';
import { countWords } from '../../shared/insights.js';
import { copyToClipboard, pasteText, type ClipboardCopyOutcome, type ClipboardPasteOutcome } from './clipboard.js';
import type { HistoryService } from './history.js';
import type { ForegroundSnapshot } from './paste-helper.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Pipeline');
const CLIPBOARD_FINALIZATION_TIMEOUT_MS = 5000;

function computeDateGroup(timestamp: number): string {
  const now = new Date();
  const date = new Date(timestamp);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  if (date >= weekAgo) return 'This Week';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function sentenceCase(text: string): string {
  return text.replace(/(^|[.!?]\s+)([a-z])/g, (_, prefix: string, letter: string) => {
    return `${prefix}${letter.toUpperCase()}`;
  });
}

function ensureTerminalPunctuation(text: string): string {
  if (!text) return text;
  return /[.!?;:]$/.test(text) ? text : `${text}.`;
}

function applyDictationMode(text: string, mode: Settings['dictationMode']): string {
  const cleaned = normalizeWhitespace(text);
  switch (mode) {
    case 'raw':
      return text;
    case 'clean_prompt':
      return ensureTerminalPunctuation(sentenceCase(cleaned));
    case 'codex_prompt':
      return ensureTerminalPunctuation(sentenceCase(cleaned));
    case 'message_rewrite':
      return ensureTerminalPunctuation(sentenceCase(cleaned));
    case 'command':
      return cleaned
        .replace(/\bnew line\b/gi, '\n')
        .replace(/\bnew paragraph\b/gi, '\n\n')
        .replace(/\btab key\b/gi, '\t')
        .trim();
    default:
      return cleaned;
  }
}

/**
 * Build a TranscriptionEntry from a final text frame
 */
export function buildEntry(frame: TextFrameFinal, sessionMode: DictationSessionMode = 'quick'): TranscriptionEntry {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    text: frame.text,
    confidence: frame.confidence,
    audioDuration: frame.audio_duration,
    transcriptionTime: frame.transcription_time * 1000, // Server sends seconds, we store ms
    wordCount: countWords(frame.text),
    sessionMode,
  };
}

/**
 * Apply post-processing to the entry text based on settings.
 * Stores the raw transcribed text in originalText before modifications.
 */
export function applyPostProcessing(entry: TranscriptionEntry, settings: Settings): TranscriptionEntry {
  const rawText = entry.text;
  let text = rawText;

  log.debug('Post-processing', {
    appendPeriod: settings.appendPeriod,
    appendSpace: settings.appendSpace,
    dictationMode: settings.dictationMode,
    inputLength: rawText.length,
  });

  text = applyDictationMode(text, settings.dictationMode);

  // Append period if enabled and text doesn't already end with punctuation
  if (settings.appendPeriod && text.length > 0) {
    const lastChar = text.charAt(text.length - 1);
    if (!/[.!?;:]$/.test(lastChar)) {
      text += '.';
    }
  }

  // Append space if enabled
  if (settings.appendSpace && text.length > 0) {
    text += ' ';
  }

  log.debug('Post-processing complete', { outputLength: text.length });

  return {
    ...entry,
    text,
    originalText: rawText, // Always store raw transcribed text
  };
}

export type DeliveryOutcome = ClipboardCopyOutcome | ClipboardPasteOutcome | { kind: 'saved' };

export interface DispatchResult {
  entry: TranscriptionEntry;
  entryWithGroup: HistoryEntryWithGroup | null;
  delivery: DeliveryOutcome;
  historyFailed: boolean;
}

interface DispatchOptions {
  clipboardTimeoutMs?: number;
  onHistorySaved?: (entry: HistoryEntryWithGroup) => void;
}

type PasteTargetValue = ForegroundSnapshot | number | null;
type PasteTarget = PasteTargetValue | Promise<PasteTargetValue>;

async function deliverToClipboard(
  entry: TranscriptionEntry,
  settings: Settings,
  pasteTarget: PasteTarget | undefined,
  perfTraceId: string | undefined,
  signal: AbortSignal,
  deadlineUnixMs: number,
  onPasteDispatch: () => void,
): Promise<ClipboardCopyOutcome | ClipboardPasteOutcome> {
  if (!settings.autoPaste) return copyToClipboard(entry.text, perfTraceId, signal, deadlineUnixMs);

  const target = await pasteTarget ?? null;
  const snapshot = typeof target === 'object' ? target : null;
  const targetWindowHandle = typeof target === 'number' ? target : snapshot && 'handle' in snapshot ? snapshot.handle : null;
  const delivery = await pasteText(entry.text, {
    restoreClipboard: settings.restoreClipboardAfterPaste && !settings.autoCopy,
    restoreDelayMs: settings.clipboardRestoreDelayMs,
    targetWindowHandle,
    snapshotFailure: snapshot && 'reason' in snapshot ? snapshot.reason : undefined,
    signal,
    deadlineUnixMs,
    onDispatch: onPasteDispatch,
    ...(perfTraceId ? { perfTraceId } : {}),
  });
  // A paste that reached the target check may already have written or sent input.
  if (settings.autoCopy && delivery.kind === 'skipped_unsafe' && delivery.reason === 'no_target') {
    const copy = await copyToClipboard(entry.text, perfTraceId, signal, deadlineUnixMs);
    return copy.kind === 'copied' ? { ...delivery, copied: true } : copy;
  }
  return delivery;
}

/**
 * Dispatch the entry to all outputs (clipboard, paste, history)
 */
export async function dispatchToOutputs(
  entry: TranscriptionEntry,
  settings: Settings,
  historyService: Pick<HistoryService, 'save'> | null,
  pasteTargetWindowHandle?: PasteTarget,
  perfTraceId?: string,
  options: DispatchOptions = {},
): Promise<DispatchResult> {
  let entryWithGroup: HistoryEntryWithGroup | null = null;
  let historyFailed = false;
  if (historyService) {
    try {
      const histStart = perfTraceId && isPerfTraceEnabled() ? performance.now() : null;
      historyService.save(entry);
      entryWithGroup = { ...entry, dateGroup: computeDateGroup(entry.timestamp) };
      if (histStart !== null) {
        const completedAt = performance.now();
        perfTraceManager.output(perfTraceId, 'history', completedAt - histStart, completedAt);
      }
    } catch (err) {
      log.error('Failed to save to history', { error: err as Error });
      historyFailed = true;
    }
  }

  if (entryWithGroup) {
    try {
      options.onHistorySaved?.(entryWithGroup);
    } catch {
      log.error('Could not notify the renderer of a saved History entry');
    }
  }

  let delivery: DeliveryOutcome = entryWithGroup ? { kind: 'saved' } : { kind: 'failed' };
  if (entry.text && (settings.autoCopy || settings.autoPaste)) {
    const controller = new AbortController();
    const timeoutMs = options.clipboardTimeoutMs ?? CLIPBOARD_FINALIZATION_TIMEOUT_MS;
    const deadlineUnixMs = Date.now() + timeoutMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let pasteDispatchAttempted = false;
    const expiration = new Promise<DeliveryOutcome>(resolve => {
      timeout = setTimeout(() => {
        if (settings.autoPaste && !pasteDispatchAttempted) {
          perfTraceManager.pastePreDispatch(perfTraceId, 'clipboard_finalization_timeout');
        }
        controller.abort();
        log.warn('Clipboard finalization timed out');
        resolve({ kind: 'failed' });
      }, timeoutMs);
    });
    try {
      delivery = await Promise.race([
        deliverToClipboard(entry, settings, pasteTargetWindowHandle, perfTraceId, controller.signal, deadlineUnixMs, () => {
          pasteDispatchAttempted = true;
        }),
        expiration,
      ]);
    } catch {
      if (settings.autoPaste && !pasteDispatchAttempted) perfTraceManager.pastePreDispatch(perfTraceId, 'clipboard_delivery_failed');
      log.error('Clipboard delivery did not complete');
      delivery = { kind: 'failed' };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    entry,
    entryWithGroup,
    delivery,
    historyFailed,
  };
}

/**
 * Full pipeline: build entry, apply post-processing, dispatch to outputs
 */
export async function processFinalTranscription(
  frame: TextFrameFinal,
  settings: Settings,
  historyService: Pick<HistoryService, 'save'> | null,
  sessionMode: DictationSessionMode = 'quick',
  pasteTargetWindowHandle?: PasteTarget,
  perfTraceId?: string,
  options?: DispatchOptions,
): Promise<DispatchResult> {
  const rawEntry = buildEntry(frame, sessionMode);
  const processedEntry = applyPostProcessing(rawEntry, settings);
  return dispatchToOutputs(
    {
      ...processedEntry,
      wordCount: countWords(processedEntry.text),
    },
    settings,
    historyService,
    pasteTargetWindowHandle,
    perfTraceId,
    options,
  );
}
