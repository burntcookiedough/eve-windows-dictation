import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function normalizeCanonicalPath(value: string): string {
  return path
    .normalize(value)
    .replace(/^\\\\\?\\/, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase();
}

function assertDirectoryName(directoryName: string): void {
  if (
    !directoryName ||
    directoryName === '.' ||
    directoryName === '..' ||
    path.basename(directoryName) !== directoryName
  ) {
    throw new Error('Invalid application data directory name');
  }
}

/**
 * Create and validate the selected user-data root synchronously so Electron
 * cannot become ready before userData and sessionData are overridden.
 */
export function prepareUserDataRootSync(
  appDataPath: string,
  directoryName: string
): string {
  assertDirectoryName(directoryName);

  const canonicalAppDataPath = fs.realpathSync.native(appDataPath);
  const userDataPath = path.join(appDataPath, directoryName);
  fs.mkdirSync(userDataPath, { recursive: true });

  const stats = fs.lstatSync(userDataPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Application data path is not a regular directory');
  }

  const canonicalUserDataPath = fs.realpathSync.native(userDataPath);
  const expectedCanonicalPath = path.join(canonicalAppDataPath, directoryName);
  if (
    normalizeCanonicalPath(canonicalUserDataPath) !==
    normalizeCanonicalPath(expectedCanonicalPath)
  ) {
    throw new Error('Application data directory redirects outside its expected location');
  }

  const probePath = path.join(
    userDataPath,
    `.profile-write-probe-${process.pid}-${randomUUID()}`
  );
  const descriptor = fs.openSync(probePath, 'wx');
  try {
    // Opening the exclusive probe is the write-access check.
  } finally {
    try {
      fs.closeSync(descriptor);
    } finally {
      fs.unlinkSync(probePath);
    }
  }

  return userDataPath;
}
