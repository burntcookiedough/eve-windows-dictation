import { MURMUR_IDENTITY } from './identity.js';
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
  readonly userDataDirectoryName: string;
  readonly prepareUserDataRoot?: UserDataRootPreparer;
}

/**
 * Establish process and data identity before importing modules that construct
 * Electron Store instances or resolve History/server paths at module load.
 */
export async function bootstrapApplication(
  electronApp: BootstrapApp,
  loadApplication: ApplicationLoader,
  options: BootstrapOptions
): Promise<boolean> {
  const appDataPath = electronApp.getPath('appData');
  const prepareUserDataRoot =
    options.prepareUserDataRoot ?? prepareUserDataRootSync;
  const userDataPath = prepareUserDataRoot(
    appDataPath,
    options.userDataDirectoryName
  );

  electronApp.setPath('userData', userDataPath);
  electronApp.setPath('sessionData', userDataPath);

  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }

  if ((options.platform ?? process.platform) === 'win32') {
    electronApp.setAppUserModelId(MURMUR_IDENTITY.appId);
  }

  await loadApplication();
  return true;
}
