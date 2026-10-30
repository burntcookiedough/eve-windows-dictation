import { describe, expect, test } from 'bun:test';
import {
  condenseWarning,
  derivePillView,
  formatElapsed,
  formatWordCount,
  holdVoice,
  VOICE_HOLD_MS,
  type PillInput,
} from '../src/renderer/overlay/pill-view.js';

const base: PillInput = {
  state: 'listening',
  hasListened: true,
  isSpeaking: true,
  elapsedMs: 0,
  isLongSession: false,
  chunk: null,
  wordCount: null,
  alert: '',
};

describe('pill copy', () => {
  test('formats the timer without ever needing more than the pill width', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(7_900)).toBe('0:07');
    expect(formatElapsed(754_000)).toBe('12:34');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
    expect(formatElapsed(-50)).toBe('0:00');
  });

  test('summarizes the result instead of showing transcript text', () => {
    expect(formatWordCount(null)).toBe('Done');
    expect(formatWordCount(0)).toBe('No speech');
    expect(formatWordCount(1)).toBe('1 word');
    expect(formatWordCount(24)).toBe('24 words');
  });

  test('condenses full-sentence warnings to a few words', () => {
    expect(condenseWarning('audio_capture_NotAllowedError', 'Microphone access was denied. Allow microphone access in Windows settings and try again.')).toBe('Mic blocked');
    expect(condenseWarning('audio_capture_NotFoundError', 'The selected microphone is unavailable.')).toBe('Mic not found');
    expect(condenseWarning('audio_capture_OverconstrainedError', 'The selected microphone is unavailable.')).toBe('Mic not found');
    expect(condenseWarning('audio_capture_AudioCaptureError', 'Could not start the microphone.')).toBe('Mic error');
    expect(condenseWarning('vram_exhausted', 'GPU memory was exhausted.')).toBe('GPU memory low');
    expect(condenseWarning('engine_failed', 'The transcription engine failed to load.')).toBe('Engine error');
    expect(condenseWarning('engine_not_ready', 'Downloading speech model — 45%, about 2 min remaining.')).toBe('Model 45%');
    expect(condenseWarning('engine_not_ready', 'The speech model is still loading.')).toBe('Model loading');
    expect(condenseWarning('future_code', 'Something new')).toBe('Something new');
  });
});

describe('voice hold', () => {
  test('opens on speech, rides out short gaps, and ignores room noise', () => {
    expect(holdVoice(0.5, 1_000, 0)).toBe(1_000 + VOICE_HOLD_MS);
    expect(holdVoice(0.02, 1_100, 1_800)).toBe(1_800);
    expect(holdVoice(0.02, 5_000, 0)).toBe(0);
  });

  test('never shortens the hold that keeps the pill open at session start', () => {
    expect(holdVoice(0.5, 1_000, 2_600)).toBe(2_600);
  });
});

describe('derivePillView', () => {
  test('shows the timer while speaking and shrinks to a dot in silence', () => {
    expect(derivePillView({ ...base, elapsedMs: 12_000 })).toMatchObject({ phase: 'live', label: '0:12', isOpen: true });
    expect(derivePillView({ ...base, isSpeaking: false })).toMatchObject({ phase: 'live', isOpen: false });
    expect(derivePillView({ ...base, state: 'transcribing' })).toMatchObject({ phase: 'live', isOpen: true });
  });

  test('tags long dictation next to the timer', () => {
    expect(derivePillView({ ...base, isLongSession: true })).toMatchObject({ tag: 'Long', label: '0:00' });
    expect(derivePillView(base).tag).toBe('');
  });

  test('tells starting apart from transcribing', () => {
    expect(derivePillView({ ...base, state: 'processing', hasListened: false })).toMatchObject({ phase: 'starting', label: 'Starting', isOpen: true });
    expect(derivePillView({ ...base, state: 'processing' })).toMatchObject({ phase: 'working', label: 'Transcribing', isOpen: true });
    expect(derivePillView({ ...base, state: 'processing', chunk: { index: 2, total: 5 } }).label).toBe('Transcribing 2/5');
  });

  test('ends on a word count, or a condensed reason in red', () => {
    expect(derivePillView({ ...base, state: 'success', wordCount: 24 })).toMatchObject({ phase: 'done', label: '24 words', isOpen: true, isAlert: false });
    expect(derivePillView({ ...base, state: 'error', alert: 'Mic blocked' })).toMatchObject({ phase: 'error', label: 'Mic blocked', isAlert: true });
    expect(derivePillView({ ...base, state: 'error' }).label).toBe('Failed');
  });

  test('forces the pill open for a warning even in silence', () => {
    expect(derivePillView({ ...base, isSpeaking: false, alert: 'GPU memory low' })).toMatchObject({ label: 'GPU memory low', isOpen: true, isAlert: true, tag: '' });
  });

  test('collapses when idle', () => {
    expect(derivePillView({ ...base, state: 'idle' })).toMatchObject({ phase: 'idle', label: '', isOpen: false });
  });
});
