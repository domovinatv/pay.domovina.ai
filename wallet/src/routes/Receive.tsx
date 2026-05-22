import { useEffect, useRef, useState } from 'react';
import QRCodeStyling from 'qr-code-styling';
import { Copy, Check, ScanLine, Landmark, Wallet as WalletIcon, Share2, Link as LinkIcon, Download } from 'lucide-react';
import {
  Button,
  Card,
  Field,
  IconButton,
  Input,
  Section,
  SegmentedControl,
  StatusPill,
  useToast,
} from '../ui';
import { useTheme } from '../lib/theme';
import { useWalletStore } from '../state/store';
import { parseAmount, isAmountInvalidForDisplay } from '../lib/amount';
import { encodeEureTransferUri } from '../lib/eip681';
import {
  createPaymentIntent,
  subscribePaymentIntent,
  type PaymentIntent,
  type IntentState,
} from '../lib/paymentIntent';

type Mode = 'sepa' | 'p2p';

const AMOUNT_PRESETS = ['10', '25', '50', '100'];

export function Receive() {
  const { safeAddress } = useWalletStore();
  const [mode, setMode] = useState<Mode>('sepa');

  if (!safeAddress) return null;

  return (
    <div className="flex flex-col gap-6">
      <SegmentedControl<Mode>
        ariaLabel="Način primanja"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'sepa', label: 'Iz banke', icon: <Landmark /> },
          { value: 'p2p', label: 'Drugi wallet', icon: <WalletIcon /> },
        ]}
      />

      {mode === 'sepa' ? <SepaReceive /> : <P2PReceive safeAddress={safeAddress} />}
    </div>
  );
}

// ───────── SEPA top-up (Monerium payment intent) ─────────

function SepaReceive() {
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
    new QRCodeStyling({
      width: 320,
      height: 320,
      data: intent.epc_qr_data,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { color: '#002F6C', type: 'square' },
      backgroundOptions: { color: '#ffffff' },
    }).append(qrRef.current);
  }, [intent?.epc_qr_data, resolved]);

  if (intent) {
    return (
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
            {Number(intent.amount_eur).toFixed(2)} <span className="text-xl text-ink-muted">EUR</span>
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
    );
  }

  return (
    <Section
      title="Top-up iz banke"
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
  );
}

// ───────── P2P direct EURe receive (EIP-681 QR) ─────────

function P2PReceive({ safeAddress }: { safeAddress: `0x${string}` }) {
  const { toast } = useToast();
  const { resolved } = useTheme();
  const [amount, setAmount] = useState('');
  const qrRef = useRef<HTMLDivElement>(null);
  const qrInstanceRef = useRef<QRCodeStyling | null>(null);

  const parsedAmount = parseAmount(amount);
  const amountShowsError = isAmountInvalidForDisplay(amount);
  const amountErrorMsg = amountShowsError
    ? parsedAmount.ok
      ? undefined
      : parsedAmount.reason === 'zero'
        ? 'Iznos mora biti veći od 0'
        : 'Iznos nije valjan broj'
    : undefined;

  const uri = encodeEureTransferUri({
    recipient: safeAddress,
    amountDecimal: parsedAmount.ok ? parsedAmount.normalized : undefined,
  });

  // Sharable https deep-link that opens DOMOVINA Wallet directly on /send
  // with the recipient + amount pre-filled. Same data as the EIP-681 QR but
  // clickable, so iMessage / Signal / WhatsApp can preview and tap-launch.
  const deepLinkParams = new URLSearchParams({ to: safeAddress });
  if (parsedAmount.ok) deepLinkParams.set('amount', parsedAmount.normalized);
  const deepLink = `${window.location.origin}/send?${deepLinkParams.toString()}`;

  useEffect(() => {
    if (!qrRef.current) return;
    qrRef.current.innerHTML = '';
    const instance = new QRCodeStyling({
      width: 320,
      height: 320,
      data: uri,
      qrOptions: { errorCorrectionLevel: 'M' },
      dotsOptions: { color: '#002F6C', type: 'square' },
      backgroundOptions: { color: '#ffffff' },
    });
    instance.append(qrRef.current);
    qrInstanceRef.current = instance;
  }, [uri, resolved]);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(safeAddress);
      toast({ variant: 'success', title: 'Adresa kopirana' });
    } catch {
      toast({ variant: 'error', title: 'Clipboard nedostupan' });
    }
  }

  async function copyDeepLink() {
    try {
      await navigator.clipboard.writeText(deepLink);
      toast({ variant: 'success', title: 'Link kopiran' });
    } catch {
      toast({ variant: 'error', title: 'Clipboard nedostupan' });
    }
  }

  async function shareReceive() {
    const shareTitle = 'Pošalji mi EURe';
    const amountSuffix = parsedAmount.ok ? ` ${parsedAmount.normalized} EURe` : '';
    const shareText = `Pošalji${amountSuffix} na moj DOMOVINA wallet`;

    // Best path: native share sheet with both the QR image and the deep link.
    // iOS Safari 15+ supports files; Android Chrome PWA does too.
    let qrFile: File | null = null;
    try {
      const blob = await qrInstanceRef.current?.getRawData('png');
      if (blob instanceof Blob) {
        qrFile = new File([blob], 'domovina-eure-qr.png', { type: 'image/png' });
      }
    } catch {
      /* fall through to URL-only share */
    }

    const sharePayload: ShareData = {
      title: shareTitle,
      text: shareText,
      url: deepLink,
    };
    if (qrFile && typeof navigator.canShare === 'function' && navigator.canShare({ files: [qrFile] })) {
      sharePayload.files = [qrFile];
    }

    if (typeof navigator.share === 'function') {
      try {
        await navigator.share(sharePayload);
        return;
      } catch (e) {
        // AbortError = user dismissed the share sheet — silent.
        if (e instanceof Error && e.name !== 'AbortError') {
          // Fall through to clipboard fallback below.
        } else {
          return;
        }
      }
    }
    // Final fallback: copy link to clipboard.
    await copyDeepLink();
  }

  async function downloadQr() {
    if (!qrInstanceRef.current) return;
    try {
      await qrInstanceRef.current.download({
        name: 'domovina-eure-qr',
        extension: 'png',
      });
      toast({ variant: 'success', title: 'QR spremljen' });
    } catch (e) {
      toast({ variant: 'error', title: 'Spremanje neuspješno', description: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="EURe izravno"
        description="Drugi korisnik skenira ovaj QR iz svog wallet-a i pošalje EURe direktno na tvoju Safe adresu na Gnosis Chainu."
      >
        <Card className="flex flex-col gap-4">
          <Field label="Iznos (neobavezno)" optional error={amountErrorMsg} hint="Ostavi prazno za otvoreni iznos">
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
        </Card>
      </Section>

      <Card padding="lg" elevation="elevated" className="flex flex-col items-center gap-4">
        <StatusPill tone="info">
          EIP-681 · Gnosis Chain
        </StatusPill>
        <div ref={qrRef} className="rounded-2xl overflow-hidden bg-white p-2" />
        {parsedAmount.ok && (
          <div className="text-3xl font-semibold tabular text-ink-primary">
            {Number(parsedAmount.normalized).toLocaleString('hr-HR', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}{' '}
            <span className="text-lg text-ink-muted">EURe</span>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <Button onClick={shareReceive} size="lg" block>
          <Share2 className="h-4 w-4" />
          Podijeli
        </Button>
        <Button onClick={downloadQr} variant="secondary" size="lg" block>
          <Download className="h-4 w-4" />
          Spremi QR
        </Button>
      </div>

      <Card padding="md" className="flex flex-col divide-y divide-surface-border">
        <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
          <div className="flex flex-col leading-tight min-w-0 flex-1">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted">Tvoja Safe adresa</span>
            <span className="font-mono text-sm text-ink-primary truncate">{safeAddress}</span>
          </div>
          <IconButton aria-label="Kopiraj adresu" size="sm" variant="ghost" onClick={copyAddress}>
            <Copy className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex items-center justify-between gap-3 py-3 first:pt-1 last:pb-1">
          <div className="flex flex-col leading-tight min-w-0 flex-1">
            <span className="text-[11px] uppercase tracking-widest text-ink-muted">Link za dijeljenje</span>
            <span className="font-mono text-xs text-ink-secondary truncate">{deepLink}</span>
          </div>
          <IconButton aria-label="Kopiraj link" size="sm" variant="ghost" onClick={copyDeepLink}>
            <LinkIcon className="h-4 w-4" />
          </IconButton>
        </div>
      </Card>

      <p className="text-xs text-ink-muted text-center">
        QR skeniraš s bilo kojim EVM wallet-om · link otvara DOMOVINA wallet drugog korisnika s prefilled transakcijom.
      </p>
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
