import type { RecordingState } from '../../shared/types';

export const VOICE_THRESHOLD = 0.08;
/** Long enough to ride out the gaps between words without the pill flapping. */
export const VOICE_HOLD_MS = 800;
/** Keeps the pill open briefly at the start so the running timer is seen. */
export const INTRO_HOLD_MS = 1600;

export type PillPhase = 'idle' | 'starting' | 'live' | 'working' | 'done' | 'error';

export interface PillInput {
  state: RecordingState;
  hasListened: boolean;
  isSpeaking: boolean;
  elapsedMs: number;
  isLongSession: boolean;
  chunk: { index: number; total: number } | null;
  wordCount: number | null;
  alert: string;
}

export interface PillView {
  phase: PillPhase;
  label: string;
  tag: string;
  isOpen: boolean;
  isAlert: boolean;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function formatWordCount(wordCount: number | null): string {
  if (wordCount === null) return 'Done';
  if (wordCount === 0) return 'No speech';
  return wordCount === 1 ? '1 word' : `${wordCount.toLocaleString()} words`;
}

/** Warnings arrive as full sentences; the pill only has room for a few words. */
export function condenseWarning(code: string, message: string): string {
  if (code === 'audio_capture_NotAllowedError') return 'Mic blocked';
  if (code === 'audio_capture_NotFoundError' || code === 'audio_capture_OverconstrainedError') return 'Mic not found';
  if (code.startsWith('audio_capture_')) return 'Mic error';
  if (code === 'vram_exhausted') return 'GPU memory low';
  if (code === 'engine_failed') return 'Engine error';
  if (code === 'engine_not_ready') {
    const percent = message.match(/(\d+)%/)?.[1];
    return percent ? `Model ${percent}%` : 'Model loading';
  }
  return message;
}

export function holdVoice(level: number, now: number, openUntil: number): number {
  return level >= VOICE_THRESHOLD ? Math.max(openUntil, now + VOICE_HOLD_MS) : openUntil;
}

export function derivePillView(input: PillInput): PillView {
  const { state, alert } = input;
  const closed = { tag: '', isAlert: false };

  switch (state) {
    case 'idle':
      return { ...closed, phase: 'idle', label: '', isOpen: false };
    case 'error':
      return { ...closed, phase: 'error', label: alert || 'Failed', isOpen: true, isAlert: true };
    case 'success':
      return { ...closed, phase: 'done', label: formatWordCount(input.wordCount), isOpen: true };
    case 'processing': {
      const phase = input.hasListened ? 'working' : 'starting';
      if (alert) return { ...closed, phase, label: alert, isOpen: true, isAlert: true };
      if (!input.hasListened) return { ...closed, phase, label: 'Starting', isOpen: true };
      return {
        ...closed,
        phase,
        label: input.chunk ? `Transcribing ${input.chunk.index}/${input.chunk.total}` : 'Transcribing',
        isOpen: true,
      };
    }
    case 'listening':
    case 'transcribing':
      if (alert) return { ...closed, phase: 'live', label: alert, isOpen: true, isAlert: true };
      return {
        phase: 'live',
        label: formatElapsed(input.elapsedMs),
        tag: input.isLongSession ? 'Long' : '',
        isOpen: input.isSpeaking,
        isAlert: false,
      };
  }
}
