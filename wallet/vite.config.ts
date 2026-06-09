import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { brand as defaultBrand } from './src/brands/default/brand';
import { brand as sportklubBrand } from './src/brands/sportklub/brand';
import { brand as zupaBrand } from './src/brands/zupa/brand';
import type { BrandConfig } from './src/brands/_shared/types';

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

// Resolve the active brand at config time. Same registry the runtime uses
// in `src/app/brand.ts`; duplicated here so HTML head + PWA manifest can
// be tenant-correct in the initial response (before any JS runs).
const BRAND_REGISTRY: Record<string, BrandConfig> = {
  default: defaultBrand,
  sportklub: sportklubBrand,
  zupa: zupaBrand,
};
const activeBrandId = (process.env.VITE_BRAND ?? '').trim() || 'default';
const activeBrand: BrandConfig = BRAND_REGISTRY[activeBrandId] ?? defaultBrand;
if (!BRAND_REGISTRY[activeBrandId]) {
  console.warn(`[vite.config] unknown VITE_BRAND="${activeBrandId}", using default`);
} else {
  console.log(`[vite.config] building for brand: ${activeBrand.id} (${activeBrand.name})`);
}

/** Replace %BRAND_*% placeholders in index.html so search crawlers, share
 * scrapers, and the first paint all see the tenant-correct title +
 * theme color, without waiting for JS to swap document.title. */
function htmlBrandSubstitution(): Plugin {
  return {
    name: 'html-brand-substitution',
    transformIndexHtml(html) {
      return html
        .replace(/%BRAND_TITLE%/g, activeBrand.pageTitle)
        .replace(/%BRAND_APPLE_TITLE%/g, activeBrand.shortName)
        .replace(/%BRAND_THEME_COLOR%/g, activeBrand.colors.primary);
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(BUILD_VERSION),
    __APP_COMMIT__: JSON.stringify(BUILD_COMMIT),
    __APP_BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    react(),
    htmlBrandSubstitution(),
    // @safe-global/protocol-kit pulls in Buffer + process — polyfill for browser.
    nodePolyfills({
      include: ['buffer', 'process', 'util', 'stream', 'events'],
      globals: { Buffer: true, process: true, global: true },
    }),
    VitePWA({
      // 'prompt' lets us show a snackbar when a new SW is waiting — autoUpdate
      // silently activates the new SW only on next full reload, which never
      // happens inside a standalone PWA (no browser refresh button). See
      // UpdateBanner.tsx for the user-facing flow.
      registerType: 'prompt',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: activeBrand.name,
        short_name: activeBrand.shortName,
        description: activeBrand.productSubtitle,
        theme_color: activeBrand.colors.primary,
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
        // Purge precaches from superseded SW revisions so a stale entry can't
        // linger and serve old/missing assets after a deploy.
        cleanupOutdatedCaches: true,
        navigateFallback: '/index.html',
        // The SPA navigateFallback must apply ONLY to navigations — never to
        // hashed assets or well-known files. Without this, a request for a
        // just-deployed/renamed asset that misses the cache falls back to
        // index.html (text/html) and the browser rejects it with a MIME error.
        // Keep the index.html fallback OFF assets/well-known and known static
        // file extensions only — NOT every dotted path (a route like /c/a.b must
        // still fall back to index.html offline).
        navigateFallbackDenylist: [
          /^\/assets\//,
          /^\/\.well-known\//,
          /\.(?:js|css|png|jpg|jpeg|svg|ico|json|map|txt|woff2?|webmanifest)$/i,
        ],
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
