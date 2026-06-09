/**
 * Client-side Cloudflare Turnstile token minting for the gas-sponsoring endpoints.
 *
 * GATED ON `VITE_TURNSTILE_SITE_KEY` (a build-time var): when unset, getTurnstileToken
 * resolves to `undefined` and the relay/bootstrap bodies simply omit the token — the
 * server, with no TURNSTILE_SECRET, ignores it. So the whole feature is a no-op until
 * both halves are provisioned, and there is zero UX change in the meantime.
 *
 * When the site key IS set we run an INVISIBLE widget: load the Turnstile script once,
 * render a hidden container, execute it, and resolve with the resulting token. The
 * token is single-use and short-lived, so we mint a fresh one per request (called from
 * relayTx / submitBootstrapDeploy, not cached).
 */

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() || undefined;
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const EXECUTE_TIMEOUT_MS = 8000;

type TurnstileApi = {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      size?: 'invisible' | 'normal' | 'compact' | 'flexible';
      callback?: (token: string) => void;
      'error-callback'?: () => void;
      'timeout-callback'?: () => void;
    },
  ) => string;
  execute: (el: HTMLElement | string) => void;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.turnstile) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null; // allow a later retry
        reject(new Error('Turnstile script failed to load'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/** Whether Turnstile is configured for this build. UI can use this to decide whether
 * to surface a "protected by Turnstile" note. */
export function isTurnstileEnabled(): boolean {
  return !!SITE_KEY;
}

/**
 * Resolve a fresh Turnstile token, or `undefined` if Turnstile isn't configured or
 * couldn't produce one (never throws — a failure here must not block the send flow
 * when the server isn't enforcing it; when the server IS enforcing, it returns a 403
 * with a clear message instead).
 */
export async function getTurnstileToken(): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  try {
    await loadScript();
    const ts = window.turnstile;
    if (!ts) return undefined;

    return await new Promise<string | undefined>((resolve) => {
      const container = document.createElement('div');
      container.style.display = 'none';
      document.body.appendChild(container);

      let settled = false;
      let widgetId: string | undefined;
      const finish = (token: string | undefined) => {
        if (settled) return;
        settled = true;
        try {
          if (widgetId) ts.remove(widgetId);
        } catch {
          /* ignore */
        }
        container.remove();
        resolve(token);
      };

      try {
        widgetId = ts.render(container, {
          sitekey: SITE_KEY,
          size: 'invisible',
          callback: (token) => finish(token),
          'error-callback': () => finish(undefined),
          'timeout-callback': () => finish(undefined),
        });
        ts.execute(container);
      } catch {
        finish(undefined);
      }
      // Hard ceiling so a stuck challenge never hangs the caller.
      setTimeout(() => finish(undefined), EXECUTE_TIMEOUT_MS);
    });
  } catch {
    return undefined;
  }
}
