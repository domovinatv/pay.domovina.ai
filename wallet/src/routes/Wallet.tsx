import { useEffect, useState } from 'react';
import { BrandHeader } from '../components/Brand';
import { AddressView } from '../components/AddressView';
import { useWalletStore } from '../state/store';
import { getEureBalance } from '../lib/balance';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { getActivePasskey } from '../lib/passkey';
import { RP_ID } from '../lib/constants';

export function Wallet() {
  const { safeAddress, credentialId, balance, setBalance, setScreen } = useWalletStore();
  const [hasPhone, setHasPhone] = useState<boolean | null>(null);

  useEffect(() => {
    if (!safeAddress) return;
    let cancelled = false;
    async function tick() {
      try {
        const { formatted } = await getEureBalance(safeAddress!);
        if (!cancelled) setBalance(formatted);
      } catch {
        /* ignore — likely not yet deployed */
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
        // Backward compatibility: walletovi kreirani prije Phase 3 nisu u
        // registry-u. Auto-register sa lokalno pohranjenim podacima tako da
        // bind-phone i ostali registry-gated featuri rade i za njih.
        const passkey = getActivePasskey();
        const x = passkey?.pubKey?.x;
        const y = passkey?.pubKey?.y;
        // Skip if we only have stub pubKey ('0') — that's the cross-device
        // restore path and registering would inject garbage values.
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
      if (!cancelled) setHasPhone(view ? view.has_phone : null);
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
        <section className="card text-center">
          <div className="text-xs uppercase tracking-widest text-gray-400">Balance</div>
          <div className="text-5xl font-bold mt-2">
            {balance === null ? '—' : Number(balance).toFixed(2)}
            <span className="text-2xl text-gray-400 ml-2">EURe</span>
          </div>
          <div className="mt-4">
            <AddressView address={safeAddress} />
          </div>
        </section>

        <div className="grid grid-cols-2 gap-3">
          <button onClick={() => setScreen('receive')} className="btn-primary">
            Receive
          </button>
          <button onClick={() => setScreen('send')} className="btn-secondary">
            Send
          </button>
        </div>

        {hasPhone !== true && (
          <button
            onClick={() => setScreen('bind-phone')}
            className="text-sm text-domovina-navy underline self-center"
          >
            + Dodaj recovery telefon
          </button>
        )}
        {hasPhone === true && (
          <div className="text-xs text-center text-gray-400">
            Recovery telefon povezan ✓
          </div>
        )}
      </main>

      <footer className="py-6 text-center text-xs text-gray-400">
        Gnosis Chain · Safe smart account
      </footer>
    </div>
  );
}
