import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface UserDataRootFileSystem {
  realpath(path: string): string;
  mkdir(path: string): void;
  lstat(path: string): Pick<fs.Stats, 'isDirectory' | 'isSymbolicLink'>;
  open(path: string): number;
  close(descriptor: number): void;
  unlink(path: string): void;
}

const nodeFileSystem: UserDataRootFileSystem = {
  realpath: (value) => fs.realpathSync.native(value),
  mkdir: (value) => fs.mkdirSync(value, { recursive: true }),
  lstat: (value) => fs.lstatSync(value),
  open: (value) => fs.openSync(value, 'wx'),
  close: (descriptor) => fs.closeSync(descriptor),
  unlink: (value) => fs.unlinkSync(value),
};

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
  directoryName: string,
  fileSystem: UserDataRootFileSystem = nodeFileSystem
): string {
  assertDirectoryName(directoryName);

  const canonicalAppDataPath = fileSystem.realpath(appDataPath);
  const userDataPath = path.join(appDataPath, directoryName);
  fileSystem.mkdir(userDataPath);

  const stats = fileSystem.lstat(userDataPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Application data path is not a regular directory');
  }

  const canonicalUserDataPath = fileSystem.realpath(userDataPath);
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
  const descriptor = fileSystem.open(probePath);
  try {
    // Opening the exclusive probe is the write-access check.
  } finally {
    try {
      fileSystem.close(descriptor);
    } finally {
      fileSystem.unlink(probePath);
    }
  }

  return userDataPath;
}
