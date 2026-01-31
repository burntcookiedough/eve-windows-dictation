import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

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
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
