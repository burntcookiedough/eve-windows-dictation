import { MURMUR_IDENTITY, resolveUserDataPath } from './identity.js';
import { prepareUserDataRootSync } from './user-data-root.js';

export interface BootstrapApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  getPath(name: 'appData'): string;
  setPath(name: 'userData' | 'sessionData', path: string): void;
  setAppUserModelId(id: string): void;
}

export type ApplicationLoader = () => Promise<unknown>;
export type UserDataRootPreparer = (
  appDataPath: string,
  directoryName: string
) => string;

export interface BootstrapOptions {
  readonly platform?: NodeJS.Platform;
  readonly userDataDirectoryName?: string;
  readonly prepareUserDataRoot?: UserDataRootPreparer;
}

/**
 * Establish process and data identity before importing modules that construct
 * Electron Store instances or resolve History/server paths at module load.
 */
export async function bootstrapApplication(
  electronApp: BootstrapApp,
  loadApplication: ApplicationLoader,
  options: BootstrapOptions = {}
): Promise<boolean> {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }

  const appDataPath = electronApp.getPath('appData');
  const directoryName =
    options.userDataDirectoryName ?? MURMUR_IDENTITY.userDataDirectoryName;
  const prepareUserDataRoot =
    options.prepareUserDataRoot ?? prepareUserDataRootSync;
  const userDataPath = prepareUserDataRoot(appDataPath, directoryName);

  electronApp.setPath('userData', userDataPath);
  electronApp.setPath('sessionData', userDataPath);

  if ((options.platform ?? process.platform) === 'win32') {
    electronApp.setAppUserModelId(MURMUR_IDENTITY.appId);
  }

  await loadApplication();
  return true;
}
