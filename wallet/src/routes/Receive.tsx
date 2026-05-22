import { useEffect, useRef, useState } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { BrandHeader } from '../components/Brand';
import { useWalletStore } from '../state/store';
import {
  createPaymentIntent,
  subscribePaymentIntent,
  type PaymentIntent,
  type IntentState,
} from '../lib/paymentIntent';

export function Receive() {
  const { safeAddress, setScreen } = useWalletStore();
  const [amount, setAmount] = useState('10');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);

  async function createIntent() {
    if (!safeAddress) return;
    setError(null);
    setBusy(true);
    try {
      const intent = await createPaymentIntent({
        destination: safeAddress,
        amountEur: Number(amount),
        label: 'DOMOVINA Wallet top-up',
      });
      setIntent(intent);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!intent) return;
    return subscribePaymentIntent(intent.sid, setIntent);
  }, [intent?.sid]);

  useEffect(() => {
    if (!intent || !qrRef.current) return;
    qrRef.current.innerHTML = '';
    new QRCodeStyling({
      width: 320,
      height: 320,
      data: intent.epc_qr_data,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { color: '#002F6C', type: 'square' },
      backgroundOptions: { color: '#ffffff' },
    }).append(qrRef.current);
  }, [intent?.epc_qr_data]);

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto">
      <BrandHeader />

      <main className="flex-1 flex flex-col gap-6">
        <button onClick={() => setScreen('wallet')} className="self-start text-sm text-gray-500">
          ← natrag
        </button>

        {!intent ? (
          <section className="card space-y-4">
            <h2 className="text-xl font-semibold">Top up EURe</h2>
            <p className="text-sm text-gray-500">
              Plati SEPA prijenosom (Revolut, banka) → dobiješ EURe na svoj wallet.
            </p>
            <label className="block">
              <span className="text-sm text-gray-600">Iznos (EUR)</span>
              <input
                type="number"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="mt-1 w-full rounded-xl border border-gray-300 px-4 py-3 text-lg font-semibold"
                min="1"
                step="1"
              />
            </label>
            <button onClick={createIntent} disabled={busy || !amount} className="btn-primary w-full">
              {busy ? 'Generiram…' : 'Generiraj QR'}
            </button>
            {error && <div className="text-sm text-domovina-red">{error}</div>}
          </section>
        ) : (
          <section className="card space-y-4 text-center">
            <h2 className="text-xl font-semibold">Skeniraj u Revolutu</h2>
            <div ref={qrRef} className="mx-auto" />
            <div className="text-sm text-gray-500">
              {Number(intent.amount_eur).toFixed(2)} EUR → tvoj wallet
            </div>
            <div className="text-xs font-mono text-gray-400 break-all">{intent.memo}</div>
            <StatusBadge state={intent.state} />
            <div className="text-xs text-gray-400 pt-2 border-t border-gray-100">
              {intent.beneficiary_name} · {intent.iban} · {intent.bic}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ state }: { state: IntentState }) {
  const styles: Record<IntentState, string> = {
    pending: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    paid: 'bg-green-50 text-green-700 border-green-200',
    expired: 'bg-gray-50 text-gray-600 border-gray-200',
  };
  const labels: Record<IntentState, string> = {
    pending: 'Čekam uplatu…',
    paid: 'Stiglo ✓',
    expired: 'Isteklo',
  };
  return (
    <div className={`inline-block px-3 py-1 rounded-full text-xs border ${styles[state]}`}>
      {labels[state]}
    </div>
  );
}
