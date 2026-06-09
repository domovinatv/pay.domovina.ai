import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { Sparkles, X } from 'lucide-react';
import { Button, IconButton } from '../ui';
import { haptic } from '../lib/haptic';

// How often to poll for a new service worker. 60s is the sweet spot — short
// enough that a freshly-deployed fix reaches users within a minute, long
// enough not to spam the CF Pages edge with no-op revalidation requests.
const UPDATE_POLL_INTERVAL_MS = 60_000;

export function UpdateBanner() {
  // Hold the poll timer so we can clear it on unmount — otherwise StrictMode /
  // HMR re-registration leaves overlapping pollers hammering the CF Pages edge.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, registration) {
      // Poll the SW for updates on a fixed interval. The browser would only
      // re-check on full navigations otherwise, and in standalone PWA mode
      // those happen approximately never.
      if (registration) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = setInterval(() => {
          if (registration.installing) return; // an update is already installing
          if ('onLine' in navigator && !navigator.onLine) return;
          void registration.update();
        }, UPDATE_POLL_INTERVAL_MS);
      }
      void swUrl;
    },
    onRegisterError(error) {
      console.warn('[sw] registration failed', error);
    },
  });

  if (!needRefresh) return null;

  function applyUpdate() {
    haptic('tap');
    // updateServiceWorker(true) skips the waiting SW and reloads on
    // `controllerchange` (which unloads this page, cancelling the timer below).
    // BUT across rapid deploys the waiting worker can already be gone by the time
    // the user taps — then there's nothing to skip, controllerchange never fires,
    // and the tap appears to "do nothing". Force a reload as a fallback so the
    // user is never stuck on the banner.
    void updateServiceWorker(true);
    setTimeout(() => window.location.reload(), 2000);
  }

  function dismiss() {
    setNeedRefresh(false);
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed z-[70] left-0 right-0 bottom-0 px-4 pb-safe pointer-events-none
                 sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
    >
      <div
        className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-brand-navy-700/30
                   bg-brand-navy-700 text-white shadow-elevated p-3 sm:p-4 animate-slide-up
                   dark:bg-brand-navy-400 dark:text-brand-navy-900 dark:border-brand-navy-300/40"
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/15 dark:bg-brand-navy-900/15">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">Nova verzija je spremna</p>
          <p className="text-xs opacity-85 leading-tight">Ažuriraj da je primijeniš.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={applyUpdate}
          className="bg-white text-brand-navy-700 hover:bg-white/90 border-transparent
                     dark:bg-brand-navy-900 dark:text-white dark:hover:bg-brand-navy-900/90"
        >
          Ažuriraj
        </Button>
        <IconButton
          aria-label="Odgodi"
          size="sm"
          variant="ghost"
          onClick={dismiss}
          className="text-white/80 hover:text-white hover:bg-white/10
                     dark:text-brand-navy-900/80 dark:hover:text-brand-navy-900 dark:hover:bg-brand-navy-900/10"
        >
          <X />
        </IconButton>
      </div>
    </div>
  );
}
