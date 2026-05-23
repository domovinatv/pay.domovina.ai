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
  FileText,
  Code2,
  Copy,
  Check,
  Wallet as WalletIcon,
} from 'lucide-react';
import { Badge, Button, Card, IconButton, Section, SegmentedControl, useToast } from '../ui';
import { WalletSwitcherSheet } from '../components/WalletSwitcherSheet';
import { useTheme, type ThemeMode } from '../lib/theme';
import { useWalletStore } from '../state/store';
import { lookupWallet } from '../lib/registry';
import { listKnownPasskeys, getActivePasskey } from '../lib/passkey';

const REPO_URL = 'https://github.com/domovinatv/pay.domovina.ai';
const ADR_LINKS = [
  { id: '0001', title: 'Self-custody principle', slug: 'no-server-side-recovery' },
  { id: '0002', title: 'Onchain phone attestation', slug: 'phase-5-onchain-phone-attestation' },
  { id: '0003', title: 'PhoneSBT contract design', slug: 'phase-5-sbt-design' },
];

type PhoneSummary = {
  count: number;
  totalVerifications: number;
};

export function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { mode, setMode } = useTheme();
  const { safeAddress, signerAddress, credentialId, reset } = useWalletStore();
  const [phoneSummary, setPhoneSummary] = useState<PhoneSummary | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [knownCount, setKnownCount] = useState(0);
  const [nameSuffix, setNameSuffix] = useState<string | undefined>();

  useEffect(() => {
    setKnownCount(listKnownPasskeys().length);
    setNameSuffix(getActivePasskey()?.nameSuffix);
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
      {knownCount > 1 && (
        <Section title="Wallet">
          <button
            type="button"
            onClick={() => setSwitcherOpen(true)}
            className="text-left rounded-3xl bg-surface-raised border border-surface-border shadow-card p-5 hover:bg-surface-sunken transition flex items-center gap-3"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              <WalletIcon className="h-5 w-5" />
            </div>
            <div className="flex-1 flex flex-col leading-tight">
              <span className="font-medium text-ink-primary">Promijeni wallet</span>
              <span className="text-sm text-ink-secondary">
                {knownCount} walleta na ovom uređaju
              </span>
            </div>
            <ChevronRight className="h-4 w-4 text-ink-muted" />
          </button>
        </Section>
      )}

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
          {nameSuffix && (
            <div className="flex items-start justify-between gap-3 py-3 first:pt-1 last:pb-1">
              <div className="flex flex-col leading-tight min-w-0 flex-1">
                <span className="text-[11px] uppercase tracking-widest text-ink-muted">
                  Passkey ime
                </span>
                <span className="font-mono text-sm text-ink-primary">
                  DOMOVINA wa_{nameSuffix}
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
        </Card>
      </Section>

      <Section title="Sigurnost">
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
            <span className="font-medium text-ink-primary">Recovery telefon</span>
            <span className="text-sm text-ink-secondary">
              {phoneSummary === null
                ? 'učitavam…'
                : phoneSummary.count === 0
                  ? 'Nije postavljeno'
                  : `${phoneSummary.count} ${phoneSummary.count === 1 ? 'broj' : 'broja'} · ${phoneSummary.totalVerifications}× ukupno`}
            </span>
          </div>
          <ChevronRight className="h-4 w-4 text-ink-muted" />
        </button>
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
          {ADR_LINKS.map((adr) => (
            <a
              key={adr.id}
              href={`${REPO_URL}/blob/main/docs/decisions/${adr.id}-${adr.slug}.md`}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 py-3 first:pt-1 last:pb-1 hover:bg-surface-sunken -mx-1 px-1 rounded-lg transition"
            >
              <FileText className="h-4 w-4 text-ink-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] uppercase tracking-widest text-ink-muted">ADR {adr.id}</p>
                <p className="text-sm font-medium text-ink-primary truncate">{adr.title}</p>
              </div>
              <ExternalLink className="h-3.5 w-3.5 text-ink-muted shrink-0" />
            </a>
          ))}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 py-3 first:pt-1 last:pb-1 hover:bg-surface-sunken -mx-1 px-1 rounded-lg transition"
          >
            <Code2 className="h-4 w-4 text-ink-muted shrink-0" />
            <span className="flex-1 text-sm font-medium text-ink-primary">Izvorni kod</span>
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
        onSwitched={(record) => {
          toast({
            variant: 'success',
            title: 'Otvoren wallet',
            description: `${record.safeAddress.slice(0, 6)}…${record.safeAddress.slice(-4)}`,
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
