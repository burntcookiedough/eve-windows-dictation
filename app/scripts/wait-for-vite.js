// Wait for Vite dev server to be ready before starting Electron
import http from 'http';

const VITE_URL = 'http://localhost:5173/overlay/index.html';
const MAX_RETRIES = 60;
const RETRY_INTERVAL = 500;

async function checkVite() {
  return new Promise((resolve) => {
    const req = http.get(VITE_URL, (res) => {
      // Any response means Vite is running
      resolve(true);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.setTimeout(2000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForVite() {
  console.log('Waiting for Vite dev server...');

  for (let i = 0; i < MAX_RETRIES; i++) {
    const isReady = await checkVite();
    if (isReady) {
      console.log('Vite dev server is ready!');
      return;
    }
    await new Promise(r => setTimeout(r, RETRY_INTERVAL));
  }

  console.error('Vite dev server did not start in time');
  process.exit(1);
}

waitForVite();
