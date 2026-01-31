import { AUDIO_CONFIG } from '../../shared/constants';
import { createAudioFrame } from '../../shared/protocol';

const TARGET_SAMPLE_RATE = AUDIO_CONFIG.SAMPLE_RATE; // 16kHz

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sequenceNumber = 0;
  private isCapturing = false;

  private onAudioData: ((buffer: ArrayBuffer) => void) | null = null;
  private onLevels: ((levels: number[]) => void) | null = null;

  async start(
    onAudioData: (buffer: ArrayBuffer) => void,
    onLevels: (levels: number[]) => void
  ): Promise<void> {
    if (this.isCapturing) return;

    this.onAudioData = onAudioData;
    this.onLevels = onLevels;
    this.sequenceNumber = 0;

    try {
      // Get microphone access
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: TARGET_SAMPLE_RATE,
          channelCount: 1,
        },
      });

      // Create audio context at target sample rate
      this.audioContext = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
      });

      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

      // Use ScriptProcessorNode for simplicity (deprecated but widely supported)
      // Buffer size of 4096 gives us ~256ms of audio at 16kHz
      const bufferSize = AUDIO_CONFIG.FRAME_SIZE * 2; // ~200ms
      this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing) return;

        const inputData = event.inputBuffer.getChannelData(0);
        this.processAudioChunk(inputData);
      };

      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      this.isCapturing = true;
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.isCapturing = false;

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    this.onAudioData = null;
    this.onLevels = null;
  }

  private processAudioChunk(floatData: Float32Array): void {
    // Convert float32 (-1 to 1) to int16 (-32768 to 32767)
    const samples = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]!));
      samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Calculate levels for waveform visualization
    this.calculateLevels(floatData);

    // Create audio frame with protocol header
    const audioFrame = createAudioFrame(this.sequenceNumber, samples);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;

    // Send to main process
    this.onAudioData?.(audioFrame);
  }

  private calculateLevels(floatData: Float32Array): void {
    const numBars = AUDIO_CONFIG.WAVEFORM_BARS;
    const samplesPerBar = Math.floor(floatData.length / numBars);
    const levels: number[] = [];

    for (let i = 0; i < numBars; i++) {
      const start = i * samplesPerBar;
      const end = Math.min(start + samplesPerBar, floatData.length);
      let sum = 0;

      for (let j = start; j < end; j++) {
        const sample = floatData[j]!;
        sum += sample * sample;
      }

      const rms = Math.sqrt(sum / (end - start));
      levels.push(rms);
    }

    this.onLevels?.(levels);
  }
}

// Singleton instance
export const audioCapture = new AudioCapture();
