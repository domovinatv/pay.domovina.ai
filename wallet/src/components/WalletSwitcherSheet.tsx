import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Plus, Archive, ArrowLeft, Layers } from 'lucide-react';
import { Sheet, Badge, EmptyState, Button, Input, useToast } from '../ui';
import {
  listAllAccounts,
  deriveAccount,
  canDeriveAccounts,
  ensureRecoveryOwner,
  setActiveAccountAddress,
  archiveDerivedAccount,
  ACCOUNT_NAME_SUGGESTIONS,
  type WalletAccount,
} from '../lib/accounts';
import { fetchEureBalances, formatEureShort } from '../lib/balances';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';
import { humanizeError } from '../lib/errors';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful switch (or new-account create) so the parent can
   * navigate, toast, etc. */
  onSwitched?: (account: WalletAccount) => void;
};

/**
 * ADR 0013 account picker. Lists every account (bootstrap + derived) across the
 * known identities on this device, lets the user switch between them, and mints
 * a new account under the active identity ("Novi račun") — a pure-local op (no
 * Face ID, no tx; the Safe deploys on first send).
 */
export function WalletSwitcherSheet({ open, onOpenChange, onSwitched }: Props) {
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<WalletAccount[]>([]);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const [mode, setMode] = useState<'list' | 'naming'>('list');
  const activeSafe = useWalletStore((s) => s.safeAddress);
  const activeCred = useWalletStore((s) => s.credentialId);
  const setAccount = useWalletStore((s) => s.setAccount);

  function reload() {
    const list = listAllAccounts();
    setAccounts(list);
    if (list.length === 0) {
      setBalances(new Map());
      return;
    }
    fetchEureBalances(list.map((a) => a.safeAddress))
      .then(setBalances)
      .catch((e) => console.warn('[WalletSwitcher] balance fetch failed', e));
  }

  useEffect(() => {
    if (!open) return;
    setMode('list');
    reload();
    // Resolve the identity's recovery owner on this device (backend, else on-chain
    // Safe owners) so "Novi račun" works cross-device — not just where the wallet
    // was created. reload() re-renders so canCreate flips on once it lands.
    if (activeCred) {
      void ensureRecoveryOwner(activeCred).then(() => reload());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Active pinned, then balance desc, then createdAt desc — same mental model
  // as Landing's WelcomeKnownView.
  const sorted = useMemo(() => {
    const list = [...accounts];
    const active = activeSafe?.toLowerCase();
    list.sort((a, b) => {
      if (a.safeAddress.toLowerCase() === active) return -1;
      if (b.safeAddress.toLowerCase() === active) return 1;
      const ba = balances.get(a.safeAddress.toLowerCase()) ?? 0n;
      const bb = balances.get(b.safeAddress.toLowerCase()) ?? 0n;
      if (ba !== bb) return bb > ba ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return list;
  }, [accounts, activeSafe, balances]);

  function pick(account: WalletAccount) {
    if (account.safeAddress.toLowerCase() === activeSafe?.toLowerCase()) {
      onOpenChange(false);
      return;
    }
    haptic('tap');
    setActiveAccountAddress(account.safeAddress);
    setAccount(account);
    onSwitched?.(account);
    onOpenChange(false);
  }

  function requestArchive(account: WalletAccount) {
    haptic('tap');
    archiveDerivedAccount(account.safeAddress);
    reload();
  }

  const canCreate = activeCred ? canDeriveAccounts(activeCred) : false;

  async function createAccount(name: string) {
    if (!activeCred) return;
    haptic('tap');
    try {
      const account = await deriveAccount(activeCred, name);
      reload();
      haptic('success');
      setActiveAccountAddress(account.safeAddress);
      setAccount(account);
      onSwitched?.(account);
      onOpenChange(false);
    } catch (e) {
      haptic('error');
      toast({ variant: 'error', title: 'Račun nije kreiran', description: humanizeError(e, 'generic') });
    }
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={mode === 'naming' ? 'Novi račun' : 'Računi'}
      description={
        mode === 'naming'
          ? 'Daj računu ime — vidiš ga samo ti, u aplikaciji.'
          : 'Svi tvoji računi pod istim passkeyem.'
      }
    >
      {mode === 'naming' ? (
        <NamingStep
          onBack={() => setMode('list')}
          onCreate={createAccount}
        />
      ) : accounts.length === 0 ? (
        <EmptyState
          title="Nema računa"
          description="Kreiraj wallet iz početnog ekrana."
        />
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {sorted.map((account) => (
              <li key={account.safeAddress}>
                <AccountRow
                  account={account}
                  balance={balances.get(account.safeAddress.toLowerCase())}
                  active={account.safeAddress.toLowerCase() === activeSafe?.toLowerCase()}
                  onClick={() => pick(account)}
                  onArchive={
                    account.kind === 'derived' ? () => requestArchive(account) : undefined
                  }
                />
              </li>
            ))}
          </ul>

          {canCreate ? (
            <Button variant="secondary" size="md" block onClick={() => setMode('naming')}>
              <Plus className="h-4 w-4" />
              Novi račun
            </Button>
          ) : (
            <p className="text-xs text-ink-muted text-center px-2">
              Recovery ključ se sinkronizira na ovaj uređaj… „Novi račun" se pojavi čim
              se učita. Ako ne, otvori wallet na uređaju gdje je kreiran. (Ne radi
              „Kreiraj novi wallet" — to bi napravilo novi passkey.)
            </p>
          )}
        </div>
      )}
    </Sheet>
  );
}

function NamingStep({
  onBack,
  onCreate,
}: {
  onBack: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    await onCreate(trimmed);
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {ACCOUNT_NAME_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => submit(s)}
            className="rounded-pill border border-surface-border bg-surface-raised px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-sunken active:scale-95 transition disabled:opacity-50"
          >
            {s}
          </button>
        ))}
      </div>

      <Input
        type="text"
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ili upiši svoje ime…"
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit(name);
        }}
      />

      <div className="flex flex-col gap-2">
        <Button size="lg" block disabled={!name.trim() || busy} onClick={() => submit(name)}>
          <Layers className="h-4 w-4" />
          {busy ? 'Kreiram…' : 'Kreiraj račun'}
        </Button>
        <Button variant="ghost" size="sm" block disabled={busy} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          Natrag
        </Button>
      </div>

      <p className="text-[11px] text-ink-muted leading-snug px-1">
        Novi račun je nova adresa pod istim passkeyem i istim recovery ključem.
        Ne troši gas dok ne pošalješ prvi put.
      </p>
    </div>
  );
}

function AccountRow({
  account,
  balance,
  active,
  onClick,
  onArchive,
}: {
  account: WalletAccount;
  balance: bigint | undefined;
  active: boolean;
  onClick: () => void;
  onArchive?: () => void;
}) {
  return (
    <div
      className={
        'group relative rounded-2xl border transition ' +
        (active
          ? 'bg-brand-navy-50 border-brand-navy-200 dark:bg-brand-navy-900/30 dark:border-brand-navy-700'
          : 'bg-surface-raised border-surface-border hover:bg-surface-sunken')
      }
    >
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left flex items-center gap-3 p-3 active:scale-[0.99] transition"
      >
        <div
          aria-hidden
          className="h-12 w-12 rounded-2xl shrink-0 ring-1 ring-black/5"
          style={{ background: gradientFor(account.safeAddress) }}
        />
        <div className="flex flex-col leading-tight min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs uppercase tracking-widest text-ink-muted truncate">
              {account.name}
            </span>
            {active && (
              <Badge tone="info" className="text-[10px]">
                <Check className="h-2.5 w-2.5" /> aktivan
              </Badge>
            )}
          </div>
          <span className="font-mono text-sm text-ink-primary truncate">
            {shorten(account.safeAddress)}
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
            <span className="text-[11px] text-ink-muted">· {formatDate(account.createdAt)}</span>
          </div>
        </div>
        {!active && !onArchive && <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />}
      </button>
      {onArchive && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive();
          }}
          aria-label="Sakrij račun s liste"
          className="absolute top-1.5 right-1.5 h-8 w-8 inline-flex items-center justify-center rounded-full text-ink-muted hover:text-ink-primary hover:bg-surface-sunken/80 active:scale-95 transition"
        >
          <Archive className="h-4 w-4" />
        </button>
      )}
    </div>
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
