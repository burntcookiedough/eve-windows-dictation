import fs from 'node:fs';
import path from 'node:path';

export const EVE_QA_ISOLATION_SWITCH = '--eve-qa-isolation';
export const EVE_QA_USER_DATA_ROOT_SWITCH = '--eve-qa-user-data-root';
const ELECTRON_USER_DATA_DIR_SWITCH = '--user-data-dir';

export interface QaProfileIsolation {
  readonly appDataPath: string;
}

interface QaProfileIsolationFileSystem {
  realpath(path: string): string;
  stat(path: string): Pick<fs.Stats, 'isDirectory'>;
}

const nodeFileSystem: QaProfileIsolationFileSystem = {
  realpath: (value) => fs.realpathSync.native(value),
  stat: (value) => fs.statSync(value),
};

function isQaLookingArgument(argument: string): boolean {
  return argument.toLowerCase().startsWith('--eve-qa-');
}

function isElectronUserDataDirArgument(argument: string): boolean {
  const normalizedArgument = argument.toLowerCase();
  return (
    normalizedArgument === ELECTRON_USER_DATA_DIR_SWITCH ||
    normalizedArgument.startsWith(`${ELECTRON_USER_DATA_DIR_SWITCH}=`)
  );
}

function assertCanonicalQaUserDataRoot(value: string): string {
  if (!value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error('QA user-data root must be an absolute path');
  }

  if (value.endsWith(path.sep) || value.endsWith('/') || value.endsWith('\\')) {
    throw new Error('QA user-data root must not end with a path separator');
  }

  if (path.normalize(value) !== value) {
    throw new Error('QA user-data root must be canonical');
  }

  if (path.basename(value).toLowerCase() !== 'eve') {
    throw new Error('QA user-data root must name the Eve directory');
  }

  return value;
}

/**
 * Parses the explicitly opt-in packaged-QA profile arguments. Any QA-looking
 * argument is fail-closed so a malformed QA launch cannot fall back to a real
 * user profile.
 */
export function parseQaProfileIsolationArguments(
  argv: readonly string[]
): string | null {
  const qaArguments = argv.filter(isQaLookingArgument);
  if (qaArguments.length === 0) {
    return null;
  }

  const isolationArguments = qaArguments.filter(
    (argument) => argument === EVE_QA_ISOLATION_SWITCH
  );
  const rootPrefix = `${EVE_QA_USER_DATA_ROOT_SWITCH}=`;
  const rootArguments = qaArguments.filter((argument) =>
    argument.startsWith(rootPrefix)
  );

  if (
    qaArguments.length !== 2 ||
    isolationArguments.length !== 1 ||
    rootArguments.length !== 1 ||
    argv.some(isElectronUserDataDirArgument)
  ) {
    throw new Error('Invalid packaged QA profile arguments');
  }

  const [rootArgument] = rootArguments;
  if (!rootArgument) {
    throw new Error('Invalid packaged QA profile arguments');
  }

  return assertCanonicalQaUserDataRoot(rootArgument.slice(rootPrefix.length));
}

/**
 * Resolves the QA parent before Electron bootstrap. The existing bootstrap
 * still creates and validates its direct Eve child with the normal defenses.
 */
export function resolveQaProfileIsolation(
  argv: readonly string[],
  fileSystem: QaProfileIsolationFileSystem = nodeFileSystem
): QaProfileIsolation | null {
  const userDataRoot = parseQaProfileIsolationArguments(argv);
  if (!userDataRoot) {
    return null;
  }

  const requestedAppDataPath = path.dirname(userDataRoot);
  if (!fileSystem.stat(requestedAppDataPath).isDirectory()) {
    throw new Error('QA app-data parent must be a directory');
  }

  return {
    appDataPath: fileSystem.realpath(requestedAppDataPath),
  };
}
