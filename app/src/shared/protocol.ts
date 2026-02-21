// WebSocket Protocol Types (per docs/protocol.md)

// Control frames
export interface ControlFrameStart {
  frame: 'control';
  type: 'start';
  silence_timeout: number;
  partial_emission_interval?: number;
  hotwords?: string;
}

export interface ControlFrameStop {
  frame: 'control';
  type: 'stop';
}

export interface ControlFrameReady {
  frame: 'control';
  type: 'ready';
}

export interface ControlFrameError {
  frame: 'control';
  type: 'error';
  code: string;
  message: string;
}

export interface ControlFrameWarning {
  frame: 'control';
  type: 'warning';
  code: string;
  message: string;
}

export interface ControlFrameClosing {
  frame: 'control';
  type: 'closing';
  reason: 'stop_received' | 'silence_timeout';
}

export type ControlFrame =
  | ControlFrameStart
  | ControlFrameStop
  | ControlFrameReady
  | ControlFrameError
  | ControlFrameWarning
  | ControlFrameClosing;

// Text frames
export interface TextFramePartial {
  frame: 'text';
  type: 'partial';
  text: string;
  confidence: number;
  transcription_time: number;
  audio_duration: number;
}

export interface TextFrameFinal {
  frame: 'text';
  type: 'final';
  text: string;
  confidence: number;
  transcription_time: number;
  audio_duration: number;
}

export type TextFrame = TextFramePartial | TextFrameFinal;

export type ServerFrame =
  | ControlFrameReady
  | ControlFrameError
  | ControlFrameWarning
  | ControlFrameClosing
  | TextFrame;

// Audio frame header constants
export const AUDIO_HEADER_SIZE = 5; // 2 (seq) + 2 (sample count) + 1 (flags)
export const AUDIO_SAMPLE_RATE = 16000;
export const AUDIO_BIT_DEPTH = 16;
export const AUDIO_CHANNELS = 1;

// Create audio frame binary data
export function createAudioFrame(sequence: number, samples: Int16Array): ArrayBuffer {
  const sampleCount = samples.length;
  const buffer = new ArrayBuffer(AUDIO_HEADER_SIZE + sampleCount * 2);
  const view = new DataView(buffer);

  // Sequence (2 bytes, big-endian)
  view.setUint16(0, sequence & 0xFFFF, false);
  // Sample count (2 bytes, big-endian)
  view.setUint16(2, sampleCount, false);
  // Flags (1 byte, reserved)
  view.setUint8(4, 0x00);

  // PCM data (little-endian) - write each sample via DataView due to odd header size
  for (let i = 0; i < sampleCount; i++) {
    view.setInt16(AUDIO_HEADER_SIZE + i * 2, samples[i]!, true); // true = little-endian
  }

  return buffer;
}

// Parse server frame
export function parseServerFrame(data: string): ServerFrame | null {
  try {
    const parsed = JSON.parse(data);
    if (parsed.frame === 'control' || parsed.frame === 'text') {
      return parsed as ServerFrame;
    }
    return null;
  } catch {
    return null;
  }
}
