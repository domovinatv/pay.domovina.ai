import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { Sheet, Badge, EmptyState } from '../ui';
import { listKnownPasskeys, setActivePasskey, type PasskeyRecord } from '../lib/passkey';
import { fetchEureBalances, formatEureShort } from '../lib/balances';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful switch so the parent can navigate, toast, etc. */
  onSwitched?: (record: PasskeyRecord) => void;
};

export function WalletSwitcherSheet({ open, onOpenChange, onSwitched }: Props) {
  const [known, setKnown] = useState<PasskeyRecord[]>([]);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const activeCred = useWalletStore((s) => s.credentialId);
  const setIdentity = useWalletStore((s) => s.setIdentity);

  useEffect(() => {
    if (!open) return;
    const list = listKnownPasskeys();
    setKnown(list);
    if (list.length === 0) {
      setBalances(new Map());
      return;
    }
    let cancelled = false;
    fetchEureBalances(list.map((r) => r.safeAddress))
      .then((m) => {
        if (!cancelled) setBalances(m);
      })
      .catch((e) => {
        console.warn('[WalletSwitcher] balance fetch failed', e);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Same ordering as Landing's WelcomeKnownView so users build one mental
  // model: active pinned, then balance desc, then createdAt desc.
  const sorted = useMemo(() => {
    const list = [...known];
    list.sort((a, b) => {
      if (a.credentialId === activeCred) return -1;
      if (b.credentialId === activeCred) return 1;
      const ba = balances.get(a.safeAddress.toLowerCase()) ?? 0n;
      const bb = balances.get(b.safeAddress.toLowerCase()) ?? 0n;
      if (ba !== bb) return bb > ba ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return list;
  }, [known, activeCred, balances]);

  function pick(record: PasskeyRecord) {
    if (record.credentialId === activeCred) {
      onOpenChange(false);
      return;
    }
    haptic('tap');
    setActivePasskey(record.credentialId);
    setIdentity({
      credentialId: record.credentialId,
      signerAddress: record.signerAddress,
      safeAddress: record.safeAddress,
    });
    onSwitched?.(record);
    onOpenChange(false);
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Promijeni wallet"
      description="Sve poznate passkey-jeve s ovog uređaja."
    >
      {known.length === 0 ? (
        <EmptyState
          title="Nema drugih walleta"
          description="Kreiraj još jedan iz Landing ekrana (Odjavi se s ovog uređaja → Kreiraj novi)."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {sorted.map((record) => (
            <li key={record.credentialId}>
              <WalletRow
                record={record}
                balance={balances.get(record.safeAddress.toLowerCase())}
                active={record.credentialId === activeCred}
                onClick={() => pick(record)}
              />
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

function WalletRow({
  record,
  balance,
  active,
  onClick,
}: {
  record: PasskeyRecord;
  balance: bigint | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'w-full text-left flex items-center gap-3 rounded-2xl border p-3 transition active:scale-[0.99] ' +
        (active
          ? 'bg-brand-navy-50 border-brand-navy-200 dark:bg-brand-navy-900/30 dark:border-brand-navy-700'
          : 'bg-surface-raised border-surface-border hover:bg-surface-sunken')
      }
    >
      <div
        aria-hidden
        className="h-12 w-12 rounded-2xl shrink-0 ring-1 ring-black/5"
        style={{ background: gradientFor(record.safeAddress) }}
      />
      <div className="flex flex-col leading-tight min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-widest text-ink-muted truncate">
            {record.keychainName ?? (record.nameSuffix ? `wa_${record.nameSuffix}` : 'Safe')}
          </span>
          {active && (
            <Badge tone="info" className="text-[10px]">
              <Check className="h-2.5 w-2.5" /> aktivan
            </Badge>
          )}
        </div>
        <span className="font-mono text-sm text-ink-primary truncate">
          {shorten(record.safeAddress)}
        </span>
        <div className="flex items-baseline gap-2">
          <span
            className={
              'text-sm tabular-nums ' +
              (balance === undefined || balance === 0n
                ? 'text-ink-muted'
                : 'text-ink-primary font-medium')
            }
          >
            {balance === undefined ? '…' : `${formatEureShort(balance)} EURe`}
          </span>
          <span className="text-[11px] text-ink-muted">· {formatDate(record.createdAt)}</span>
        </div>
      </div>
      {!active && <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />}
    </button>
  );
}

function shorten(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function gradientFor(addr: string): string {
  const seed = addr.toLowerCase();
  const h1 = parseInt(seed.slice(2, 6) || '0', 16) % 360;
  const h2 = (h1 + 60 + (parseInt(seed.slice(6, 8) || '0', 16) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}
