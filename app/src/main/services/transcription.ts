import { BrowserWindow } from 'electron';
import { WebSocket } from 'ws';
import { IPC_CHANNELS } from '../../shared/constants.js';
import {
  parseServerFrame,
  type ControlFrameStart,
  type ControlFrameStop,
  type TextFrame,
  type TextFrameFinal,
} from '../../shared/protocol.js';
import type { TranscriptionPayload, ConnectionStatePayload, RecordingStatePayload } from '../../shared/types.js';

export class TranscriptionService {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private silenceTimeout: number;
  private partialEmissionInterval: number;
  private overlayWindow: BrowserWindow;
  private sequenceNumber = 0;
  private isReady = false;
  private serverClosing = false; // Server initiated close, don't send stop
  private onFinalCallback: ((frame: TextFrameFinal) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;

  constructor(
    serverUrl: string,
    silenceTimeout: number,
    partialEmissionInterval: number,
    overlayWindow: BrowserWindow
  ) {
    this.serverUrl = serverUrl;
    this.silenceTimeout = silenceTimeout;
    this.partialEmissionInterval = partialEmissionInterval;
    this.overlayWindow = overlayWindow;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sendConnectionState('connecting');

      this.ws = new WebSocket(this.serverUrl);

      this.ws.on('open', () => {
        this.sendStartFrame();
        this.sendConnectionState('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.sendConnectionState('error', error.message);
        reject(error);
      });

      this.ws.on('close', () => {
        this.sendConnectionState('disconnected');
        this.onCloseCallback?.();
      });
    });
  }

  private sendStartFrame(): void {
    const frame: ControlFrameStart = {
      frame: 'control',
      type: 'start',
      silence_timeout: this.silenceTimeout,
      partial_emission_interval: this.partialEmissionInterval,
    };
    this.ws?.send(JSON.stringify(frame));
  }

  // Send pre-formatted audio buffer (already has header)
  sendAudioBuffer(buffer: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isReady) {
      return;
    }
    this.ws.send(Buffer.from(buffer));
  }

  stop(): void {
    // Don't send stop if server already initiated close
    if (this.serverClosing) {
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const frame: ControlFrameStop = {
      frame: 'control',
      type: 'stop',
    };
    this.ws.send(JSON.stringify(frame));
  }

  onFinal(callback: (frame: TextFrameFinal) => void): void {
    this.onFinalCallback = callback;
  }

  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  private handleMessage(data: string): void {
    const frame = parseServerFrame(data);
    if (!frame) {
      console.warn('Failed to parse server frame:', data);
      return;
    }

    if (frame.frame === 'control') {
      switch (frame.type) {
        case 'ready':
          this.isReady = true;
          this.sendRecordingState('listening');
          break;

        case 'error':
          console.error('Server error:', frame.code, frame.message);
          this.sendConnectionState('error', frame.message);
          this.sendRecordingState('error');
          break;

        case 'closing':
          // Server is ending the session - stop accepting audio
          console.log('Server closing session:', frame.reason);
          this.isReady = false;
          this.serverClosing = true; // Don't send stop frame back
          // Trigger close callback to clean up
          this.onCloseCallback?.();
          break;
      }
    } else if (frame.frame === 'text') {
      this.handleTextFrame(frame);
    }
  }

  private handleTextFrame(frame: TextFrame): void {
    const payload: TranscriptionPayload = {
      type: frame.type,
      text: frame.text,
      confidence: frame.confidence,
    };

    this.overlayWindow.webContents.send(IPC_CHANNELS.STATE_TRANSCRIPTION, payload);

    if (frame.type === 'partial') {
      this.sendRecordingState('transcribing');
    } else if (frame.type === 'final') {
      this.sendRecordingState('success');
      this.onFinalCallback?.(frame);
    }
  }

  private sendConnectionState(status: ConnectionStatePayload['status'], error?: string): void {
    const payload: ConnectionStatePayload = { status, error };
    this.overlayWindow.webContents.send(IPC_CHANNELS.STATE_CONNECTION, payload);
  }

  private sendRecordingState(state: RecordingStatePayload['state']): void {
    const payload: RecordingStatePayload = {
      state,
      isRecording: state !== 'idle',
    };
    this.overlayWindow.webContents.send(IPC_CHANNELS.STATE_RECORDING, payload);
  }
}
