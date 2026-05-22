import { useLocation } from 'wouter';
import { ArrowLeft, Settings, Sun, Moon, Laptop } from 'lucide-react';
import type { ReactNode } from 'react';
import { AddressChip, IconButton } from '../ui';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useWalletStore } from '../state/store';

const BACK_LABELS: Record<string, string> = {
  '/receive': 'Primi',
  '/send': 'Pošalji',
  '/settings/phone': 'Telefon',
};

type Props = {
  children: ReactNode;
};

export function AppShell({ children }: Props) {
  const [location] = useLocation();
  const safeAddress = useWalletStore((s) => s.safeAddress);
  const isHome = location === '/';

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-30 bg-surface-base/85 backdrop-blur border-b border-surface-border">
        <div className="mx-auto max-w-md flex items-center justify-between gap-2 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            {isHome ? (
              safeAddress ? (
                <AddressChip address={safeAddress} label="Tvoj wallet" />
              ) : (
                <BrandMark />
              )
            ) : (
              <BackButton currentPath={location} />
            )}
          </div>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <IconButton aria-label="Postavke" variant="ghost" size="md" disabled title="Postavke (Phase 6)">
              <Settings />
            </IconButton>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-md px-6 py-6">{children}</main>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="flex items-center gap-2 pl-1">
      <div className="flex h-1 w-8 overflow-hidden rounded-pill">
        <div className="flex-1 bg-brand-red-500" />
        <div className="flex-1 bg-surface-raised border-y border-surface-border" />
        <div className="flex-1 bg-brand-navy-700" />
      </div>
      <span className="font-bold tracking-tight text-ink-primary">DOMOVINA</span>
      <span className="text-[11px] uppercase tracking-widest text-ink-muted">Wallet</span>
    </div>
  );
}

function BackButton({ currentPath }: { currentPath: string }) {
  const [, setLocation] = useLocation();
  const label = BACK_LABELS[currentPath] ?? '';
  return (
    <button
      type="button"
      onClick={() => setLocation('/')}
      className="inline-flex items-center gap-1.5 rounded-pill px-2 py-1.5 text-sm font-medium text-ink-secondary hover:text-ink-primary hover:bg-surface-sunken transition"
    >
      <ArrowLeft className="h-4 w-4" />
      <span className="hidden sm:inline">Natrag</span>
      {label && <span className="text-ink-muted">· {label}</span>}
    </button>
  );
}

function ThemeToggle() {
  const { mode, cycle } = useTheme();
  const next: Record<ThemeMode, string> = {
    system: 'svjetlo',
    light: 'tama',
    dark: 'sustav',
  };
  return (
    <IconButton
      aria-label={`Tema: ${labelFor(mode)} — klik za ${next[mode]}`}
      title={`Tema: ${labelFor(mode)} (klik: ${next[mode]})`}
      variant="ghost"
      size="md"
      onClick={cycle}
    >
      {mode === 'system' && <Laptop />}
      {mode === 'light' && <Sun />}
      {mode === 'dark' && <Moon />}
    </IconButton>
  );
}

function labelFor(mode: ThemeMode): string {
  if (mode === 'system') return 'sustav';
  if (mode === 'light') return 'svjetlo';
  return 'tama';
}
