import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Resolve build-time identifiers so the deployed PWA can show users which
// build they're looking at. Helps confirm whether a hard-refresh actually
// picked up the latest deploy.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as {
  version: string;
};
function gitShortHash(): string {
  try {
    return execSync('git rev-parse --short=8 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}
const BUILD_VERSION = pkg.version;
const BUILD_COMMIT = gitShortHash();
const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
    __APP_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __APP_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    react(),
    // @safe-global/protocol-kit pulls in Buffer + process — polyfill for browser.
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'events'],
      globals: { Buffer: true, process: true, global: true },
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'DOMOVINA Wallet',
        short_name: 'DOMOVINA',
        description: 'Self-custody EURe wallet on Gnosis Chain — passkey signing, no seed phrase',
        theme_color: '#002F6C',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/pay\.domovina\.ai\/api\//,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
