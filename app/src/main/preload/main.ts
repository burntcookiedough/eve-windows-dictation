import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';

// Define the API exposed to the main window renderer
const murmurMainAPI = {
  // Window controls
  closeWindow: () => {
    ipcRenderer.send(IPC_CHANNELS.MAIN_WINDOW_CLOSE);
  },

  minimizeWindow: () => {
    ipcRenderer.send(IPC_CHANNELS.MAIN_WINDOW_MINIMIZE);
  },

  // Settings
  getSettings: () => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SETTINGS);
  },

  // Cleanup
  removeAllListeners: () => {
    // Add listener cleanup here as needed
  },
};

// Expose the API to the renderer
contextBridge.exposeInMainWorld('murmurMain', murmurMainAPI);

// TypeScript declaration for the exposed API
export type MurmurMainAPI = typeof murmurMainAPI;

declare global {
  interface Window {
    murmurMain: typeof murmurMainAPI;
  }
}
