import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Zap, Plus, RefreshCw, Sparkles, Fingerprint, ChevronRight } from 'lucide-react';
import type { Address } from 'viem';
import { BrandHeader } from '../components/Brand';
import { AddressChip, Button, Card } from '../ui';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';
import { humanizeError } from '../lib/errors';
import {
  createPasskey,
  listKnownPasskeys,
  lookupPasskey,
  pickExistingPasskey,
  savePasskey,
  setActivePasskey,
  type PasskeyRecord,
} from '../lib/passkey';
import { predictSignerAddress, predictSafeAddress } from '../lib/safe';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { RP_ID } from '../lib/constants';

type Stage =
  | { kind: 'welcome' }
  | { kind: 'welcome-known'; known: PasskeyRecord[] }
  | { kind: 'creating' }
  | { kind: 'opening' }
  | { kind: 'created'; record: PasskeyRecord }
  | { kind: 'error'; message: string };

export function Landing() {
  const setIdentity = useWalletStore((s) => s.setIdentity);
  const [stage, setStage] = useState<Stage>(() => {
    const known = listKnownPasskeys();
    return known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' };
  });

  // Refresh the known list whenever we return to a welcome stage (e.g. after
  // signing out, this component remounts; this also handles cancelled flows).
  useEffect(() => {
    if (stage.kind === 'welcome' || stage.kind === 'welcome-known') {
      const known = listKnownPasskeys();
      if (known.length > 0 && stage.kind !== 'welcome-known') {
        setStage({ kind: 'welcome-known', known });
      } else if (known.length === 0 && stage.kind !== 'welcome') {
        setStage({ kind: 'welcome' });
      }
    }
  }, [stage.kind]);

  async function createNew() {
    setStage({ kind: 'creating' });
    haptic('tap');
    try {
      const { credentialId, pubKey, nameSuffix } = await createPasskey();
      const signerAddress = await predictSignerAddress(pubKey);
      const safeAddress = await predictSafeAddress(signerAddress);

      const record: PasskeyRecord = {
        credentialId,
        pubKey: { x: pubKey.x.toString(), y: pubKey.y.toString() },
        signerAddress,
        safeAddress,
        createdAt: new Date().toISOString(),
        nameSuffix,
      };
      savePasskey(record);

      void registerWalletWithBackend({
        credentialId,
        pubKeyX: pubKey.x.toString(),
        pubKeyY: pubKey.y.toString(),
        signerAddress,
        safeAddress,
        rpId: RP_ID,
      });

      haptic('success');
      setStage({ kind: 'created', record });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  async function openKnown(record: PasskeyRecord) {
    haptic('tap');
    // No WebAuthn re-auth on open — Send requires Face ID anyway, and skipping
    // it avoids an iOS race where Keychain leaves credentials in a "pending"
    // state. See [[feedback-webauthn-ios-pending-race]].
    setActivePasskey(record.credentialId);
    setIdentity({
      credentialId: record.credentialId,
      signerAddress: record.signerAddress,
      safeAddress: record.safeAddress,
    });
  }

  async function openExisting() {
    setStage({ kind: 'opening' });
    haptic('tap');
    try {
      const { credentialId } = await pickExistingPasskey();
      let record = lookupPasskey(credentialId);
      if (!record) {
        // Cross-device fallback: passkey synced via iCloud/Google but no
        // localStorage on this device. Try the backend registry.
        const remote = await lookupWallet(credentialId);
        if (!remote) {
          throw new Error(
            'Ovaj passkey nije registriran ni lokalno ni na serveru. Otvori na izvornom uređaju ili kreiraj novi wallet.',
          );
        }
        // pubKey ('0','0') is a stub — Safe is already deployed so we don't
        // need it for Open. Future Send recovers pubKey from the assertion.
        const restored: PasskeyRecord = {
          credentialId,
          pubKey: { x: '0', y: '0' },
          signerAddress: remote.signer_address,
          safeAddress: remote.safe_address,
          createdAt: remote.created_at,
        };
        savePasskey(restored);
        record = restored;
      }
      setActivePasskey(record.credentialId);
      setIdentity({
        credentialId: record.credentialId,
        signerAddress: record.signerAddress,
        safeAddress: record.safeAddress,
      });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  function enterWalletAfterCreate(record: PasskeyRecord) {
    setActivePasskey(record.credentialId);
    setIdentity({
      credentialId: record.credentialId,
      signerAddress: record.signerAddress,
      safeAddress: record.safeAddress,
    });
  }

  function resetToWelcome() {
    const known = listKnownPasskeys();
    setStage(known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' });
  }

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto pt-safe pb-safe">
      <BrandHeader />

      <main className="flex-1 flex flex-col justify-center gap-8 pb-12">
        {stage.kind === 'welcome' && (
          <WelcomeView onCreate={createNew} onCrossDevice={openExisting} />
        )}

        {stage.kind === 'welcome-known' && (
          <WelcomeKnownView
            known={stage.known}
            onOpenKnown={openKnown}
            onCreate={createNew}
            onCrossDevice={openExisting}
          />
        )}

        {stage.kind === 'creating' && <CreatingView />}

        {stage.kind === 'opening' && <OpeningView />}

        {stage.kind === 'created' && (
          <CreatedView record={stage.record} onEnter={() => enterWalletAfterCreate(stage.record)} />
        )}

        {stage.kind === 'error' && (
          <ErrorView message={stage.message} onRetry={resetToWelcome} />
        )}
      </main>
    </div>
  );
}

function WelcomeView({
  onCreate,
  onCrossDevice,
}: {
  onCreate: () => void;
  onCrossDevice: () => void;
}) {
  return (
    <div className="flex flex-col gap-8 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <h2 className="text-2xl font-semibold text-ink-primary">Self-custody EURe wallet</h2>
        <p className="text-ink-secondary">
          Bez seed phrase-a. Bez password-a. Samo Face&nbsp;ID i Keychain.
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-3">
        <FeatureRow
          icon={<KeyRound />}
          title="Passkey, ne ključ"
          description="Tvoj passkey živi u iCloud Keychain / 1Password."
        />
        <FeatureRow
          icon={<ShieldCheck />}
          title="Mi ne vidimo ništa"
          description="Sve potpise radi tvoj Face ID lokalno."
        />
        <FeatureRow
          icon={<Zap />}
          title="Gas plaćamo mi"
          description="5 besplatnih transakcija dnevno."
        />
      </Card>

      <div className="flex flex-col gap-3">
        <Button onClick={onCreate} size="xl" block>
          <Plus className="h-5 w-5" />
          Kreiraj wallet
        </Button>
        <Button onClick={onCrossDevice} variant="secondary" size="lg" block>
          <RefreshCw className="h-4 w-4" />
          Imam passkey na drugom uređaju
        </Button>
      </div>
    </div>
  );
}

function WelcomeKnownView({
  known,
  onOpenKnown,
  onCreate,
  onCrossDevice,
}: {
  known: PasskeyRecord[];
  onOpenKnown: (record: PasskeyRecord) => void;
  onCreate: () => void;
  onCrossDevice: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-1">
        <h2 className="text-2xl font-semibold text-ink-primary">Dobrodošao natrag</h2>
        <p className="text-sm text-ink-secondary">
          {known.length === 1 ? 'Wallet je spreman za otvaranje.' : 'Odaberi wallet koji želiš otvoriti.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {known.map((record) => (
          <WalletCard key={record.credentialId} record={record} onClick={() => onOpenKnown(record)} />
        ))}
      </div>

      <div className="flex flex-col gap-2 pt-2">
        <Button onClick={onCreate} variant="ghost" size="md" block>
          <Plus className="h-4 w-4" />
          Kreiraj novi wallet
        </Button>
        <Button onClick={onCrossDevice} variant="ghost" size="sm" block>
          <RefreshCw className="h-4 w-4" />
          Sinkroniziraj passkey s drugog uređaja
        </Button>
      </div>
    </div>
  );
}

function WalletCard({ record, onClick }: { record: PasskeyRecord; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-3xl bg-surface-raised border border-surface-border shadow-card hover:bg-surface-sunken active:scale-[0.99] transition flex items-center gap-3 p-4"
    >
      <div
        aria-hidden
        className="h-12 w-12 rounded-2xl shrink-0 ring-1 ring-black/5"
        style={{ background: gradientFor(record.safeAddress) }}
      />
      <div className="flex flex-col leading-tight min-w-0 flex-1">
        <span className="text-xs uppercase tracking-widest text-ink-muted">
          {record.nameSuffix ? `wa_${record.nameSuffix}` : 'Safe'}
        </span>
        <span className="font-mono text-sm text-ink-primary truncate">
          {shorten(record.safeAddress)}
        </span>
        <span className="text-[11px] text-ink-muted">
          kreiran {formatDate(record.createdAt)}
        </span>
      </div>
      <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />
    </button>
  );
}

function CreatingView() {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12 animate-route-enter">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-brand-navy-400/20 animate-ping" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-navy-700 text-white dark:bg-brand-navy-400 dark:text-brand-navy-900">
          <Fingerprint className="h-10 w-10" />
        </div>
      </div>
      <div className="text-center flex flex-col gap-1">
        <p className="font-semibold text-ink-primary text-lg">Otvori Face&nbsp;ID</p>
        <p className="text-sm text-ink-secondary max-w-xs">
          Sustav će tražiti potvrdu. Tvoj passkey će se pohraniti u Keychain.
        </p>
      </div>
    </div>
  );
}

function OpeningView() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 animate-route-enter">
      <RefreshCw className="h-8 w-8 text-ink-muted animate-spin" />
      <p className="text-sm text-ink-secondary">Otvori passkey…</p>
    </div>
  );
}

function CreatedView({ record, onEnter }: { record: PasskeyRecord; onEnter: () => void }) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-emerald-400/30 blur-xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Sparkles className="h-10 w-10" />
          </div>
        </div>
        <div className="text-center flex flex-col gap-1">
          <h2 className="text-2xl font-semibold text-ink-primary">Tvoj wallet je spreman</h2>
          <p className="text-sm text-ink-secondary max-w-xs">
            Passkey je u Keychain, Safe smart account je rezerviran na Gnosis Chainu.
          </p>
        </div>
      </div>

      <Card padding="md" className="flex flex-col items-center gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">Tvoja adresa</span>
        <AddressChip address={record.safeAddress} truncate={false} className="max-w-full" />
        {record.nameSuffix && (
          <p className="text-xs text-ink-muted text-center max-w-xs">
            U Apple Passwords / Google Password Manageru ovaj passkey vidiš kao{' '}
            <span className="font-mono text-ink-secondary">DOMOVINA wa_{record.nameSuffix}</span>.
          </p>
        )}
      </Card>

      <Button onClick={onEnter} size="xl" block>
        Otvori wallet
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="border-brand-red-500/40">
        <p className="text-sm text-brand-red-700 text-center" role="alert">
          {message}
        </p>
      </Card>
      <Button onClick={onRetry} variant="secondary" size="lg" block>
        Natrag
      </Button>
    </div>
  );
}

function FeatureRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500 [&_svg]:h-5 [&_svg]:w-5">
        {icon}
      </div>
      <div className="flex flex-col leading-tight">
        <p className="font-medium text-ink-primary">{title}</p>
        <p className="text-sm text-ink-secondary">{description}</p>
      </div>
    </div>
  );
}

function shorten(addr: Address): string {
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
