import { useEffect, useRef, useState } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { Copy, Check, ScanLine } from 'lucide-react';
import {
  Button,
  Card,
  Field,
  IconButton,
  Input,
  Section,
  StatusPill,
  useToast,
} from '../ui';
import { useTheme } from '../lib/theme';
import { useWalletStore } from '../state/store';
import { parseAmount, isAmountInvalidForDisplay } from '../lib/amount';
import {
  createPaymentIntent,
  subscribePaymentIntent,
  type PaymentIntent,
  type IntentState,
} from '../lib/paymentIntent';

const AMOUNT_PRESETS = ['10', '25', '50', '100'];

export function Receive() {
  const { safeAddress } = useWalletStore();
  const { toast } = useToast();
  const { resolved } = useTheme();
  const [amount, setAmount] = useState('10');
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);

  const parsedAmount = parseAmount(amount);
  const amountShowsError = isAmountInvalidForDisplay(amount);
  const amountErrorMsg = amountShowsError
    ? parsedAmount.ok
      ? undefined
      : parsedAmount.reason === 'zero'
        ? 'Iznos mora biti veći od 0'
        : 'Iznos nije valjan broj'
    : undefined;

  async function createIntent() {
    if (!safeAddress) return;
    if (!parsedAmount.ok) {
      setError('Iznos nije valjan broj.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const next = await createPaymentIntent({
        destination: safeAddress,
        amountEur: parsedAmount.numeric,
        label: 'DOMOVINA Wallet top-up',
      });
      setIntent(next);
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
    // QR always rendered on a white card with dark dots — even in dark mode
    // the QR card stays light so phone scanners read it reliably.
    new QRCodeStyling({
      width: 320,
      height: 320,
      data: intent.epc_qr_data,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { color: '#002F6C', type: 'square' },
      backgroundOptions: { color: '#ffffff' },
    }).append(qrRef.current);
  }, [intent?.epc_qr_data, resolved]);

  return (
    <div className="flex flex-col gap-6">
      {!intent ? (
        <Section
          title="Top-up"
          description="Plati SEPA prijenosom → dobiješ EURe na svoj wallet"
        >
          <Card className="flex flex-col gap-5">
            <Field label="Iznos u EUR" error={amountErrorMsg}>
              {(id) => (
                <Input
                  id={id}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  invalid={amountShowsError}
                  className="text-2xl font-semibold tabular text-center"
                  placeholder="0,00"
                />
              )}
            </Field>

            <div className="flex flex-wrap gap-2 justify-center">
              {AMOUNT_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAmount(preset)}
                  className={
                    'rounded-pill px-3 py-1 text-sm font-medium transition ' +
                    (amount === preset
                      ? 'bg-brand-navy-700 text-white dark:bg-brand-navy-400 dark:text-brand-navy-900'
                      : 'bg-surface-sunken text-ink-secondary hover:bg-surface-muted')
                  }
                >
                  {preset} €
                </button>
              ))}
            </div>

            <Button onClick={createIntent} disabled={busy || !amount} size="xl" block>
              {busy ? 'Generiram…' : 'Generiraj QR'}
            </Button>

            {error && (
              <p className="text-sm text-brand-red-700 text-center" role="alert">
                {error}
              </p>
            )}
          </Card>
        </Section>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex justify-center">
            <IntentStatusPill state={intent.state} />
          </div>

          <Card padding="lg" elevation="elevated" className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-ink-secondary">
              <ScanLine className="h-4 w-4" />
              Skeniraj u Revolutu / banci
            </div>
            <div ref={qrRef} className="rounded-2xl overflow-hidden bg-white p-2" />
            <div className="text-4xl font-semibold tabular text-ink-primary">
              {Number(intent.amount_eur).toFixed(2)}{' '}
              <span className="text-xl text-ink-muted">EUR</span>
            </div>
          </Card>

          <Section title="Detalji uplate">
            <Card padding="md" className="flex flex-col divide-y divide-surface-border">
              <DetailRow label="Primatelj" value={intent.beneficiary_name} onCopied={toast} />
              <DetailRow label="IBAN" value={intent.iban} mono onCopied={toast} />
              <DetailRow label="BIC" value={intent.bic} mono onCopied={toast} />
              <DetailRow label="Opis plaćanja" value={intent.memo} mono onCopied={toast} />
            </Card>
          </Section>

          <Button onClick={() => setIntent(null)} variant="ghost" size="md" block>
            Kreiraj novi nalog
          </Button>
        </div>
      )}
    </div>
  );
}

function IntentStatusPill({ state }: { state: IntentState }) {
  if (state === 'paid') {
    return (
      <StatusPill tone="success" dot>
        Stiglo ✓
      </StatusPill>
    );
  }
  if (state === 'expired') {
    return <StatusPill tone="neutral">Isteklo</StatusPill>;
  }
  return (
    <StatusPill tone="warning" dot pulse>
      Čekam uplatu…
    </StatusPill>
  );
}

type DetailRowProps = {
  label: string;
  value: string;
  mono?: boolean;
  onCopied: ReturnType<typeof useToast>['toast'];
};

function DetailRow({ label, value, mono, onCopied }: DetailRowProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopied({ variant: 'success', title: `${label} kopirano` });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      onCopied({ variant: 'error', title: 'Clipboard nedostupan' });
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">{label}</span>
        <span
          className={
            'truncate text-sm text-ink-primary ' + (mono ? 'font-mono' : 'font-medium')
          }
        >
          {value}
        </span>
      </div>
      <IconButton aria-label={`Kopiraj ${label}`} size="sm" variant="ghost" onClick={copy}>
        {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
      </IconButton>
    </div>
  );
}
