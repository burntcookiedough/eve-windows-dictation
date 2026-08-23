import { AUDIO_CONFIG } from '../../shared/constants';
import { createAudioFrame } from '../../shared/protocol';

const TARGET_SAMPLE_RATE = AUDIO_CONFIG.SAMPLE_RATE;
const WAVEFORM_BARS = AUDIO_CONFIG.WAVEFORM_BARS;

export interface AudioCaptureOptions {
  historyLength?: number;
  historyUpdateMs?: number;
  normalizationSmooth?: number;
  responsiveRatio?: number;
  deviceId?: string; // 'default' or undefined uses system default
}

const DEFAULTS: Required<AudioCaptureOptions> = {
  historyLength: WAVEFORM_BARS,
  historyUpdateMs: 40,
  normalizationSmooth: 0.97,
  responsiveRatio: 0.10,
  deviceId: 'default',
};

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sequenceNumber = 0;
  private isCapturing = false;
  private isStarting = false;
  private startGeneration = 0;

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
    if (this.isCapturing || this.isStarting) return;

    const generation = ++this.startGeneration;
    this.isStarting = true;

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
      // Build audio constraints, using specific device if not 'default'
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: TARGET_SAMPLE_RATE,
        channelCount: 1,
      };
      if (this.options.deviceId && this.options.deviceId !== 'default') {
        audioConstraints.deviceId = { exact: this.options.deviceId };
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      if (generation !== this.startGeneration) {
        this.disposeMedia(stream, null);
        return;
      }
      this.stream = stream;

      const audioContext = new AudioContext({
        sampleRate: TARGET_SAMPLE_RATE,
      });
      this.audioContext = audioContext;

      // Use a Blob URL for the worklet to avoid Vite inlining raw TypeScript
      // as a data: URL (which AudioWorklet can't execute). Blob URLs work
      // reliably in both dev and packaged Electron builds.
      const workletCode = `
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.port.postMessage({ audioData: input[0] });
    }
    return true;
  }
}
registerProcessor('audio-processor', AudioProcessor);
`;
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(blob);
      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      if (generation !== this.startGeneration) {
        if (this.audioContext === audioContext) this.audioContext = null;
        if (this.stream === stream) this.stream = null;
        this.disposeMedia(stream, audioContext);
        return;
      }

      this.sourceNode = audioContext.createMediaStreamSource(stream);

      this.analyserNode = audioContext.createAnalyser();
      this.analyserNode.fftSize = 256;
      this.analyserNode.smoothingTimeConstant = 0.5;

      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
      this.workletNode = workletNode;
      workletNode.port.onmessage = (event) => {
        if (
          !this.isCapturing ||
          generation !== this.startGeneration ||
          this.workletNode !== workletNode
        ) return;
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
      if (generation !== this.startGeneration) return;
      console.error('Failed to start audio capture:', error);
      this.stop();
      throw error;
    } finally {
      if (generation === this.startGeneration) {
        this.isStarting = false;
      }
    }
  }

  stop(): void {
    this.startGeneration += 1;
    this.isStarting = false;
    this.isCapturing = false;

    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }

    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
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

    this.disposeMedia(this.stream, this.audioContext);
    this.audioContext = null;
    this.stream = null;

    this.onAudioData = null;
    this.onLevels = null;
  }

  private disposeMedia(stream: MediaStream | null, audioContext: AudioContext | null): void {
    if (audioContext) {
      void audioContext.close().catch(() => undefined);
    }
    stream?.getTracks().forEach(track => track.stop());
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
