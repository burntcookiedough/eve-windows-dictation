import { MURMUR_IDENTITY, resolveUserDataPath } from './identity.js';

export interface BootstrapApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  getPath(name: 'appData'): string;
  setPath(name: 'userData', path: string): void;
  setAppUserModelId(id: string): void;
}

export type ApplicationLoader = () => Promise<unknown>;

/**
 * Establish process and data identity before importing modules that construct
 * Electron Store instances or resolve History/server paths at module load.
 */
export async function bootstrapApplication(
  electronApp: BootstrapApp,
  loadApplication: ApplicationLoader,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }

  const userDataPath = resolveUserDataPath(electronApp.getPath('appData'));
  electronApp.setPath('userData', userDataPath);

  if (platform === 'win32') {
    electronApp.setAppUserModelId(MURMUR_IDENTITY.appId);
  }

  await loadApplication();
  return true;
}
