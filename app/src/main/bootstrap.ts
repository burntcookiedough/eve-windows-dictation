import { app, dialog } from 'electron';
import { readdirSync } from 'node:fs';
import { bootstrapApplication } from './bootstrap-core.js';
import { EVE_USER_DATA_DIRECTORY_NAME } from './identity.js';
import { createLogger } from './lib/logger.js';
import { resolveQaProfileIsolation } from './qa-profile-isolation.js';
import { seedFreshCpuProfile } from './fresh-profile-model.js';
import { prepareUserDataRootSync } from './user-data-root.js';

const log = createLogger('Bootstrap');

try {
  let freshProfile = false;
  const qaProfileIsolation = resolveQaProfileIsolation(process.argv);
  if (qaProfileIsolation) {
    app.setPath('appData', qaProfileIsolation.appDataPath);
  }

  await bootstrapApplication(app, () => {
    if (seedFreshCpuProfile(app.getPath('userData'), {
      freshProfile,
      packaged: app.isPackaged,
      platform: process.platform,
      modelOverride: process.env.MURMUR_WHISPER_MODEL,
    })) {
      log.info('Selected small speech model for fresh packaged profile');
    }
    return import('./index.js');
  }, {
    userDataDirectoryName: EVE_USER_DATA_DIRECTORY_NAME,
    prepareUserDataRoot: (appDataPath, directoryName) => {
      const userDataPath = prepareUserDataRootSync(appDataPath, directoryName);
      // Electron can create cache files as soon as userData is assigned.
      freshProfile = readdirSync(userDataPath).length === 0;
      return userDataPath;
    },
  });
} catch (error: unknown) {
  const cause = error instanceof Error ? error : new Error(String(error));
  log.error('Application data bootstrap failed', { error: cause });
  dialog.showErrorBox(
    'Eve could not start',
    'Eve could not initialize its application data folder. Verify that the folder is a regular directory and that your account can write to it, then try again.'
  );
  app.quit();
}
