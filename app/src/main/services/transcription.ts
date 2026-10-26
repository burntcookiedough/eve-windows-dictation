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
import { isPerfTraceEnabled, perfTraceManager } from './perf-trace.js';

const log = createLogger('Transcription');

export class TranscriptionConnectionCancelledError extends Error {
  constructor() {
    super('Transcription connection cancelled');
    this.name = 'TranscriptionConnectionCancelledError';
  }
}

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
  private onFinalCallback: ((frame: TextFrameFinal, receivedAt?: number) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private onRecordingStateCallback: ((payload: RecordingStatePayload) => void) | null = null;
  private onConnectionStateCallback: ((payload: ConnectionStatePayload) => void) | null = null;
  private onTranscriptionCallback: ((payload: TranscriptionPayload) => void) | null = null;
  private onWarningCallback: ((payload: RecordingWarningPayload) => void) | null = null;
  private onStatusCallback: ((payload: RecordingStatusPayload) => void) | null = null;
  private didReceiveFinal = false;
  private didReceiveReady = false;
  private stopRequested = false;
  private failed = false;
  private closed = false;
  private cancelPendingConnect: (() => void) | null = null;

  constructor(
    serverUrl: string,
    silenceTimeout: number,
    overlayWindow: BrowserWindow,
    hotwords?: string,
    sessionMode: DictationSessionMode = 'quick',
    private readonly perfTraceId?: string
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
      this.didReceiveFinal = false;
      this.didReceiveReady = false;
      this.stopRequested = false;
      this.failed = false;
      this.closed = false;
      this.sendConnectionState('connecting');
      let connectSettled = false;

      const settleConnect = (error?: Error) => {
        if (connectSettled) return;
        connectSettled = true;
        this.cancelPendingConnect = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      this.cancelPendingConnect = () => {
        settleConnect(new TranscriptionConnectionCancelledError());
      };

      this.ws = new WebSocket(this.serverUrl);

      this.ws.on('open', () => {
        this.sendStartFrame();
        this.sendConnectionState('connected');
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
        if (this.didReceiveReady) {
          settleConnect();
        }
      });

      this.ws.on('error', (error) => {
        if (this.stopRequested && !this.didReceiveReady) return;
        log.error('WebSocket error', { error });
        this.fail(error.message);
        settleConnect(error);
      });

      this.ws.on('close', () => {
        if (!this.didReceiveFinal && !(this.stopRequested && !this.didReceiveReady)) {
          this.fail('Connection closed before a final result; available text is incomplete.');
        }
        this.sendConnectionState('disconnected');
        settleConnect(new Error('WebSocket closed before connection was ready'));
        this.finishClose();
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
    if (isPerfTraceEnabled() && this.perfTraceId) frame.trace_id = this.perfTraceId;

    this.ws?.send(JSON.stringify(frame));
  }

  // Send pre-formatted audio buffer (already has header)
  sendAudioBuffer(buffer: ArrayBuffer): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isReady || this.stopRequested || this.closed || this.failed || this.didReceiveFinal) {
      return;
    }
    this.ws.send(Buffer.from(buffer));
  }

  stop(): void {
    if (this.stopRequested || this.closed || this.failed || this.didReceiveFinal) return;
    this.stopRequested = true;
    this.cancelPendingConnect?.();

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

  /** Abort incomplete capture without dispatching a successful stop/final path. */
  abort(message: string): void {
    this.fail(message);
    this.cancelPendingConnect?.();
    if (this.ws) this.ws.terminate();
    else this.finishClose();
  }

  private fail(message: string): void {
    if (this.failed || this.didReceiveFinal || this.closed) return;
    this.failed = true;
    this.isReady = false;
    this.sendConnectionState('error', message);
    this.sendRecordingState('error');
  }

  private finishClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.isReady = false;
    this.onCloseCallback?.();
  }

  onFinal(callback: (frame: TextFrameFinal, receivedAt?: number) => void): void {
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
    if (this.closed || this.failed) return;
    const frame = parseServerFrame(data);
    if (!frame) {
      log.warn('Failed to parse server frame', { dataLength: data.length });
      return;
    }
    if (this.didReceiveFinal && !(frame.frame === 'control' && frame.type === 'closing')) return;

    if (frame.frame === 'control') {
      switch (frame.type) {
        case 'ready':
          if (this.stopRequested || this.didReceiveReady) break;
          this.didReceiveReady = true;
          this.isReady = true;
          this.sendRecordingState('listening');
          break;

        case 'error':
          log.error('Server error', { code: frame.code, message: frame.message });
          this.fail(frame.message);
          this.ws?.terminate();
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
          if (!this.didReceiveFinal) this.fail('Session ended without a final result; available text is incomplete.');
          this.isReady = false;
          this.serverClosing = true; // Don't send stop frame back
          // Trigger close callback to clean up
          this.finishClose();
          this.ws?.close();
          break;
      }
    } else if (frame.frame === 'text') {
      this.handleTextFrame(frame);
    }
  }

  private handleTextFrame(frame: TextFrame): void {
    if (!this.didReceiveReady) return;
    if (frame.type === 'final') {
      this.didReceiveFinal = true;
      this.isReady = false;
    }
    const receivedAt = this.perfTraceId ? performance.now() : undefined;
    const payload: TranscriptionPayload = {
      type: frame.type,
      text: frame.text,
      confidence: frame.confidence,
    };
    if (isPerfTraceEnabled() && this.perfTraceId) payload.perfTraceId = this.perfTraceId;

    this.broadcastToOverlay(IPC_CHANNELS.STATE_TRANSCRIPTION, payload);
    this.onTranscriptionCallback?.(payload);

    if (frame.type === 'partial') {
      perfTraceManager.mark(this.perfTraceId, 'firstPartialReceivedAt', receivedAt);
      this.sendRecordingState('transcribing');
    } else if (frame.type === 'final') {
      this.sendRecordingState('success');
      this.onFinalCallback?.(frame, receivedAt);
      this.finishClose();
      this.ws?.close();
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
      mode: this.sessionMode,
    };
    this.broadcastToOverlay(IPC_CHANNELS.STATE_RECORDING, payload);
    this.onRecordingStateCallback?.(payload);
  }
}
