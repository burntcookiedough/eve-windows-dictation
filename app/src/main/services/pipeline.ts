import { randomUUID } from 'crypto';
import type { TranscriptionEntry, Settings, HistoryEntryWithGroup } from '../../shared/types.js';
import type { TextFrameFinal } from '../../shared/protocol.js';
import { copyToClipboard, simulatePaste } from './clipboard.js';
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

/**
 * Build a TranscriptionEntry from a final text frame
 */
export function buildEntry(frame: TextFrameFinal): TranscriptionEntry {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    text: frame.text,
    confidence: frame.confidence,
    audioDuration: frame.audio_duration,
    transcriptionTime: frame.transcription_time,
  };
}

/**
 * Apply post-processing to the entry text based on settings.
 * Stores the raw transcribed text in originalText before modifications.
 */
export function applyPostProcessing(entry: TranscriptionEntry, settings: Settings): TranscriptionEntry {
  const rawText = entry.text;
  let text = rawText;

  log.debug('Post-processing', { appendPeriod: settings.appendPeriod, appendSpace: settings.appendSpace, input: rawText });

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
  historyService: HistoryService | null
): Promise<DispatchResult> {
  // Copy to clipboard if enabled
  if (settings.autoCopy && entry.text) {
    copyToClipboard(entry.text);
  }

  // Simulate paste if enabled
  if (settings.autoPaste && entry.text) {
    try {
      await simulatePaste();
    } catch (err) {
      log.error('Auto-paste failed', { error: err as Error });
    }
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
  historyService: HistoryService | null
): Promise<DispatchResult> {
  const rawEntry = buildEntry(frame);
  const processedEntry = applyPostProcessing(rawEntry, settings);
  return dispatchToOutputs(processedEntry, settings, historyService);
}
