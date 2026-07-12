import { randomUUID } from 'crypto';
import type {
  DictationSessionMode,
  HistoryEntryWithGroup,
  Settings,
  TranscriptionEntry,
} from '../../shared/types.js';
import type { TextFrameFinal } from '../../shared/protocol.js';
import { countWords } from '../../shared/insights.js';
import { copyToClipboard, pasteText } from './clipboard.js';
import type { HistoryService } from './history.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Pipeline');

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
    input: rawText,
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

  log.debug('Post-processing complete', { output: text });

  return {
    ...entry,
    text,
    originalText: rawText, // Always store raw transcribed text
  };
}

export interface DispatchResult {
  entry: TranscriptionEntry;
  entryWithGroup: HistoryEntryWithGroup;
}

/**
 * Dispatch the entry to all outputs (clipboard, paste, history)
 */
export async function dispatchToOutputs(
  entry: TranscriptionEntry,
  settings: Settings,
  historyService: HistoryService | null,
  pasteTargetWindowHandle?: number | null
): Promise<DispatchResult> {
  // Auto-paste temporarily uses the clipboard and can restore the previous value.
  if (settings.autoPaste && entry.text) {
    try {
      await pasteText(entry.text, {
        restoreClipboard: settings.restoreClipboardAfterPaste && !settings.autoCopy,
        restoreDelayMs: settings.clipboardRestoreDelayMs,
        method: settings.pasteMethod,
        targetWindowHandle: pasteTargetWindowHandle,
      });
    } catch (err) {
      log.error('Auto-paste failed', { error: err as Error });
      if (settings.autoCopy) {
        copyToClipboard(entry.text);
      }
    }
  } else if (settings.autoCopy && entry.text) {
    copyToClipboard(entry.text);
  }

  // Save to history
  if (historyService) {
    try {
      historyService.save(entry);
    } catch (err) {
      log.error('Failed to save to history', { error: err as Error });
    }
  }

  // Build entry with date group for push notifications
  const entryWithGroup: HistoryEntryWithGroup = {
    ...entry,
    dateGroup: computeDateGroup(entry.timestamp),
  };

  return { entry, entryWithGroup };
}

/**
 * Full pipeline: build entry, apply post-processing, dispatch to outputs
 */
export async function processFinalTranscription(
  frame: TextFrameFinal,
  settings: Settings,
  historyService: HistoryService | null,
  sessionMode: DictationSessionMode = 'quick',
  pasteTargetWindowHandle?: number | null
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
    pasteTargetWindowHandle
  );
}
