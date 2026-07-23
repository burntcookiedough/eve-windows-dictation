import { app, dialog } from 'electron';
import { bootstrapApplication } from './bootstrap-core.js';
import { EVE_USER_DATA_DIRECTORY_NAME } from './identity.js';

try {
  await bootstrapApplication(app, () => import('./index.js'), {
    userDataDirectoryName: EVE_USER_DATA_DIRECTORY_NAME,
  });
} catch {
  dialog.showErrorBox(
    'Murmur could not start',
    'Murmur could not initialize its application data folder. Verify that the folder is a regular directory and that your account can write to it, then try again.'
  );
  app.quit();
}
