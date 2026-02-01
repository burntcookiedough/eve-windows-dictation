import { rm } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

// Get the app data directory
// In WSL, map to Windows APPDATA via /mnt/c/Users/<user>/AppData/Roaming
function getAppDataDir() {
  // Check if running in WSL
  const isWSL = process.platform === 'linux' && existsSync('/mnt/c');

  if (isWSL) {
    // Get Windows username from home directory path or current user
    const home = homedir();
    const match = home.match(/\/mnt\/c\/Users\/([^/]+)/);
    if (match) {
      return join('/mnt/c/Users', match[1], 'AppData/Roaming/murmur');
    }
    // Fallback: try to find it from /mnt/c/Users
    const username = process.env.USER || process.env.USERNAME;
    if (username) {
      return join('/mnt/c/Users', username, 'AppData/Roaming/murmur');
    }
  }

  // Windows native or fallback
  if (process.env.APPDATA) {
    return join(process.env.APPDATA, 'murmur');
  }

  // Linux/Mac fallback
  return join(homedir(), '.config', 'murmur');
}

const appDataDir = getAppDataDir();

const files = [
  'settings.json',  // electron-store
  'history.db',     // SQLite database
  'history.db-wal', // SQLite WAL file
  'history.db-shm', // SQLite shared memory
];

console.log(`Clearing app data from: ${appDataDir}`);

let cleared = 0;
for (const file of files) {
  const filePath = join(appDataDir, file);
  if (existsSync(filePath)) {
    try {
      await rm(filePath);
      console.log(`  Deleted: ${file}`);
      cleared++;
    } catch (error) {
      console.error(`  Failed to delete ${file}:`, error.message);
    }
  }
}

if (cleared === 0) {
  console.log('  No data files found to clear.');
} else {
  console.log(`\nCleared ${cleared} file(s).`);
}
