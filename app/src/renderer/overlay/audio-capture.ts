import { AUDIO_CONFIG } from '../../shared/constants';
import { createAudioFrame } from '../../shared/protocol';

const TARGET_SAMPLE_RATE = AUDIO_CONFIG.SAMPLE_RATE; // 16kHz

export interface AudioCaptureOptions {
  historyLength?: number;       // Number of bars in history (default: 24)
  historyUpdateMs?: number;     // How often to shift history (default: 50ms)
  normalizationSmooth?: number; // 0-1, higher = slower adaptation (default: 0.92)
  responsiveRatio?: number;     // Fraction of bars that blend to current level (default: 0.1)
}

const DEFAULTS: Required<AudioCaptureOptions> = {
  historyLength: 40,
  historyUpdateMs: 40,
  normalizationSmooth: 0.97, // slower adaptation = more dynamic range
  responsiveRatio: 0.10,
};

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sequenceNumber = 0;
  private isCapturing = false;

  private onAudioData: ((buffer: ArrayBuffer) => void) | null = null;
  private onLevels: ((levels: number[]) => void) | null = null;

  // Configuration
  private options: Required<AudioCaptureOptions> = DEFAULTS;

  // Rolling history of RMS levels
  private levelHistory: number[] = [];
  private currentLevel = 0;
  private smoothedLevel = 0; // Smoothed version for display
  private maxLevel = 0.01;
  private animationFrame: number | null = null;
  private lastHistoryUpdate = 0;

  async start(
    onAudioData: (buffer: ArrayBuffer) => void,
    onLevels: (levels: number[]) => void,
    options?: AudioCaptureOptions
  ): Promise<void> {
    if (this.isCapturing) return;

    this.options = { ...DEFAULTS, ...options };
    this.onAudioData = onAudioData;
    this.onLevels = onLevels;
    this.sequenceNumber = 0;
    this.levelHistory = new Array(this.options.historyLength).fill(0);
    this.currentLevel = 0;
    this.smoothedLevel = 0;
    this.maxLevel = 0.01;
    this.lastHistoryUpdate = performance.now();

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

      // Use AnalyserNode for visualization
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.5;

      // ScriptProcessor for sending audio data to server
      const bufferSize = 512;
      this.processorNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      this.processorNode.onaudioprocess = (event) => {
        if (!this.isCapturing) return;
        const inputData = event.inputBuffer.getChannelData(0);
        this.sendAudioToServer(inputData);
      };

      // Connect nodes
      this.sourceNode.connect(this.analyserNode);
      this.sourceNode.connect(this.processorNode);
      this.processorNode.connect(this.audioContext.destination);

      this.isCapturing = true;
      this.startVisualizationLoop();
    } catch (error) {
      console.error('Failed to start audio capture:', error);
      this.stop();
      throw error;
    }
  }

  stop(): void {
    this.isCapturing = false;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.analyserNode) {
      this.analyserNode.disconnect();
      this.analyserNode = null;
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

  private startVisualizationLoop(): void {
    const update = () => {
      if (!this.isCapturing || !this.analyserNode) return;

      const now = performance.now();

      // Get current audio level
      const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
      this.analyserNode.getByteTimeDomainData(dataArray);

      // Calculate RMS
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const sample = (dataArray[i]! - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Update max level for auto-normalization
      // Use a fixed baseline so quiet sounds stay small
      const baselineMax = 0.15; // Minimum max level - keeps quiet sounds quiet
      if (rms > this.maxLevel) {
        // Fast attack when louder
        this.maxLevel = this.maxLevel * 0.7 + rms * 0.3;
      } else {
        // Slow decay
        this.maxLevel = this.maxLevel * this.options.normalizationSmooth +
                        rms * (1 - this.options.normalizationSmooth) * 0.1;
      }
      this.maxLevel = Math.max(baselineMax, this.maxLevel);

      // Normalize
      this.currentLevel = Math.min(1, rms / this.maxLevel);

      // Smooth the level for display (prevents jittery rightmost bars)
      // Fast attack, slower decay for natural feel
      if (this.currentLevel > this.smoothedLevel) {
        this.smoothedLevel = this.smoothedLevel * 0.5 + this.currentLevel * 0.5;
      } else {
        this.smoothedLevel = this.smoothedLevel * 0.8 + this.currentLevel * 0.2;
      }

      // Update history at slower rate
      if (now - this.lastHistoryUpdate >= this.options.historyUpdateMs) {
        this.levelHistory.shift();
        this.levelHistory.push(this.currentLevel);
        this.lastHistoryUpdate = now;
      }

      // Create blended output: rightmost bars blend toward current level
      const output = this.blendWithCurrentLevel();

      // Send to callback
      this.onLevels?.(output);

      this.animationFrame = requestAnimationFrame(update);
    };

    this.animationFrame = requestAnimationFrame(update);
  }

  private blendWithCurrentLevel(): number[] {
    const len = this.levelHistory.length;
    const responsiveBars = Math.max(1, Math.floor(len * this.options.responsiveRatio));
    const output = [...this.levelHistory];

    // Blend the rightmost bars with current level
    // Rightmost bar = 100% current, then gradually less
    for (let i = 0; i < responsiveBars; i++) {
      const idx = len - 1 - i;
      // t goes from 1 (rightmost) to 0 (edge of responsive zone)
      const t = 1 - (i / responsiveBars);
      // Use easeOut for smoother falloff
      const blend = t * t;
      output[idx] = this.levelHistory[idx]! * (1 - blend) + this.smoothedLevel * blend;
    }

    return output;
  }

  private sendAudioToServer(floatData: Float32Array): void {
    const samples = new Int16Array(floatData.length);
    for (let i = 0; i < floatData.length; i++) {
      const s = Math.max(-1, Math.min(1, floatData[i]!));
      samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    const audioFrame = createAudioFrame(this.sequenceNumber, samples);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
    this.onAudioData?.(audioFrame);
  }
}

// Singleton instance
export const audioCapture = new AudioCapture();
