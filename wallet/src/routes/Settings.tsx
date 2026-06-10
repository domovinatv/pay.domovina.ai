import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import {
  ExternalLink,
  Phone,
  ShieldCheck,
  ChevronRight,
  Laptop,
  Sun,
  Moon,
  LogOut,
  Code2,
  Copy,
  Check,
  Wallet as WalletIcon,
  Globe2,
  KeyRound,
  Fingerprint,
  Rocket,
} from 'lucide-react';
import { Badge, Button, Card, IconButton, Section, SegmentedControl, useToast } from '../ui';
import { WalletSwitcherSheet } from '../components/WalletSwitcherSheet';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useWalletStore } from '../state/store';
import { lookupWallet } from '../lib/registry';
import { getActivePasskey } from '../lib/passkey';
import { listAllAccounts } from '../lib/accounts';
import { isSafeDeployed, readSafeThreshold } from '../lib/safe';
import { activateAccount } from '../lib/activate';
import { humanizeError } from '../lib/errors';

const REPO_URL = 'https://github.com/domovinatv/pay.domovina.ai';
// The dApp lives in the repo's wallet/ folder — link straight to it.
const SOURCE_URL = `${REPO_URL}/tree/main/wallet`;

type PhoneSummary = {
  count: number;
  totalVerifications: number;
};

export function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { mode, setMode } = useTheme();
  const { safeAddress, signerAddress, credentialId, reset, accountKind, saltNonce, recoveryOwner } =
    useWalletStore();
  const [phoneSummary, setPhoneSummary] = useState<PhoneSummary | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [accountCount, setAccountCount] = useState(0);
  const [passkeyLabel, setPasskeyLabel] = useState<string | undefined>();
  const [deployed, setDeployed] = useState<boolean | null>(null);
  const [threshold, setThreshold] = useState<bigint | null>(null);
  const [activating, setActivating] = useState(false);

  // On-chain status of the ACTIVE account: deployed? what threshold? Drives the
  // "Aktiviraj račun" card (counterfactual derived Safes are invisible to
  // app.safe.global until deployed) and the threshold-raised warning.
  useEffect(() => {
    if (!safeAddress) return;
    let cancelled = false;
    setDeployed(null);
    setThreshold(null);
    (async () => {
      const dep = await isSafeDeployed(safeAddress);
      if (cancelled) return;
      setDeployed(dep);
      if (dep) {
        const t = await readSafeThreshold(safeAddress);
        if (!cancelled) setThreshold(t);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [safeAddress]);

  async function activate() {
    const passkey = getActivePasskey();
    if (!safeAddress || !signerAddress || !passkey || !saltNonce || !recoveryOwner) return;
    setActivating(true);
    try {
      const result = await activateAccount({
        safeAddress,
        signerAddress,
        saltNonce,
        recoveryOwner,
        passkey,
      });
      setDeployed(true);
      toast({
        variant: 'success',
        title: 'Račun je aktiviran on-chain ✓',
        description:
          result.status === 'activated'
            ? 'Za koju minutu vidljiv je i u app.safe.global / Safe Mobile.'
            : 'Već je bio deployan.',
      });
    } catch (e) {
      toast({ variant: 'error', title: 'Aktivacija neuspješna', description: humanizeError(e, 'passkey') });
    } finally {
      setActivating(false);
    }
  }

  // The 12-word seed's EOA — the portable 1-of-2 owner. For a derived account the
  // snapshot is in the store; for the bootstrap it lives on the passkey record.
  const seedOwnerAddress = recoveryOwner ?? getActivePasskey()?.recoveryOwner ?? null;

  useEffect(() => {
    setAccountCount(listAllAccounts().length);
    const active = getActivePasskey();
    if (active?.keychainName) setPasskeyLabel(active.keychainName);
    else if (active?.nameSuffix) setPasskeyLabel(`DOMOVINA wa_${active.nameSuffix}`);
    else setPasskeyLabel(undefined);
  }, [credentialId]);

  useEffect(() => {
    if (!credentialId) return;
    let cancelled = false;
    (async () => {
      const view = await lookupWallet(credentialId);
      if (!cancelled) {
        setPhoneSummary({
          count: view?.phones?.length ?? 0,
          totalVerifications: view?.verification?.count ?? 0,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [credentialId]);

  function signOut() {
    reset();
    setLocation('/');
  }

  if (!safeAddress) return null;

  return (
    <div className="flex flex-col gap-8">
      <Section title="Računi">
        <button
          type="button"
          onClick={() => setSwitcherOpen(true)}
          className="text-left rounded-3xl bg-surface-raised border border-surface-border shadow-card p-5 hover:bg-surface-sunken transition flex items-center gap-3"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
            <WalletIcon className="h-5 w-5" />
          </div>
          <div className="flex-1 flex flex-col leading-tight">
            <span className="font-medium text-ink-primary">
              {accountCount > 1 ? 'Promijeni račun' : 'Računi'}
            </span>
            <span className="text-sm text-ink-secondary">
              {accountCount > 1
                ? `${accountCount} računa · dodaj novi pod istim passkeyem`
                : 'Otvori ili dodaj račun pod istim passkeyem'}
            </span>
          </div>
          <ChevronRight className="h-4 w-4 text-ink-muted" />
        </button>
      </Section>

      <Section title="Račun">
        <Card padding="md" className="flex flex-col divide-y divide-surface-border">
          <CopyableAddressRow
            label="Safe adresa"
            address={safeAddress}
            onCopied={(t) => toast({ variant: 'success', title: t })}
          />
          {signerAddress && (
            <CopyableAddressRow
              label="Signer (passkey)"
              address={signerAddress}
              onCopied={(t) => toast({ variant: 'success', title: t })}
            />
          )}
          {passkeyLabel && (
            <div className="flex items-start justify-between gap-3 py-3 first:pt-1 last:pb-1">
              <div className="flex flex-col leading-tight min-w-0 flex-1">
                <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                  Passkey ime
                </span>
                <span className="font-mono text-sm text-ink-primary break-all">
                  {passkeyLabel}
                </span>
                <span className="text-[11px] text-ink-muted leading-snug">
                  Pod ovim imenom passkey postoji u Apple Passwords / iCloud Keychain / Google Password Manageru.
                </span>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">Mreža</span>
              <span className="text-sm font-medium text-ink-primary">Gnosis Chain</span>
            </div>
            <Badge tone="info">EVM · Chain ID 100</Badge>
          </div>
          <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
            <div className="flex flex-col leading-tight">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                Status na lancu
              </span>
              <span className="text-sm font-medium text-ink-primary">
                {deployed === null
                  ? 'provjeravam…'
                  : deployed
                    ? 'Aktivan (deployan)'
                    : 'Još nije aktiviran'}
              </span>
              {deployed === false && (
                <span className="text-[11px] text-ink-muted leading-snug">
                  Adresa je rezervirana (CREATE2), Safe se deploya kod prve transakcije.
                </span>
              )}
            </div>
            {deployed !== null &&
              (deployed ? (
                threshold !== null && threshold > 1n ? (
                  <Badge tone="warning">prag {threshold.toString()} potpisa</Badge>
                ) : (
                  <Badge tone="success">on-chain</Badge>
                )
              ) : (
                <Badge tone="warning">counterfactual</Badge>
              ))}
          </div>
        </Card>
      </Section>

      {deployed === false && accountKind === 'derived' && saltNonce && recoveryOwner && (
        <Section title="Vidljivost u drugim Safe aplikacijama">
          <Card padding="md" className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              <Rocket className="h-5 w-5" />
            </div>
            <div className="flex-1 flex flex-col gap-3">
              <div>
                <p className="font-medium text-ink-primary">Aktiviraj račun on-chain</p>
                <p className="text-sm text-ink-secondary leading-snug">
                  app.safe.global i Safe Mobile vide ovaj račun tek kad je deployan. Inače se
                  deploya sam kod prvog slanja — aktivacija ga objavi odmah, bez prijenosa
                  sredstava. Troši 1 od 5 dnevnih besplatnih transakcija.
                </p>
              </div>
              <Button onClick={activate} disabled={activating} variant="secondary" size="md">
                <Fingerprint className="h-4 w-4" />
                {activating ? 'Aktiviram…' : 'Aktiviraj s Face ID'}
              </Button>
            </div>
          </Card>
        </Section>
      )}

      {threshold !== null && threshold > 1n && (
        <Section title="Upozorenje">
          <Card padding="md" className="flex flex-col gap-2 border-brand-red-500/40">
            <p className="text-sm font-medium text-ink-primary">
              Prag potpisa je {threshold.toString()} — slanje iz aplikacije je blokirano
            </p>
            <p className="text-sm text-ink-secondary leading-snug">
              Netko je (npr. kroz app.safe.global) podigao broj potrebnih potpisa iznad 1.
              Passkey daje jedan potpis, pa transakcije odavde više ne prolaze. Šalji kroz{' '}
              <a
                href={`https://app.safe.global/home?safe=gno:${safeAddress}`}
                target="_blank"
                rel="noreferrer"
                className="underline text-brand-navy-500"
              >
                app.safe.global
              </a>{' '}
              ili tamo vrati prag na 1.
            </p>
          </Card>
        </Section>
      )}

      <Section title="Sigurnost">
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setLocation('/settings/phone')}
            className="text-left rounded-3xl bg-surface-raised border border-surface-border shadow-card p-5 hover:bg-surface-sunken transition flex items-center gap-3"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              {phoneSummary && phoneSummary.count > 0 ? (
                <ShieldCheck className="h-5 w-5 text-emerald-500" />
              ) : (
                <Phone className="h-5 w-5" />
              )}
            </div>
            <div className="flex-1 flex flex-col leading-tight">
              <span className="font-medium text-ink-primary">Potvrda broja mobitela</span>
              <span className="text-sm text-ink-secondary">
                {phoneSummary === null
                  ? 'učitavam…'
                  : phoneSummary.count === 0
                    ? 'Nije potvrđeno · dokaži da si stvarna osoba'
                    : `${phoneSummary.count} ${phoneSummary.count === 1 ? 'broj potvrđen' : 'broja potvrđena'} · ${phoneSummary.totalVerifications}× verificirano`}
              </span>
            </div>
            <ChevronRight className="h-4 w-4 text-ink-muted" />
          </button>

          <button
            type="button"
            onClick={() => setLocation('/settings/expand-access')}
            className="text-left rounded-3xl bg-surface-raised border border-surface-border shadow-card p-5 hover:bg-surface-sunken transition flex items-center gap-3"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              <Globe2 className="h-5 w-5" />
            </div>
            <div className="flex-1 flex flex-col leading-tight">
              <span className="font-medium text-ink-primary">Dodaj passkey</span>
              <span className="text-sm text-ink-secondary">
                Rezervni passkey iz Apple Passwords ili Google Password Managera — postaje
                co-owner trenutno otvorenog računa (threshold 1).
              </span>
            </div>
            <ChevronRight className="h-4 w-4 text-ink-muted" />
          </button>

          <Card padding="md" className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              <KeyRound className="h-5 w-5" />
            </div>
            <div className="flex-1 flex flex-col gap-1.5 leading-tight min-w-0">
              <span className="font-medium text-ink-primary">Recovery seed (12 riječi)</span>
              <p className="text-sm text-ink-secondary leading-snug">
                Tvoj seed kontrolira ovaj Safe u <span className="font-semibold">bilo kojem
                walletu</span> — uvezi ga u Safe Mobile (iOS/Android), MetaMask ili
                app.safe.global i raspolažeš istim računima bez ove aplikacije. Prikazan je{' '}
                <span className="font-semibold">samo jednom</span>, pri kreiranju, i nigdje
                nije spremljen — ne možemo ga ponovno prikazati.
              </p>
              {seedOwnerAddress && (
                <p className="text-[11px] text-ink-muted leading-snug break-all">
                  Adresa seed vlasnika:{' '}
                  <a
                    href={`https://gnosisscan.io/address/${seedOwnerAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono underline"
                  >
                    {seedOwnerAddress}
                  </a>
                </p>
              )}
              <p className="text-[11px] text-ink-muted leading-snug">
                Nisi zapisao seed? Wallet i dalje radi preko passkeya — dodaj rezervni passkey
                gore kao drugi put oporavka.
              </p>
            </div>
          </Card>
        </div>
      </Section>

      <Section title="Izgled" description="Pamti se na ovom uređaju.">
        <SegmentedControl<ThemeMode>
          ariaLabel="Tema"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'system', label: 'Sustav', icon: <Laptop /> },
            { value: 'light', label: 'Svjetlo', icon: <Sun /> },
            { value: 'dark', label: 'Tama', icon: <Moon /> },
          ]}
        />
      </Section>

      <Section title="O aplikaciji">
        <Card padding="md" className="flex flex-col divide-y divide-surface-border">
          <BuildInfoRow />
          <a
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 py-3 first:pt-1 last:pb-1 hover:bg-surface-sunken -mx-1 px-1 rounded-lg transition"
          >
            <Code2 className="h-4 w-4 text-ink-muted shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-ink-primary">Izvorni kod</p>
              <p className="text-[11px] text-ink-muted truncate">
                github.com/domovinatv/pay.domovina.ai · wallet/
              </p>
            </div>
            <ExternalLink className="h-3.5 w-3.5 text-ink-muted shrink-0" />
          </a>
        </Card>
      </Section>

      <Section title="Opasna zona">
        <Card padding="md" className="flex flex-col gap-3 border-brand-red-500/30">
          <p className="text-sm text-ink-secondary">
            Odjava briše referencu na wallet samo s ovog uređaja. Passkey ostaje u tvojem
            password manageru — možeš se vratiti otvaranjem postojećeg passkeyja.
          </p>
          <Button variant="danger" size="md" onClick={signOut} block>
            <LogOut className="h-4 w-4" />
            Odjavi se s ovog uređaja
          </Button>
        </Card>
      </Section>

      <WalletSwitcherSheet
        open={switcherOpen}
        onOpenChange={setSwitcherOpen}
        onSwitched={(account) => {
          toast({
            variant: 'success',
            title: `Otvoren račun · ${account.name}`,
            description: `${account.safeAddress.slice(0, 6)}…${account.safeAddress.slice(-4)}`,
          });
          setLocation('/');
        }}
      />
    </div>
  );
}

type CopyRowProps = {
  label: string;
  address: string;
  onCopied: (title: string) => void;
};

function CopyableAddressRow({ label, address, onCopied }: CopyRowProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      onCopied(`${label} kopirano`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* silent */
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <div className="flex flex-col leading-tight min-w-0 flex-1">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">{label}</span>
        <span className="font-mono text-sm text-ink-primary truncate">{address}</span>
      </div>
      <div className="flex gap-1 shrink-0">
        <IconButton aria-label={`Kopiraj ${label}`} size="sm" variant="ghost" onClick={copy}>
          {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </IconButton>
        <a
          href={`https://gnosisscan.io/address/${address}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`Otvori ${label} na Gnosisscan`}
          className="inline-flex items-center justify-center h-8 w-8 rounded-xl text-ink-secondary hover:bg-surface-sunken hover:text-ink-primary transition"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

function BuildInfoRow() {
  const builtAt = formatBuildTime(__APP_BUILD_TIME__);
  return (
    <a
      href={`${REPO_URL}/commit/${__APP_COMMIT__}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 py-3 first:pt-1 last:pb-1 hover:bg-surface-sunken -mx-1 px-1 rounded-lg transition"
    >
      <div className="flex flex-col leading-tight min-w-0 flex-1">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">Verzija</span>
        <span className="text-sm font-medium text-ink-primary">
          v{__APP_VERSION__} · <span className="font-mono">{__APP_COMMIT__}</span>
        </span>
        <span className="text-[11px] text-ink-muted">{builtAt}</span>
      </div>
      <ExternalLink className="h-3.5 w-3.5 text-ink-muted shrink-0" />
    </a>
  );
}

function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} UTC`;
}
