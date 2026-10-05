import { AUDIO_HEADER_SIZE } from './protocol.js';

/** Normalized mic energy from the existing PCM frame; audio is never retained. */
export function getAudioFrameLevel(buffer: ArrayBuffer): number {
  if (buffer.byteLength < AUDIO_HEADER_SIZE) return 0;
  const view = new DataView(buffer);
  const count = view.getUint16(2, false);
  if (!count || buffer.byteLength !== AUDIO_HEADER_SIZE + count * 2) return 0;
  let energy = 0;
  for (let index = 0; index < count; index += 1) {
    const sample = view.getInt16(AUDIO_HEADER_SIZE + index * 2, true) / 32768;
    energy += sample * sample;
  }
  return Math.min(1, Math.sqrt(energy / count) * 4);
}
