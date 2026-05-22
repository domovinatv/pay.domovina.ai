import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Phone, ShieldCheck } from 'lucide-react';
import { BrandHeader } from '../components/Brand';
import {
  AddressChip,
  BalanceDisplay,
  Badge,
  Button,
  Card,
  Section,
} from '../ui';
import { useWalletStore } from '../state/store';
import { getEureBalance } from '../lib/balance';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { getActivePasskey } from '../lib/passkey';
import { RP_ID } from '../lib/constants';

type PhoneVerification = {
  phone_hash_short: string;
  first_bound_at: string;
  latest_verified_at: string;
  verification_count: number;
};

export function Wallet() {
  const { safeAddress, credentialId, balance, setBalance, setScreen } = useWalletStore();
  const [phones, setPhones] = useState<PhoneVerification[]>([]);
  const [totalVerifications, setTotalVerifications] = useState<number>(0);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!safeAddress) return;
    let cancelled = false;
    async function tick() {
      try {
        setRefreshing(true);
        const { formatted } = await getEureBalance(safeAddress!);
        if (!cancelled) {
          setBalance(formatted);
          setLastSync(Date.now());
        }
      } catch {
        /* ignore — likely not yet deployed */
      } finally {
        if (!cancelled) setRefreshing(false);
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
            rpId: RP_ID,
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
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto">
      <BrandHeader />

      <main className="flex-1 flex flex-col gap-6">
        {/* Identity strip */}
        <div className="flex items-center justify-center">
          <AddressChip address={safeAddress} label="Tvoja Safe adresa" />
        </div>

        {/* Hero balance */}
        <Card padding="lg" elevation="elevated" className="flex flex-col gap-6">
          <BalanceDisplay
            amount={balance === null ? null : formatBalance(balance)}
            currency="EURe"
            lastUpdatedAgo={lastSync ? agoLabel(lastSync) : null}
            refreshing={refreshing}
          />
          <div className="grid grid-cols-2 gap-3">
            <Button onClick={() => setScreen('receive')} size="lg" block>
              <ArrowDownToLine className="h-5 w-5" />
              Primi
            </Button>
            <Button
              onClick={() => setScreen('send')}
              variant="secondary"
              size="lg"
              block
            >
              <ArrowUpFromLine className="h-5 w-5" />
              Pošalji
            </Button>
          </div>
        </Card>

        {/* Phone verifications */}
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
              onClick={() => setScreen('bind-phone')}
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
                  onClick={() => setScreen('bind-phone')}
                  variant="secondary"
                  size="sm"
                >
                  Pokreni verifikaciju
                </Button>
              </div>
            </Card>
          </Section>
        )}
      </main>

      <footer className="py-6 text-center text-xs text-ink-muted">
        Gnosis Chain · Safe smart account
      </footer>
    </div>
  );
}

function formatBalance(raw: string): string {
  const n = Number(raw);
  if (!isFinite(n)) return raw;
  return n.toLocaleString('hr-HR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
