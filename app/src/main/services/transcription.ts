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
  RecordingStatusPayload,
  DictationSessionMode,
} from '../../shared/types.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('Transcription');

export class TranscriptionService {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private silenceTimeout: number;
  private hotwords: string | undefined;
  private sessionMode: DictationSessionMode;
  private overlayWindow: BrowserWindow;
  private sequenceNumber = 0;
  private isReady = false;
  private serverClosing = false; // Server initiated close, don't send stop
  private stopRequested = false;
  private onFinalCallback: ((frame: TextFrameFinal) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private onRecordingStateCallback: ((payload: RecordingStatePayload) => void) | null = null;
  private onConnectionStateCallback: ((payload: ConnectionStatePayload) => void) | null = null;
  private onTranscriptionCallback: ((payload: TranscriptionPayload) => void) | null = null;
  private onWarningCallback: ((payload: RecordingWarningPayload) => void) | null = null;
  private onStatusCallback: ((payload: RecordingStatusPayload) => void) | null = null;
  private lastTextFrame: TextFrame | null = null;
  private didReceiveFinal = false;
  private didReceiveReady = false;

  constructor(
    serverUrl: string,
    silenceTimeout: number,
    overlayWindow: BrowserWindow,
    hotwords?: string,
    sessionMode: DictationSessionMode = 'quick'
  ) {
    this.serverUrl = serverUrl;
    this.silenceTimeout = silenceTimeout;
    this.overlayWindow = overlayWindow;
    this.hotwords = hotwords;
    this.sessionMode = sessionMode;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.isReady = false;
      this.serverClosing = false;
      this.stopRequested = false;
      this.lastTextFrame = null;
      this.didReceiveFinal = false;
      this.didReceiveReady = false;
      this.sendConnectionState('connecting');
      let connectSettled = false;

      this.ws = new WebSocket(this.serverUrl);

      this.ws.on('open', () => {
        this.sendStartFrame();
        this.sendConnectionState('connected');
        connectSettled = true;
        resolve();
        if (this.stopRequested) {
          this.stop();
        }
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (error) => {
        log.error('WebSocket error', { error });
        this.sendConnectionState('error', error.message);
        if (!connectSettled) {
          connectSettled = true;
          reject(error);
        }
      });

      this.ws.on('close', () => {
        this.maybeEmitSyntheticFinal('socket_closed');
        this.sendConnectionState('disconnected');
        if (!connectSettled) {
          connectSettled = true;
          reject(new Error('WebSocket closed before connection was ready'));
        }
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
    this.stopRequested = true;

    // Don't send stop if server already initiated close
    if (this.serverClosing) {
      return;
    }

    if (!this.ws) {
      return;
    }

    if (this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
      return;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
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

  onStatus(callback: (payload: RecordingStatusPayload) => void): void {
    this.onStatusCallback = callback;
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
          this.didReceiveReady = true;
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
          log.warn('Server warning', { ...payload });
          this.broadcastToOverlay(IPC_CHANNELS.STATE_WARNING, { ...payload });
          this.onWarningCallback?.(payload);
          break;
        }

        case 'status': {
          if (frame.status !== 'long_dictation_started' && frame.status !== 'long_dictation_processing') {
            log.warn('Ignoring unknown recording status', { status: frame.status });
            break;
          }
          const payload: RecordingStatusPayload = {
            status: frame.status,
            message: frame.message,
            chunkIndex: frame.chunk_index,
            chunkTotal: frame.chunk_total,
            audioDuration: frame.audio_duration,
          };
          this.broadcastToOverlay(IPC_CHANNELS.STATE_STATUS, payload);
          this.onStatusCallback?.(payload);
          if (frame.status === 'long_dictation_processing') {
            this.sendRecordingState('processing');
          }
          break;
        }

        case 'closing':
          // Server is ending the session - stop accepting audio
          log.info('Server closing session', { reason: frame.reason });
          this.maybeEmitSyntheticFinal('server_closing');
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
    this.lastTextFrame = frame;
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
      this.didReceiveFinal = true;
      this.sendRecordingState('success');
      this.onFinalCallback?.(frame);
    }
  }

  private maybeEmitSyntheticFinal(source: 'server_closing' | 'socket_closed'): void {
    if (this.didReceiveFinal) {
      return;
    }
    if (!this.didReceiveReady && this.lastTextFrame == null) {
      return;
    }

    const fallback = this.lastTextFrame;
    const syntheticFinal: TextFrameFinal = {
      frame: 'text',
      type: 'final',
      text: fallback?.text ?? '',
      confidence: fallback?.confidence ?? 0.0,
      transcription_time: 0.0,
      audio_duration: fallback?.audio_duration ?? 0.0,
    };

    log.warn('Synthesizing final frame from best available text', {
      source,
      hadTextFrame: fallback != null,
      sourceFrameType: fallback?.type ?? 'none',
      textLength: syntheticFinal.text.length,
    });
    this.handleTextFrame(syntheticFinal);
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
      mode: this.sessionMode,
    };
    this.broadcastToOverlay(IPC_CHANNELS.STATE_RECORDING, payload);
    this.onRecordingStateCallback?.(payload);
  }
}
