import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

const devPort = Number.parseInt(process.env.MURMUR_DEV_PORT ?? '5173', 10);

export default defineConfig({
  plugins: [
    svelte({
      configFile: resolve(__dirname, 'svelte.config.js'),
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/renderer/lib'),
      '$shared': resolve(__dirname, 'src/shared'),
    },
  },
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
        app: resolve(__dirname, 'src/renderer/app/index.html'),
      },
    },
  },
  server: {
    port: Number.isFinite(devPort) ? devPort : 5173,
    strictPort: true,
  },
});
