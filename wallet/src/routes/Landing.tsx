import { useEffect, useState } from 'react';
import { BrandHeader } from '../components/Brand';
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

export function Landing() {
  const setIdentity = useWalletStore((s) => s.setIdentity);
  const [busy, setBusy] = useState<null | 'create' | 'open'>(null);
  const [error, setError] = useState<string | null>(null);
  const [knownCount, setKnownCount] = useState(0);

  useEffect(() => {
    setKnownCount(listKnownPasskeys().length);
    // If a single wallet was previously created on this device, auto-load it
    // after a passkey assertion — gives a one-tap re-entry.
    const active = getActivePasskey();
    if (active) {
      // Just reflect knownCount so we render the "primary" button label.
    }
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
      const record = lookupPasskey(credentialId);
      if (!record) {
        throw new Error(
          'Ovaj passkey ne pripada nijednom walletu pohranjenom na ovom uređaju. ' +
            'Otvori na izvornom uređaju ili kreiraj novi wallet.',
        );
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
    // No WebAuthn re-auth on open — funds aren't accessible without Face ID
    // anyway (Send requires it). Skipping the gratuitous WebAuthn call here
    // also avoids a known iOS/macOS race where the previous Keychain dialog
    // leaves the credentials API in a "pending" state for the next call.
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

      <main className="flex-1 flex flex-col justify-center gap-6 pb-12">
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold">Self-custody EURe wallet</h2>
          <p className="text-gray-500">
            Bez seed phrase-a. Bez password-a. Samo Face&nbsp;ID i Keychain.
          </p>
        </div>

        {hasKnown ? (
          <>
            <button onClick={openActive} disabled={busy !== null} className="btn-primary">
              {busy === 'open' ? 'Otvaram…' : 'Otvori wallet'}
            </button>
            <button onClick={openExisting} disabled={busy !== null} className="btn-secondary">
              {busy === 'open' ? '…' : 'Otvori drugi pohranjeni passkey'}
            </button>
            <details className="text-center text-xs text-gray-400">
              <summary className="cursor-pointer">Nemaš pristup ili želiš novi wallet?</summary>
              <button
                onClick={createNew}
                disabled={busy !== null}
                className="mt-3 underline text-domovina-navy"
              >
                Kreiraj novi wallet (zaseban passkey)
              </button>
            </details>
          </>
        ) : (
          <>
            <button onClick={createNew} disabled={busy !== null} className="btn-primary">
              {busy === 'create' ? 'Kreiram passkey…' : 'Kreiraj wallet'}
            </button>
            <button onClick={openExisting} disabled={busy !== null} className="btn-secondary">
              {busy === 'open' ? '…' : 'Imam passkey, prijavi me'}
            </button>
          </>
        )}

        {error && (
          <div className="text-sm text-domovina-red text-center bg-red-50 rounded-xl p-3">
            {error}
          </div>
        )}

        <p className="text-xs text-center text-gray-400">
          Tvoj passkey živi u tvom password manageru (iCloud Keychain, 1Password, LastPass…). Mi nikad ne vidimo
          tvoj ključ.
        </p>
      </main>
    </div>
  );
}
