import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { MessageSquare, ShieldCheck, RefreshCw } from 'lucide-react';
import { Button, Card, Section, StatusPill } from '../ui';
import { useWalletStore } from '../state/store';
import {
  otpQrUrl,
  otpSmsBody,
  startOtpVerification,
  subscribeOtp,
  type OtpPollResponse,
} from '../lib/otp';
import {
  bindPhone as bindPhoneOnBackend,
  lookupWallet,
  registerWalletWithBackend,
} from '../lib/registry';
import { getActivePasskey, recordRpId } from '../lib/passkey';

type Stage =
  | { kind: 'idle' }
  | { kind: 'sms-sent'; verification: OtpPollResponse }
  | { kind: 'verified'; verification: OtpPollResponse }
  | { kind: 'binding' }
  | { kind: 'success'; phone: string }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

export function BindPhone() {
  const { credentialId } = useWalletStore();
  const [, setLocation] = useLocation();
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  async function start() {
    setStage({ kind: 'idle' });
    try {
      const v = await startOtpVerification('wallet_bind_phone');
      setStage({ kind: 'sms-sent', verification: { ...v, verified_at: null, verified_phone: null } });
      stopRef.current?.();
      stopRef.current = subscribeOtp(v.id, (update) => {
        if (update.status === 'verified' && update.verified_phone) {
          stopRef.current?.();
          setStage({ kind: 'verified', verification: update });
          void completeBind(update);
        } else if (update.status === 'expired') {
          stopRef.current?.();
          setStage({ kind: 'expired' });
        }
      });
    } catch (e) {
      setStage({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function completeBind(verification: OtpPollResponse) {
    if (!credentialId) {
      setStage({ kind: 'error', message: 'No active wallet' });
      return;
    }
    setStage({ kind: 'binding' });

    // Backward compat: pre-Phase 3 walletovi nisu u registry-u.
    // Ensure-aj registraciju prije bind-phone calla — inače backend vraća
    // wallet_not_found i OTP verification je već "consumed".
    const existing = await lookupWallet(credentialId);
    if (!existing) {
      const passkey = getActivePasskey();
      const x = passkey?.pubKey?.x;
      const y = passkey?.pubKey?.y;
      if (!passkey || !x || !y || x === '0' || y === '0') {
        setStage({
          kind: 'error',
          message:
            'Wallet nije moguće registrirati — nedostaju pubkey podaci. ' +
            'Otvori wallet na izvornom uređaju i pokušaj ponovno.',
        });
        return;
      }
      const registered = await registerWalletWithBackend({
        credentialId: passkey.credentialId,
        pubKeyX: x,
        pubKeyY: y,
        signerAddress: passkey.signerAddress,
        safeAddress: passkey.safeAddress,
        rpId: recordRpId(passkey),
      });
      if (!registered) {
        setStage({
          kind: 'error',
          message: 'Wallet registracija je pala — provjeri konzolu za detalje.',
        });
        return;
      }
    }

    const result = await bindPhoneOnBackend(credentialId, verification.id);
    if (!result.ok) {
      setStage({ kind: 'error', message: humanizeError(result.error) });
      return;
    }
    setStage({ kind: 'success', phone: verification.verified_phone ?? '' });
  }

  return (
    <Section
      title="Potvrda broja mobitela"
      description="Ti šalješ SMS našem broju — tako dokazuješ da si vlasnik svog broja. Svaka potvrda kroz vrijeme gradi reputaciju da iza walleta stoji stvarna osoba, a ne bot. Mi čuvamo samo hash, ne broj."
    >
      {stage.kind === 'idle' && (
        <Card className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <p className="text-sm text-ink-secondary">
              Potvrdi da si vlasnik svog broja mobitela. Ovo nije recovery — wallet i dalje
              kontrolira isključivo tvoj passkey. Verifikaciju možeš ponavljati i svaka nova
              potvrda jača reputaciju tvog walleta.
            </p>
          </div>
          <Button onClick={start} size="xl" block>
            Pokreni verifikaciju
          </Button>
        </Card>
      )}

      {stage.kind === 'sms-sent' && <SmsInstructions verification={stage.verification} />}

      {stage.kind === 'verified' && (
        <Card padding="md" className="flex items-center justify-center gap-2">
          <StatusPill tone="info" dot pulse>
            SMS primljen
          </StatusPill>
          <span className="text-sm text-ink-secondary">spremam…</span>
        </Card>
      )}

      {stage.kind === 'binding' && (
        <Card padding="md" className="flex items-center justify-center gap-2">
          <RefreshCw className="h-4 w-4 animate-spin text-ink-muted" />
          <span className="text-sm text-ink-secondary">Vežem broj za wallet…</span>
        </Card>
      )}

      {stage.kind === 'success' && (
        <Card
          padding="lg"
          elevation="elevated"
          className="flex flex-col items-center gap-4 border-emerald-200 dark:border-emerald-900/40"
        >
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div className="text-center">
            <p className="font-semibold text-ink-primary">Broj potvrđen</p>
            <p className="font-mono text-sm text-ink-secondary">{stage.phone}</p>
          </div>
          <Button onClick={() => setLocation('/')} size="lg" block>
            Natrag na wallet
          </Button>
        </Card>
      )}

      {stage.kind === 'expired' && (
        <Card className="flex flex-col gap-3">
          <p className="text-sm text-ink-secondary text-center">Verifikacija je istekla.</p>
          <Button onClick={start} size="lg" block>
            Pokušaj ponovno
          </Button>
        </Card>
      )}

      {stage.kind === 'error' && (
        <Card className="flex flex-col gap-3 border-brand-red-500/40">
          <p className="text-sm text-brand-red-700 text-center" role="alert">
            {stage.message}
          </p>
          <Button onClick={start} size="lg" block>
            Pokušaj ponovno
          </Button>
        </Card>
      )}
    </Section>
  );
}

function SmsInstructions({ verification }: { verification: OtpPollResponse }) {
  // Prefill the SAME friendly copy the QR encodes (server-built sms_body) so the
  // native SMS app itself tells the user to come back to the browser after send.
  const body = verification.sms_body ?? otpSmsBody(verification.code);
  const smsUri = `sms:${verification.gateway_number}?body=${encodeURIComponent(body)}`;
  return (
    <div className="flex flex-col gap-4">
      <Card padding="lg" elevation="elevated" className="flex flex-col gap-5">
        <div className="flex items-center justify-center">
          <StatusPill tone="warning" dot pulse>
            Čekam SMS…
          </StatusPill>
        </div>

        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted">Pošalji SMS na</span>
          <a
            href={`tel:${verification.gateway_number}`}
            className="font-mono text-xl font-semibold text-ink-primary tabular"
          >
            {verification.gateway_number}
          </a>
        </div>

        <div className="flex flex-col items-center gap-1">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted">Tekst poruke</span>
          <div className="font-mono text-3xl font-bold tracking-[0.2em] text-ink-primary tabular">
            {verification.code}
          </div>
        </div>

        <a
          href={smsUri}
          className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-navy-700 hover:bg-brand-navy-600 dark:bg-brand-navy-400 dark:text-brand-navy-900 dark:hover:bg-brand-navy-300 text-white font-semibold px-6 py-4 text-base shadow-card active:scale-[0.97] transition"
        >
          <MessageSquare className="h-5 w-5" />
          Otvori SMS aplikaciju
        </a>
      </Card>

      <details className="text-xs text-ink-muted">
        <summary className="cursor-pointer text-center">Na desktopu? Skeniraj QR mobitelom</summary>
        <div className="mt-3 flex justify-center">
          <img
            src={otpQrUrl(verification.id)}
            alt="OTP QR"
            className="w-48 h-48 rounded-2xl bg-white p-2"
          />
        </div>
      </details>
    </div>
  );
}

function humanizeError(code: string): string {
  switch (code) {
    case 'otp_not_verified':
      return 'OTP još nije potvrđen.';
    case 'otp_already_used':
      return 'Ovaj OTP je već iskorišten — pokreni novu verifikaciju.';
    case 'otp_unreachable':
      return 'Ne mogu doći do otp.domovina.ai servisa. Pokušaj kasnije.';
    case 'wallet_not_found':
      return 'Wallet nije registriran na serveru — pokreni Create wallet ponovno.';
    default:
      return code;
  }
}
