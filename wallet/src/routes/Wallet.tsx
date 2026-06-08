import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { ArrowDownToLine, ArrowUpFromLine, Phone, ShieldCheck, Layers, ChevronDown } from 'lucide-react';
import { Badge, BalanceDisplay, Button, Card, Section } from '../ui';
import { ActivityFeed } from '../components/ActivityFeed';
import { WalletSwitcherSheet } from '../components/WalletSwitcherSheet';
import { useWalletStore } from '../state/store';
import { getEureBalance } from '../lib/balance';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { getActivePasskey, recordRpId } from '../lib/passkey';

type PhoneVerification = {
  phone_hash_short: string;
  first_bound_at: string;
  latest_verified_at: string;
  verification_count: number;
};

export function Wallet() {
  const [, setLocation] = useLocation();
  const { safeAddress, credentialId, balance, setBalance, accountName } = useWalletStore();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [phones, setPhones] = useState<PhoneVerification[]>([]);
  const [totalVerifications, setTotalVerifications] = useState<number>(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activityKey, setActivityKey] = useState(0);

  useEffect(() => {
    if (!safeAddress) return;
    let cancelled = false;
    let tickCount = 0;
    // The previous numeric balance from the LAST successful tick. We use it
    // to detect "money moved" and bump the activity feed immediately —
    // otherwise activity could lag by up to 20s behind a balance change.
    let lastNumeric: number | null = null;
    async function tick() {
      try {
        setRefreshing(true);
        const { formatted } = await getEureBalance(safeAddress!);
        if (cancelled) return;

        const nextNumeric = Number(formatted);
        const balanceChanged =
          lastNumeric !== null && Math.abs(nextNumeric - lastNumeric) > 0.0001;
        lastNumeric = nextNumeric;

        setBalance(formatted);
        setLastSync(Date.now());

        // Sync: if money arrived or left, refetch activity in the same
        // moment — the user sees the new row appear together with the
        // animated balance change instead of 20-30s later on the cadence.
        if (balanceChanged) {
          setActivityKey((k) => k + 1);
        }
      } catch {
        /* ignore — likely not yet deployed */
      } finally {
        if (!cancelled) setRefreshing(false);
      }
      // Slow periodic refresh as a safety net even when balance does not
      // change (e.g. failed tx — gas was paid but value moved 0).
      tickCount += 1;
      if (tickCount > 0 && tickCount % 6 === 0 && !cancelled) {
        setActivityKey((k) => k + 1);
      }
    }
    tick();
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [safeAddress, setBalance]);

  useEffect(() => {
    if (!credentialId) return;
    let cancelled = false;
    (async () => {
      let view = await lookupWallet(credentialId);
      if (!view) {
        // Backward compat: pre-Phase 3 wallets aren't in the registry.
        // Auto-register so bind-phone + other registry-gated features work.
        const passkey = getActivePasskey();
        const x = passkey?.pubKey?.x;
        const y = passkey?.pubKey?.y;
        if (passkey && x && y && x !== '0' && y !== '0') {
          view = await registerWalletWithBackend({
            credentialId: passkey.credentialId,
            pubKeyX: x,
            pubKeyY: y,
            signerAddress: passkey.signerAddress,
            safeAddress: passkey.safeAddress,
            rpId: recordRpId(passkey),
          });
        }
      }
      if (!cancelled) {
        setPhones(view?.phones ?? []);
        setTotalVerifications(view?.verification?.count ?? 0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [credentialId]);

  if (!safeAddress) return null;

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={() => setSwitcherOpen(true)}
        className="self-start inline-flex items-center gap-1.5 rounded-pill border border-surface-border bg-surface-raised px-3 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-sunken active:scale-95 transition"
      >
        <Layers className="h-4 w-4 text-brand-navy-500" />
        <span className="max-w-[60vw] truncate">{accountName || 'Račun'}</span>
        <ChevronDown className="h-4 w-4 text-ink-muted" />
      </button>

      <Card padding="lg" elevation="elevated" className="flex flex-col gap-6">
        <BalanceDisplay
          amount={balance === null ? null : Number(balance)}
          currency="EURe"
          lastUpdatedAgo={lastSync ? agoLabel(lastSync) : null}
          refreshing={refreshing}
        />
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => setLocation('/receive')} size="lg" block>
            <ArrowDownToLine className="h-5 w-5" />
            Primi
          </Button>
          <Button
            onClick={() => setLocation('/send')}
            variant="secondary"
            size="lg"
            block
          >
            <ArrowUpFromLine className="h-5 w-5" />
            Pošalji
          </Button>
        </div>
      </Card>

      <Section title="Aktivnost">
        <ActivityFeed safeAddress={safeAddress} refetchKey={activityKey} />
      </Section>

      {phones.length > 0 ? (
        <Section
          title="Verificirani telefoni"
          description={`${phones.length} ${phones.length === 1 ? 'broj' : 'broja'} · ${totalVerifications}× ukupno`}
        >
          <Card padding="sm" className="flex flex-col divide-y divide-surface-border">
            {phones.map((p) => (
              <div
                key={p.phone_hash_short}
                className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-ink-muted">
                    <ShieldCheck className="h-4 w-4" />
                  </div>
                  <div className="flex flex-col leading-tight min-w-0">
                    <span className="font-mono text-xs text-ink-secondary truncate">
                      {p.phone_hash_short}
                    </span>
                    <span className="text-[11px] text-ink-muted">
                      {formatDate(p.first_bound_at)}
                      {p.latest_verified_at !== p.first_bound_at && (
                        <> → {formatDate(p.latest_verified_at)}</>
                      )}
                    </span>
                  </div>
                </div>
                <Badge tone="info">{p.verification_count}×</Badge>
              </div>
            ))}
          </Card>
          <Button
            onClick={() => setLocation('/settings/phone')}
            variant="ghost"
            size="sm"
            block
          >
            <Phone className="h-4 w-4" />
            Verificiraj telefon (isti ili novi)
          </Button>
        </Section>
      ) : (
        <Section title="Sigurnost">
          <Card padding="md" className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              <Phone className="h-5 w-5" />
            </div>
            <div className="flex-1 flex flex-col gap-2">
              <div>
                <p className="font-medium text-ink-primary">Poveži telefon</p>
                <p className="text-sm text-ink-secondary">
                  Recovery + sybil-resistant identitet.
                </p>
              </div>
              <Button
                onClick={() => setLocation('/settings/phone')}
                variant="secondary"
                size="sm"
              >
                Pokreni verifikaciju
              </Button>
            </div>
          </Card>
        </Section>
      )}

      <p className="text-center text-xs text-ink-muted pt-2">
        Gnosis Chain · Safe smart account
      </p>

      <WalletSwitcherSheet open={switcherOpen} onOpenChange={setSwitcherOpen} />
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

function agoLabel(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'ažurirano sad';
  if (s < 60) return `prije ${s} s`;
  const m = Math.floor(s / 60);
  return `prije ${m} min`;
}
