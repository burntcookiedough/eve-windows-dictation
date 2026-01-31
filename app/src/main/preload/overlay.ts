import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import type {
  RecordingStatePayload,
  TranscriptionPayload,
  ConnectionStatePayload,
} from '../../shared/types.js';

// Define the API exposed to the renderer
const murmurAPI = {
  // State subscriptions (Main → Renderer)
  onRecordingState: (callback: (state: RecordingStatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RecordingStatePayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.STATE_RECORDING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_RECORDING, handler);
  },

  onConnectionState: (callback: (state: ConnectionStatePayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ConnectionStatePayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.STATE_CONNECTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_CONNECTION, handler);
  },

  onTranscription: (callback: (data: TranscriptionPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TranscriptionPayload) => {
      callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.STATE_TRANSCRIPTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STATE_TRANSCRIPTION, handler);
  },

  // Recording commands (Main → Renderer, tells overlay to start/stop audio capture)
  onStartRecording: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.COMMAND_START_RECORDING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COMMAND_START_RECORDING, handler);
  },

  onStopRecording: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(IPC_CHANNELS.COMMAND_STOP_RECORDING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.COMMAND_STOP_RECORDING, handler);
  },

  // Audio data (Renderer → Main)
  sendAudioData: (buffer: ArrayBuffer) => {
    ipcRenderer.send(IPC_CHANNELS.AUDIO_DATA, buffer);
  },

  // Commands (Renderer → Main)
  copyToClipboard: (text: string) => {
    ipcRenderer.send(IPC_CHANNELS.COMMAND_COPY_TO_CLIPBOARD, text);
  },

  // Cleanup
  removeAllListeners: () => {
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_RECORDING);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_CONNECTION);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.STATE_TRANSCRIPTION);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.COMMAND_START_RECORDING);
    ipcRenderer.removeAllListeners(IPC_CHANNELS.COMMAND_STOP_RECORDING);
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('murmur', murmurAPI);

// TypeScript declaration for the exposed API
export type MurmurAPI = typeof murmurAPI;

declare global {
  interface Window {
    murmur: typeof murmurAPI;
  }
}
