/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Build-time identifiers injected by vite.config.ts so the deployed PWA can
// show users which build is loaded. Helps confirm whether a hard refresh
// picked up the latest deploy.
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD_TIME__: string;
