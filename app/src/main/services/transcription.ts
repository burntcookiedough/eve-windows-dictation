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
import type {
  TranscriptionPayload,
  ConnectionStatePayload,
  RecordingStatePayload,
  RecordingWarningPayload,
} from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Transcription');

export class TranscriptionService {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private silenceTimeout: number;
  private hotwords: string | undefined;
  private overlayWindow: BrowserWindow;
  private sequenceNumber = 0;
  private isReady = false;
  private serverClosing = false; // Server initiated close, don't send stop
  private onFinalCallback: ((frame: TextFrameFinal) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private onRecordingStateCallback: ((payload: RecordingStatePayload) => void) | null = null;
  private onConnectionStateCallback: ((payload: ConnectionStatePayload) => void) | null = null;
  private onTranscriptionCallback: ((payload: TranscriptionPayload) => void) | null = null;
  private onWarningCallback: ((payload: RecordingWarningPayload) => void) | null = null;

  constructor(
    serverUrl: string,
    silenceTimeout: number,
    overlayWindow: BrowserWindow,
    hotwords?: string
  ) {
    this.serverUrl = serverUrl;
    this.silenceTimeout = silenceTimeout;
    this.overlayWindow = overlayWindow;
    this.hotwords = hotwords;
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
        log.error('WebSocket error', { error });
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
    };

    if (this.hotwords) {
      frame.hotwords = this.hotwords;
    }

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

  onRecordingState(callback: (payload: RecordingStatePayload) => void): void {
    this.onRecordingStateCallback = callback;
  }

  onConnectionState(callback: (payload: ConnectionStatePayload) => void): void {
    this.onConnectionStateCallback = callback;
  }

  onTranscription(callback: (payload: TranscriptionPayload) => void): void {
    this.onTranscriptionCallback = callback;
  }

  onWarning(callback: (payload: RecordingWarningPayload) => void): void {
    this.onWarningCallback = callback;
  }

  private broadcastToOverlay<T>(channel: string, payload: T): void {
    if (!this.overlayWindow.isDestroyed()) {
      this.overlayWindow.webContents.send(channel, payload);
    }
  }

  private handleMessage(data: string): void {
    const frame = parseServerFrame(data);
    if (!frame) {
      log.warn('Failed to parse server frame', { data });
      return;
    }

    if (frame.frame === 'control') {
      switch (frame.type) {
        case 'ready':
          this.isReady = true;
          this.sendRecordingState('listening');
          break;

        case 'error':
          log.error('Server error', { code: frame.code, message: frame.message });
          this.sendConnectionState('error', frame.message);
          this.sendRecordingState('error');
          break;

        case 'warning': {
          const payload: RecordingWarningPayload = {
            code: frame.code,
            message: frame.message,
          };
          log.warn('Server warning', payload);
          this.broadcastToOverlay(IPC_CHANNELS.STATE_WARNING, payload);
          this.onWarningCallback?.(payload);
          break;
        }

        case 'closing':
          // Server is ending the session - stop accepting audio
          log.info('Server closing session', { reason: frame.reason });
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

    this.broadcastToOverlay(IPC_CHANNELS.STATE_TRANSCRIPTION, payload);
    this.onTranscriptionCallback?.(payload);

    if (frame.type === 'partial') {
      this.sendRecordingState('transcribing');
    } else if (frame.type === 'final') {
      this.sendRecordingState('success');
      this.onFinalCallback?.(frame);
    }
  }

  private sendConnectionState(status: ConnectionStatePayload['status'], error?: string): void {
    const payload: ConnectionStatePayload = { status, error };
    this.broadcastToOverlay(IPC_CHANNELS.STATE_CONNECTION, payload);
    this.onConnectionStateCallback?.(payload);
  }

  private sendRecordingState(state: RecordingStatePayload['state']): void {
    const payload: RecordingStatePayload = {
      state,
      isRecording: state !== 'idle',
    };
    this.broadcastToOverlay(IPC_CHANNELS.STATE_RECORDING, payload);
    this.onRecordingStateCallback?.(payload);
  }
}
