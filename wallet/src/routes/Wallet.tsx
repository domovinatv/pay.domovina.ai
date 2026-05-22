import { useEffect } from 'react';
import { BrandHeader } from '../components/Brand';
import { AddressView } from '../components/AddressView';
import { useWalletStore } from '../state/store';
import { getEureBalance } from '../lib/balance';

export function Wallet() {
  const { safeAddress, balance, setBalance, setScreen } = useWalletStore();

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
      </main>

      <footer className="py-6 text-center text-xs text-gray-400">
        Gnosis Chain · Safe smart account
      </footer>
    </div>
  );
}
