import { AUDIO_CONFIG } from '../../shared/constants';
import { createAudioFrame } from '../../shared/protocol';

const TARGET_SAMPLE_RATE = AUDIO_CONFIG.SAMPLE_RATE;
const WAVEFORM_BARS = AUDIO_CONFIG.WAVEFORM_BARS;

export interface AudioCaptureOptions {
  historyLength?: number;
  historyUpdateMs?: number;
  normalizationSmooth?: number;
  responsiveRatio?: number;
}

const DEFAULTS: Required<AudioCaptureOptions> = {
  historyLength: WAVEFORM_BARS,
  historyUpdateMs: 40,
  normalizationSmooth: 0.97,
  responsiveRatio: 0.10,
};

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sequenceNumber = 0;
  private isCapturing = false;

  private onAudioData: ((buffer: ArrayBuffer) => void) | null = null;
  private onLevels: ((levels: number[]) => void) | null = null;

  private options: Required<AudioCaptureOptions> = DEFAULTS;

  private levelHistory: number[] = [];
  private currentLevel = 0;
  private smoothedLevel = 0;
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
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: TARGET_SAMPLE_RATE,
          channelCount: 1,
        },
      });

      this.audioContext = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
      });

      const workletUrl = new URL('./audio-processor.worklet.ts', import.meta.url);
      await this.audioContext.audioWorklet.addModule(workletUrl);

      this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.5;

      this.workletNode = new AudioWorkletNode(this.audioContext, 'audio-processor');
      this.workletNode.port.onmessage = (event) => {
        if (!this.isCapturing) return;
        const { audioData } = event.data;
        if (audioData) {
          this.sendAudioToServer(audioData);
        }
      };

      this.sourceNode.connect(this.analyserNode);
      this.sourceNode.connect(this.workletNode);

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

    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
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

      const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);
      this.analyserNode.getByteTimeDomainData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const sample = (dataArray[i]! - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      const baselineMax = 0.15;
      if (rms > this.maxLevel) {
        this.maxLevel = this.maxLevel * 0.7 + rms * 0.3;
      } else {
        this.maxLevel = this.maxLevel * this.options.normalizationSmooth +
                        rms * (1 - this.options.normalizationSmooth) * 0.1;
      }
      this.maxLevel = Math.max(baselineMax, this.maxLevel);

      this.currentLevel = Math.min(1, rms / this.maxLevel);

      if (this.currentLevel > this.smoothedLevel) {
        this.smoothedLevel = this.smoothedLevel * 0.5 + this.currentLevel * 0.5;
      } else {
        this.smoothedLevel = this.smoothedLevel * 0.8 + this.currentLevel * 0.2;
      }

      if (now - this.lastHistoryUpdate >= this.options.historyUpdateMs) {
        this.levelHistory.shift();
        this.levelHistory.push(this.currentLevel);
        this.lastHistoryUpdate = now;
      }

      const output = this.blendWithCurrentLevel();

      this.onLevels?.(output);

      this.animationFrame = requestAnimationFrame(update);
    };

    this.animationFrame = requestAnimationFrame(update);
  }

  private blendWithCurrentLevel(): number[] {
    const len = this.levelHistory.length;
    const responsiveBars = Math.max(1, Math.floor(len * this.options.responsiveRatio));
    const output = [...this.levelHistory];

    for (let i = 0; i < responsiveBars; i++) {
      const idx = len - 1 - i;
      const t = 1 - (i / responsiveBars);
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

export const audioCapture = new AudioCapture();
