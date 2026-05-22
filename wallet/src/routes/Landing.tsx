import { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Zap } from 'lucide-react';
import { BrandHeader } from '../components/Brand';
import { Button, Card } from '../ui';
import { useWalletStore } from '../state/store';
import {
  createPasskey,
  getActivePasskey,
  listKnownPasskeys,
  lookupPasskey,
  pickExistingPasskey,
  savePasskey,
  setActivePasskey,
} from '../lib/passkey';
import { predictSignerAddress, predictSafeAddress } from '../lib/safe';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { RP_ID } from '../lib/constants';

export function Landing() {
  const setIdentity = useWalletStore((s) => s.setIdentity);
  const [busy, setBusy] = useState<null | 'create' | 'open'>(null);
  const [error, setError] = useState<string | null>(null);
  const [knownCount, setKnownCount] = useState(0);

  useEffect(() => {
    setKnownCount(listKnownPasskeys().length);
  }, []);

  async function createNew() {
    setError(null);
    setBusy('create');
    try {
      const { credentialId, pubKey } = await createPasskey();
      const signerAddress = await predictSignerAddress(pubKey);
      const safeAddress = await predictSafeAddress(signerAddress);

      const record = {
        credentialId,
        pubKey: { x: pubKey.x.toString(), y: pubKey.y.toString() },
        signerAddress,
        safeAddress,
        createdAt: new Date().toISOString(),
      };
      savePasskey(record);
      setIdentity({ credentialId, signerAddress, safeAddress });

      void registerWalletWithBackend({
        credentialId,
        pubKeyX: pubKey.x.toString(),
        pubKeyY: pubKey.y.toString(),
        signerAddress,
        safeAddress,
        rpId: RP_ID,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function openExisting() {
    setError(null);
    setBusy('open');
    try {
      const { credentialId } = await pickExistingPasskey();
      let record = lookupPasskey(credentialId);
      if (!record) {
        const remote = await lookupWallet(credentialId);
        if (!remote) {
          throw new Error(
            'Ovaj passkey nije registriran ni lokalno ni na serveru. ' +
              'Otvori na izvornom uređaju ili kreiraj novi wallet.',
          );
        }
        const restored = {
          credentialId,
          pubKey: { x: '0', y: '0' },
          signerAddress: remote.signer_address,
          safeAddress: remote.safe_address,
          createdAt: remote.created_at,
        };
        savePasskey(restored);
        record = restored;
      }
      setActivePasskey(credentialId);
      setIdentity({
        credentialId,
        signerAddress: record.signerAddress,
        safeAddress: record.safeAddress,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function openActive() {
    // No WebAuthn re-auth on open — Send requires Face ID anyway, and
    // skipping it avoids an iOS race where Keychain leaves credentials in
    // a "pending" state. See [[feedback-webauthn-ios-pending-race]].
    const active = getActivePasskey();
    if (!active) return;
    setIdentity({
      credentialId: active.credentialId,
      signerAddress: active.signerAddress,
      safeAddress: active.safeAddress,
    });
  }

  const hasKnown = knownCount > 0;

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto">
      <BrandHeader />

      <main className="flex-1 flex flex-col justify-center gap-8 pb-12">
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
          {hasKnown ? (
            <>
              <Button onClick={openActive} disabled={busy !== null} size="xl" block>
                {busy === 'open' ? 'Otvaram…' : 'Otvori wallet'}
              </Button>
              <Button
                onClick={openExisting}
                disabled={busy !== null}
                variant="secondary"
                size="lg"
                block
              >
                {busy === 'open' ? '…' : 'Otvori drugi pohranjeni passkey'}
              </Button>
              <details className="text-center text-xs text-ink-muted">
                <summary className="cursor-pointer">Nemaš pristup ili želiš novi wallet?</summary>
                <button
                  onClick={createNew}
                  disabled={busy !== null}
                  className="mt-3 underline text-ink-primary"
                >
                  Kreiraj novi wallet (zaseban passkey)
                </button>
              </details>
            </>
          ) : (
            <>
              <Button onClick={createNew} disabled={busy !== null} size="xl" block>
                {busy === 'create' ? 'Kreiram passkey…' : 'Kreiraj wallet'}
              </Button>
              <Button
                onClick={openExisting}
                disabled={busy !== null}
                variant="secondary"
                size="lg"
                block
              >
                {busy === 'open' ? '…' : 'Imam passkey, prijavi me'}
              </Button>
            </>
          )}
        </div>

        {error && (
          <Card padding="md" className="border-brand-red-500 bg-brand-red-50 dark:bg-brand-red-700/10">
            <p className="text-sm text-brand-red-700 text-center">{error}</p>
          </Card>
        )}
      </main>
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
