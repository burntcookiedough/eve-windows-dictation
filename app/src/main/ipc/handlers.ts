import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import { copyToClipboard } from '../services/clipboard.js';

export function setupIpcHandlers(): void {
  // Handle clipboard copy requests
  ipcMain.on(IPC_CHANNELS.COMMAND_COPY_TO_CLIPBOARD, (_event, text: string) => {
    copyToClipboard(text);
  });

  // Handle settings requests
  ipcMain.handle(IPC_CHANNELS.GET_SETTINGS, () => {
    // For v0, return hardcoded defaults
    return DEFAULT_SETTINGS;
  });
}
