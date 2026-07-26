import { app, dialog } from 'electron';
import { bootstrapApplication } from './bootstrap-core.js';
import { EVE_USER_DATA_DIRECTORY_NAME } from './identity.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('Bootstrap');

try {
  await bootstrapApplication(app, () => import('./index.js'), {
    userDataDirectoryName: EVE_USER_DATA_DIRECTORY_NAME,
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
