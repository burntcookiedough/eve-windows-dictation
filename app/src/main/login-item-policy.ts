import path from 'node:path';
import { EVE_IDENTITY, MURMUR_IDENTITY } from './identity.js';

export const LOGIN_ITEM_UNAVAILABLE = 'LOGIN_ITEM_UNAVAILABLE';
export const LOGIN_ITEM_UPDATE_FAILED = 'LOGIN_ITEM_UPDATE_FAILED';

export const LEGACY_LOGIN_ITEM_NAMES = [
  'Murmur',
  'electron.app.Murmur',
  MURMUR_IDENTITY.appId,
] as const;

interface LoginItem {
  readonly name: string;
  readonly path: string;
  readonly args: string[];
  readonly scope: 'user' | 'machine';
  readonly enabled: boolean;
}

interface LoginItemState {
  readonly openAtLogin: boolean;
  readonly executableWillLaunchAtLogin?: boolean;
  readonly launchItems?: LoginItem[];
}

interface LoginItemOptions {
  readonly path?: string;
  readonly args?: string[];
}

interface LoginItemUpdate {
  readonly openAtLogin: boolean;
  readonly path: string;
  readonly args: string[];
  readonly name: string;
  readonly enabled?: boolean;
}

export interface LoginItemApp {
  readonly isPackaged: boolean;
  getPath(name: 'exe'): string;
  getLoginItemSettings(options?: LoginItemOptions): LoginItemState;
  setLoginItemSettings(settings: LoginItemUpdate): void;
}

export interface LaunchOnBootContext {
  readonly platform?: NodeJS.Platform;
  readonly localAppData?: string;
}

export interface LaunchOnBootResult {
  readonly removedLegacyEntries: number;
  readonly ignoredLegacyCandidates: number;
}

function normalizeWindowsPath(value: string): string {
  const trimmed = value.trim();
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return path.win32.normalize(unquoted).replace(/[\\/]+$/, '').toLowerCase();
}

function hasNoArguments(item: LoginItem): boolean {
  return item.args.length === 0;
}

function isExactUserLoginItem(
  item: LoginItem,
  name: string,
  executablePath: string
): boolean {
  return (
    item.scope === 'user' &&
    item.name === name &&
    normalizeWindowsPath(item.path) === normalizeWindowsPath(executablePath) &&
    hasNoArguments(item)
  );
}

function getLaunchItems(app: LoginItemApp, executablePath: string): LoginItem[] {
  return app.getLoginItemSettings({
    path: executablePath,
    args: [],
  }).launchItems ?? [];
}

function setExactLoginItem(
  app: LoginItemApp,
  name: string,
  executablePath: string,
  enabled: boolean
): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    ...(enabled ? { enabled: true } : {}),
    name,
    path: executablePath,
    args: [],
  });
}

function verifyEveLoginItem(
  app: LoginItemApp,
  executablePath: string,
  enabled: boolean
): boolean {
  const state = app.getLoginItemSettings({
    path: executablePath,
    args: [],
  });
  const exactItem = (state.launchItems ?? []).find((item) =>
    isExactUserLoginItem(item, EVE_IDENTITY.appId, executablePath)
  );

  if (!enabled) {
    return exactItem === undefined;
  }
  return exactItem?.enabled === true;
}

export function validateLaunchOnBootUpdate(
  enabled: unknown
): asserts enabled is boolean {
  if (typeof enabled !== 'boolean') {
    throw new TypeError('launchOnBoot must be a boolean');
  }
}

export function reconcileLegacyLoginItems(
  app: LoginItemApp,
  context: LaunchOnBootContext = {}
): LaunchOnBootResult {
  if (
    (context.platform ?? process.platform) !== 'win32' ||
    !app.isPackaged ||
    !context.localAppData
  ) {
    return {
      removedLegacyEntries: 0,
      ignoredLegacyCandidates: 0,
    };
  }

  const executablePath = app.getPath('exe');
  const legacyExecutablePath = path.win32.join(
    context.localAppData,
    'Programs',
    'murmur',
    'Murmur.exe'
  );
  const launchItems = getLaunchItems(app, executablePath);
  const exactLegacyItems = launchItems.filter(
    (item) =>
      LEGACY_LOGIN_ITEM_NAMES.includes(
        item.name as (typeof LEGACY_LOGIN_ITEM_NAMES)[number]
      ) &&
      isExactUserLoginItem(item, item.name, legacyExecutablePath)
  );
  const ignoredLegacyCandidates = launchItems.filter((item) => {
    const hasKnownName = LEGACY_LOGIN_ITEM_NAMES.includes(
      item.name as (typeof LEGACY_LOGIN_ITEM_NAMES)[number]
    );
    const hasKnownPath =
      normalizeWindowsPath(item.path) ===
      normalizeWindowsPath(legacyExecutablePath);
    const hasSimilarName = item.name.toLowerCase().includes('murmur');
    return (
      (hasKnownName || hasKnownPath || hasSimilarName) &&
      !exactLegacyItems.includes(item)
    );
  }).length;

  for (const item of exactLegacyItems) {
    setExactLoginItem(app, item.name, legacyExecutablePath, false);
  }

  const remainingItems = getLaunchItems(app, executablePath);
  const legacyEntryRemains = remainingItems.some((item) =>
    exactLegacyItems.some((legacyItem) =>
      isExactUserLoginItem(item, legacyItem.name, legacyExecutablePath)
    )
  );
  if (legacyEntryRemains) {
    throw new Error(LOGIN_ITEM_UPDATE_FAILED);
  }

  return {
    removedLegacyEntries: exactLegacyItems.length,
    ignoredLegacyCandidates,
  };
}

export function applyLaunchOnBoot(
  app: LoginItemApp,
  enabled: unknown,
  context: LaunchOnBootContext = {}
): LaunchOnBootResult {
  validateLaunchOnBootUpdate(enabled);

  if ((context.platform ?? process.platform) !== 'win32' || !app.isPackaged) {
    throw new Error(LOGIN_ITEM_UNAVAILABLE);
  }
  if (enabled && !context.localAppData) {
    throw new Error(LOGIN_ITEM_UNAVAILABLE);
  }

  const executablePath = app.getPath('exe');
  setExactLoginItem(app, EVE_IDENTITY.appId, executablePath, enabled);

  if (!verifyEveLoginItem(app, executablePath, enabled)) {
    if (enabled) {
      setExactLoginItem(app, EVE_IDENTITY.appId, executablePath, false);
    }
    throw new Error(LOGIN_ITEM_UPDATE_FAILED);
  }

  if (!enabled) {
    return {
      removedLegacyEntries: 0,
      ignoredLegacyCandidates: 0,
    };
  }

  try {
    return reconcileLegacyLoginItems(app, context);
  } catch {
    setExactLoginItem(app, EVE_IDENTITY.appId, executablePath, false);
    throw new Error(LOGIN_ITEM_UPDATE_FAILED);
  }
}
