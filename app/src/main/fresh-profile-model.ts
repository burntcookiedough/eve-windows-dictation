import { writeFileSync } from 'node:fs';
import path from 'node:path';

const INITIAL_CPU_MODEL = 'small';

/**
 * Choose the smaller first download for a new packaged Eve profile. An Eve
 * profile that has launched before contains history.db, even if its server
 * settings omit the old large-v3-turbo default. Capture freshness before
 * Electron sets userData, then call this after taking the single-instance
 * lock and before importing application modules.
 */
export function seedFreshCpuProfile(
  userDataPath: string,
  options: {
    freshProfile: boolean;
    packaged: boolean;
    platform: NodeJS.Platform;
    modelOverride?: string;
  },
): boolean {
  if (!options.freshProfile || !options.packaged || options.platform !== 'win32' || options.modelOverride?.trim()) {
    return false;
  }

  try {
    writeFileSync(
      path.join(userDataPath, 'server-settings.json'),
      `${JSON.stringify({ whisper_model: INITIAL_CPU_MODEL }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}
