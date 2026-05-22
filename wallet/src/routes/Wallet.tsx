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
  const [phones, setPhones] = useState<
    Array<{
      phone_hash_short: string;
      first_bound_at: string;
      latest_verified_at: string;
      verification_count: number;
    }>
  >([]);
  const [totalVerifications, setTotalVerifications] = useState<number>(0);

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

  // Side-effect-free helper; hoisting into render is fine here.
  function formatDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
  }
  void formatDate;

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

        <section className="pt-2 space-y-3">
          {phones.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-widest text-gray-400 text-center">
                Verifikacije telefona — {phones.length}{' '}
                {phones.length === 1 ? 'broj' : 'broja'} · {totalVerifications}× ukupno
              </div>
              <ul className="space-y-1.5">
                {phones.map((p) => (
                  <li
                    key={p.phone_hash_short}
                    className="rounded-xl border border-gray-200 px-3 py-2 text-xs flex items-center justify-between gap-2"
                  >
                    <div className="font-mono text-gray-500">{p.phone_hash_short}</div>
                    <div className="text-right text-gray-400 leading-tight">
                      <div>
                        <span className="font-semibold text-domovina-navy">
                          {p.verification_count}×
                        </span>
                      </div>
                      <div>
                        {formatDate(p.first_bound_at)}
                        {p.latest_verified_at !== p.first_bound_at && (
                          <> → {formatDate(p.latest_verified_at)}</>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button
            onClick={() => setScreen('bind-phone')}
            className="block mx-auto text-sm text-domovina-navy underline"
          >
            {phones.length > 0 ? '+ Verificiraj telefon (isti ili novi)' : '+ Dodaj telefon'}
          </button>
        </section>
      </main>

      <footer className="py-6 text-center text-xs text-gray-400">
        Gnosis Chain · Safe smart account
      </footer>
    </div>
  );
}
