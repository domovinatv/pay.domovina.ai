import { useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'theme';

function readStored(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  return 'system';
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

function applyResolved(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', resolved === 'dark');
  // Hint the UA chrome (status bar etc.) about color scheme so form
  // controls, scrollbars, native inputs match.
  root.style.colorScheme = resolved;
}

// Apply the stored preference synchronously at module load so that there is
// no flash of light theme before React mounts.
if (typeof window !== 'undefined') {
  applyResolved(resolveTheme(readStored()));
}

export function useTheme(): {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (next: ThemeMode) => void;
  cycle: () => void;
} {
  const [mode, setModeState] = useState<ThemeMode>(() => readStored());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStored()));

  // React to system pref changes while we are in 'system' mode.
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    function onChange() {
      if (mode === 'system') {
        const next = mql.matches ? 'dark' : 'light';
        setResolved(next);
        applyResolved(next);
      }
    }
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [mode]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    const r = resolveTheme(next);
    setResolved(r);
    applyResolved(r);
  }

  function cycle() {
    const order: ThemeMode[] = ['system', 'light', 'dark'];
    const idx = order.indexOf(mode);
    setMode(order[(idx + 1) % order.length]);
  }

  return { mode, resolved, setMode, cycle };
}
