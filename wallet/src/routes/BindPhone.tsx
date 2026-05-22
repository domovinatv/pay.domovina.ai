import { useEffect, useRef, useState } from 'react';
import { BrandHeader } from '../components/Brand';
import { useWalletStore } from '../state/store';
import { otpQrUrl, startOtpVerification, subscribeOtp, type OtpPollResponse } from '../lib/otp';
import {
  bindPhone as bindPhoneOnBackend,
  lookupWallet,
  registerWalletWithBackend,
} from '../lib/registry';
import { getActivePasskey } from '../lib/passkey';
import { RP_ID } from '../lib/constants';

type Stage =
  | { kind: 'idle' }
  | { kind: 'sms-sent'; verification: OtpPollResponse }
  | { kind: 'verified'; verification: OtpPollResponse }
  | { kind: 'binding' }
  | { kind: 'success'; phone: string }
  | { kind: 'expired' }
  | { kind: 'error'; message: string };

export function BindPhone() {
  const { credentialId, setScreen } = useWalletStore();
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

    // Backward compat: walletovi kreirani prije Phase 3 nisu u registry-u.
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
        rpId: RP_ID,
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
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto">
      <BrandHeader />

      <main className="flex-1 flex flex-col gap-6">
        <button onClick={() => setScreen('wallet')} className="self-start text-sm text-gray-500">
          ← natrag
        </button>

        <section className="card space-y-4">
          <h2 className="text-xl font-semibold">Recovery telefon</h2>
          <p className="text-sm text-gray-500">
            Poveži broj mobitela kako bi mogao vratiti pristup walletu ako izgubiš ovaj uređaj.
            Šaljemo ti SMS upute, ali <strong>ti šalješ SMS našem broju</strong> — tako da se
            dokaže da kontroliraš taj telefon. Mi nikad ne čuvamo tvoj broj u našoj bazi, samo
            njegov hash.
          </p>

          {stage.kind === 'idle' && (
            <button onClick={start} className="btn-primary w-full">
              Pokreni verifikaciju
            </button>
          )}

          {stage.kind === 'sms-sent' && (
            <SmsInstructions verification={stage.verification} />
          )}

          {stage.kind === 'verified' && (
            <div className="text-sm text-green-700 bg-green-50 rounded-xl p-3 text-center">
              SMS primljen. Spremam…
            </div>
          )}

          {stage.kind === 'binding' && (
            <div className="text-sm text-gray-500 bg-gray-50 rounded-xl p-3 text-center">
              Vezivanje broja za wallet…
            </div>
          )}

          {stage.kind === 'success' && (
            <div className="space-y-3">
              <div className="text-sm text-green-700 bg-green-50 rounded-xl p-3 text-center">
                Telefon povezan ✓<br />
                <span className="font-mono text-xs">{stage.phone}</span>
              </div>
              <button onClick={() => setScreen('wallet')} className="btn-primary w-full">
                Natrag na wallet
              </button>
            </div>
          )}

          {stage.kind === 'expired' && (
            <div className="space-y-3">
              <div className="text-sm text-domovina-red bg-red-50 rounded-xl p-3 text-center">
                Verifikacija je istekla.
              </div>
              <button onClick={start} className="btn-primary w-full">
                Pokušaj ponovno
              </button>
            </div>
          )}

          {stage.kind === 'error' && (
            <div className="space-y-3">
              <div className="text-sm text-domovina-red bg-red-50 rounded-xl p-3 text-center">
                {stage.message}
              </div>
              <button onClick={start} className="btn-primary w-full">
                Pokušaj ponovno
              </button>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function SmsInstructions({ verification }: { verification: OtpPollResponse }) {
  const smsUri = `sms:${verification.gateway_number}?body=${encodeURIComponent(verification.code)}`;
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-gray-50 p-4 space-y-2">
        <div className="text-xs uppercase tracking-widest text-gray-400">SMS na broj</div>
        <div className="font-mono text-lg font-semibold">{verification.gateway_number}</div>
        <div className="text-xs uppercase tracking-widest text-gray-400 pt-2">Tekst poruke</div>
        <div className="font-mono text-3xl font-bold tracking-widest text-center py-2">
          {verification.code}
        </div>
      </div>

      <a href={smsUri} className="btn-primary w-full">
        Otvori SMS aplikaciju
      </a>

      <details className="text-xs text-gray-500">
        <summary className="cursor-pointer text-center">Na desktopu? Skeniraj QR mobitelom</summary>
        <div className="mt-3 flex justify-center">
          <img src={otpQrUrl(verification.id)} alt="OTP QR" className="w-48 h-48" />
        </div>
      </details>

      <div className="text-xs text-center text-gray-400">
        Čekamo SMS… Status se osvježava automatski.
      </div>
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
