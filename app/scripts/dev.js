import net from 'net';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const START_PORT = Number.parseInt(process.env.MURMUR_DEV_PORT ?? '5173', 10);
const MAX_PORT = 65535;
const __dirname = dirname(fileURLToPath(import.meta.url));

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '127.0.0.1');
  });
}

async function findOpenPort(startPort) {
  for (let port = startPort; port <= MAX_PORT; port += 1) {
    const free = await isPortFree(port);
    if (free) {
      return port;
    }
  }

  throw new Error('No available port found for Vite dev server');
}

async function run() {
  const selectedPort = await findOpenPort(Number.isFinite(START_PORT) ? START_PORT : 5173);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    MURMUR_DEV_PORT: String(selectedPort),
  };

  console.log(`Using Vite dev port ${selectedPort}`);

  const concurrentlyBin = resolve(__dirname, '../node_modules/concurrently/dist/bin/concurrently.js');
  const child = spawn(
    process.execPath,
    [
      concurrentlyBin,
      '-k',
      'bun run dev:vite',
      'bun run dev:main',
      'bun run dev:electron',
    ],
    { stdio: 'inherit', env }
  );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
