import { useState } from 'react';
import { useLocation } from 'wouter';
import {
  Globe2,
  KeyRound,
  Fingerprint,
  ShieldCheck,
  RefreshCw,
  Sparkles,
  ChevronLeft,
  ExternalLink,
} from 'lucide-react';
import { Button, Card, Field, Input, Section, useToast } from '../ui';
import {
  createPasskey,
  getActivePasskey,
  listKnownPasskeys,
  recordRpId,
  savePasskey,
  setActivePasskey,
  signWithPasskey,
  suggestPasskeyName,
  type PasskeyRecord,
} from '../lib/passkey';
import {
  encodeWebAuthnSignature,
  getSafeTxHash,
  predictSignerAddress,
} from '../lib/safe';
import { encodeAddOwnerWithThreshold } from '../lib/safeOwners';
import { relayTx } from '../lib/relay';
import { registerWalletWithBackend } from '../lib/registry';
import { useWalletStore } from '../state/store';
import { humanizeError } from '../lib/errors';
import { haptic } from '../lib/haptic';

type Stage =
  | { kind: 'intro' }
  | { kind: 'naming'; suggested: string }
  | { kind: 'enrolling'; chosenName: string }
  | { kind: 'signing'; newPasskey: NewPasskeyMeta }
  | { kind: 'relaying'; newPasskey: NewPasskeyMeta }
  | { kind: 'done'; newRecord: PasskeyRecord; txHash: string }
  | { kind: 'error'; message: string };

type NewPasskeyMeta = {
  credentialId: string;
  pubKeyX: string;
  pubKeyY: string;
  signerAddress: `0x${string}`;
  keychainName: string;
  rpId: string;
};

export function ExpandAccess() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { safeAddress, credentialId: activeCred, signerAddress } = useWalletStore();
  const [stage, setStage] = useState<Stage>({ kind: 'intro' });

  function back() {
    setLocation('/settings');
  }

  function startNaming() {
    haptic('tap');
    setStage({ kind: 'naming', suggested: suggestPasskeyName() });
  }

  async function runExpand(chosenName: string) {
    if (!safeAddress || !activeCred || !signerAddress) {
      setStage({ kind: 'error', message: 'Nema aktivnog walleta.' });
      return;
    }
    const activePasskey = getActivePasskey();
    if (!activePasskey) {
      setStage({ kind: 'error', message: 'Aktivan passkey nije pronađen na uređaju.' });
      return;
    }
    if (!activePasskey.pubKey.x || activePasskey.pubKey.x === '0') {
      setStage({
        kind: 'error',
        message:
          'Originalni passkey nema pubkey podatke na ovom uređaju. Otvori wallet na uređaju gdje je kreiran i pokrei akciju odande.',
      });
      return;
    }

    setStage({ kind: 'enrolling', chosenName });
    haptic('tap');

    // Step 1: enroll the new passkey under the current (post-Phase-B = parent)
    // RP. This is the Face ID prompt #1. Pass excludeCredentials = locally-known
    // creds so the authenticator refuses to re-mint a passkey this device already
    // holds (InvalidStateError) instead of adding a redundant co-owner. See
    // docs/passkey-onboarding-industry-standards.md (Phase 2).
    let created: Awaited<ReturnType<typeof createPasskey>>;
    try {
      created = await createPasskey(chosenName, {
        excludeCredentialIds: listKnownPasskeys().map((k) => k.credentialId),
      });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
      return;
    }

    let newSignerAddress: `0x${string}`;
    try {
      newSignerAddress = await predictSignerAddress(created.pubKey);
    } catch (e) {
      setStage({ kind: 'error', message: humanizeError(e, 'generic') });
      return;
    }

    const newPasskey: NewPasskeyMeta = {
      credentialId: created.credentialId,
      pubKeyX: created.pubKey.x.toString(),
      pubKeyY: created.pubKey.y.toString(),
      signerAddress: newSignerAddress,
      keychainName: created.keychainName,
      rpId: created.rpId,
    };

    // Step 2: sign the addOwnerWithThreshold(newSigner, 1) call with the
    // EXISTING passkey. Threshold stays at 1 so either key still suffices.
    setStage({ kind: 'signing', newPasskey });

    const addOwnerData = encodeAddOwnerWithThreshold(newSignerAddress, 1n);

    let safeTxHash: `0x${string}`;
    try {
      const { hash } = await getSafeTxHash(safeAddress, {
        to: safeAddress,
        value: 0n,
        data: addOwnerData,
      });
      safeTxHash = hash;
    } catch (e) {
      setStage({ kind: 'error', message: humanizeError(e, 'generic') });
      return;
    }

    let signature: `0x${string}`;
    try {
      const assertion = await signWithPasskey(
        activeCred,
        hexToBytes(safeTxHash),
        recordRpId(activePasskey),
      );
      signature = encodeWebAuthnSignature({ ...assertion, signerAddress });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
      return;
    }

    // Step 3: relay submits execTransaction. Hot path if Safe is deployed,
    // cold path otherwise — both end with newSigner being an owner.
    setStage({ kind: 'relaying', newPasskey });

    const result = await relayTx({
      safeAddress,
      signerAddress,
      pubKeyX: activePasskey.pubKey.x,
      pubKeyY: activePasskey.pubKey.y,
      to: safeAddress,
      value: '0',
      data: addOwnerData,
      signature,
    });

    if (!result.ok) {
      haptic('error');
      setStage({
        kind: 'error',
        message: result.rateLimited
          ? 'Dosegao si dnevni limit (5 besplatnih transakcija).'
          : result.error,
      });
      return;
    }

    // Step 4: persist the new PasskeyRecord locally and on the backend so
    // future loads + cross-device opens resolve it back to this Safe.
    const newRecord: PasskeyRecord = {
      credentialId: newPasskey.credentialId,
      pubKey: { x: newPasskey.pubKeyX, y: newPasskey.pubKeyY },
      signerAddress: newPasskey.signerAddress,
      safeAddress,
      createdAt: new Date().toISOString(),
      keychainName: newPasskey.keychainName,
      rpId: newPasskey.rpId,
    };
    savePasskey(newRecord);
    setActivePasskey(activeCred); // keep current active; user can switch later

    void registerWalletWithBackend({
      credentialId: newPasskey.credentialId,
      pubKeyX: newPasskey.pubKeyX,
      pubKeyY: newPasskey.pubKeyY,
      signerAddress: newPasskey.signerAddress,
      safeAddress,
      rpId: newPasskey.rpId,
    });

    haptic('success');
    setStage({ kind: 'done', newRecord, txHash: result.txHash });
    toast({
      variant: 'success',
      title: 'Pristup proširen ✓',
      description: 'Novi passkey je co-owner trenutno otvorenog računa.',
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <button
        type="button"
        onClick={back}
        className="flex items-center gap-1 text-sm text-ink-secondary hover:text-ink-primary -ml-1"
      >
        <ChevronLeft className="h-4 w-4" /> Postavke
      </button>

      {stage.kind === 'intro' && <IntroView onContinue={startNaming} />}
      {stage.kind === 'naming' && (
        <NamingView
          suggested={stage.suggested}
          onCancel={() => setStage({ kind: 'intro' })}
          onConfirm={runExpand}
        />
      )}
      {stage.kind === 'enrolling' && (
        <ProgressView
          title="Otvori Face ID — novi passkey"
          subtitle={`Spremam "${stage.chosenName}" u Keychain pod scope-om „svi *.domovina.ai".`}
          icon={<Fingerprint className="h-10 w-10" />}
        />
      )}
      {stage.kind === 'signing' && (
        <ProgressView
          title="Otvori Face ID — potpis"
          subtitle="Sad potpiši svojim originalnim passkeyom da dodaš novi kao vlasnika Safea."
          icon={<KeyRound className="h-10 w-10" />}
        />
      )}
      {stage.kind === 'relaying' && (
        <ProgressView
          title="Šaljem na Gnosis…"
          subtitle="addOwnerWithThreshold se izvršava preko našeg relaya."
          icon={<RefreshCw className="h-10 w-10 animate-spin" />}
        />
      )}
      {stage.kind === 'done' && (
        <DoneView record={stage.newRecord} txHash={stage.txHash} onClose={back} />
      )}
      {stage.kind === 'error' && (
        <ErrorView
          message={stage.message}
          onRetry={() => setStage({ kind: 'intro' })}
          onClose={back}
        />
      )}
    </div>
  );
}

function IntroView({ onContinue }: { onContinue: () => void }) {
  return (
    <Section
      title="Dodaj passkey"
      description="Rezervni passkey postaje co-owner istog Safe-a. Threshold ostaje 1, bilo koji od njih sam može potpisati transakciju. Preporuka za store: isključivo Apple Passwords ili Google Password Manager."
    >
      <Card padding="md" className="flex flex-col gap-4">
        <Step
          icon={<KeyRound />}
          title="Spremi ga u Apple Passwords / Google Password Manager"
          description="Na iPhoneu i Androidu oni otključavaju potpisnika hardverski (Secure Enclave / StrongBox + biometrija) — najsigurnija razina. Browser ekstenzije (LastPass, 1Password, Brave profil…) ne preporučujemo."
        />
        <Step
          icon={<ShieldCheck />}
          title="Vrijedi samo za trenutno otvoreni račun"
          description="Novi passkey postaje co-owner Safe-a koji je sad otvoren — ne i ostalih računa pod tvojim passkeyem. Za drugi račun prebaci se na njega (Postavke → Računi) i ponovi postupak. Threshold ostaje 1: bilo koji passkey sam potpisuje, ako jedan izgubiš drugi i dalje daje pristup."
        />
        <Step
          icon={<Globe2 />}
          title="Dva Face ID prompta"
          description="Prvi za kreiranje novog passkeya pod istom domenom. Drugi za potpis transakcije koja ga dodaje kao Safe ownera onchain."
        />
      </Card>
      <Button onClick={onContinue} size="xl" block className="mt-2">
        <Sparkles className="h-5 w-5" />
        Nastavi
      </Button>
    </Section>
  );
}

function NamingView({
  suggested,
  onCancel,
  onConfirm,
}: {
  suggested: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(suggested);
  const trimmed = name.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 64;

  return (
    <Section
      title="Naziv novog passkeya"
      description="Pod ovim imenom će biti spremljen u Apple Passwords / iCloud Keychain / Google Password Manager."
    >
      <Card padding="md">
        <Field label="Ime passkeya" error={trimmed.length > 64 ? 'Maksimalno 64 znaka.' : undefined}>
          {(id) => (
            <Input
              id={id}
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !invalid) onConfirm(trimmed);
              }}
              maxLength={80}
              invalid={trimmed.length > 64}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
        </Field>
      </Card>
      <div className="flex flex-col gap-2">
        <Button onClick={() => onConfirm(trimmed)} size="xl" block disabled={invalid}>
          <Fingerprint className="h-5 w-5" />
          Otvori Face ID
        </Button>
        <Button onClick={onCancel} variant="ghost" size="md" block>
          Odustani
        </Button>
      </div>
    </Section>
  );
}

function ProgressView({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12 animate-route-enter">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-brand-navy-400/20 animate-ping" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-navy-700 text-white dark:bg-brand-navy-400 dark:text-brand-navy-900">
          {icon}
        </div>
      </div>
      <div className="text-center flex flex-col gap-1 max-w-xs">
        <p className="font-semibold text-ink-primary text-lg">{title}</p>
        <p className="text-sm text-ink-secondary">{subtitle}</p>
      </div>
    </div>
  );
}

function DoneView({
  record,
  txHash,
  onClose,
}: {
  record: PasskeyRecord;
  txHash: string;
  onClose: () => void;
}) {
  const explorerUrl = `https://gnosisscan.io/tx/${txHash}`;
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
          <h2 className="text-2xl font-semibold text-ink-primary">Pristup proširen</h2>
          <p className="text-sm text-ink-secondary max-w-xs">
            Tvoj novi passkey je dodatni vlasnik Safea. Možeš ga koristiti na bilo kojoj *.domovina.ai aplikaciji.
          </p>
        </div>
      </div>
      <Card padding="md" className="flex flex-col gap-2">
        <div className="text-[11px] uppercase tracking-widest text-ink-muted">Novi passkey</div>
        <div className="font-mono text-sm text-ink-primary break-all">{record.keychainName}</div>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-brand-navy-500 hover:underline inline-flex items-center gap-1 mt-1"
        >
          Pogledaj transakciju <ExternalLink className="h-3 w-3" />
        </a>
      </Card>
      <Button onClick={onClose} size="xl" block>
        Natrag na postavke
      </Button>
    </div>
  );
}

function ErrorView({
  message,
  onRetry,
  onClose,
}: {
  message: string;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="border-brand-red-500/40">
        <p className="text-sm text-brand-red-700 text-center" role="alert">
          {message}
        </p>
      </Card>
      <div className="flex flex-col gap-2">
        <Button onClick={onRetry} variant="secondary" size="lg" block>
          Pokušaj ponovno
        </Button>
        <Button onClick={onClose} variant="ghost" size="md" block>
          Natrag
        </Button>
      </div>
    </div>
  );
}

function Step({
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

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
