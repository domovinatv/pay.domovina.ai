import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { isAddress } from 'viem';
import type { Address } from 'viem';
import { Button, Card } from '../ui';
import { BrandHeader } from '../components/Brand';
import { savePasskey, setActivePasskey, type PasskeyRecord } from '../lib/passkey';
import { registerWalletWithBackend } from '../lib/registry';
import { consumePendingLink } from '../lib/linking';
import { useWalletStore } from '../state/store';

/**
 * Redirect-return target for the cross-TLD linking flow (Safari + any
 * other browser where the iframe path was skipped). Reads the result
 * params placed on the URL by the master wallet's `/link` page, pairs
 * them with the PendingLink the tenant stashed in sessionStorage just
 * before redirecting, and turns the pair into a fully-formed
 * PasskeyRecord that the rest of the app can use natively.
 *
 * Always lives at `/link-callback` on the TENANT. Never opened directly
 * by the user — only as the `returnUrl` of a linking flow.
 */
type State =
  | { kind: 'parsing' }
  | { kind: 'missing-pending' } // sessionStorage entry expired or never stashed
  | { kind: 'invalid'; reason: string }
  | { kind: 'persisting'; safeAddress: Address }
  | { kind: 'done'; safeAddress: Address }
  | { kind: 'error'; message: string };

export function LinkCallback() {
  const [, setLocation] = useLocation();
  const setIdentity = useWalletStore((s) => s.setIdentity);
  const [state, setState] = useState<State>({ kind: 'parsing' });

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const safeAddress = p.get('safeAddress');
    const txHash = p.get('txHash');
    if (!safeAddress || !isAddress(safeAddress)) {
      setState({ kind: 'invalid', reason: 'safeAddress missing or invalid' });
      return;
    }
    if (!txHash || !/^0x[0-9a-fA-F]+$/.test(txHash)) {
      setState({ kind: 'invalid', reason: 'txHash missing or invalid' });
      return;
    }
    const pending = consumePendingLink();
    if (!pending) {
      setState({ kind: 'missing-pending' });
      return;
    }

    setState({ kind: 'persisting', safeAddress: safeAddress as Address });

    const record: PasskeyRecord = {
      credentialId: pending.credentialId,
      pubKey: { x: pending.pubKeyX, y: pending.pubKeyY },
      signerAddress: pending.signerAddress as Address,
      safeAddress: safeAddress as Address,
      createdAt: new Date().toISOString(),
      keychainName: pending.keychainName,
      rpId: pending.rpId,
    };
    savePasskey(record);
    setActivePasskey(record.credentialId);

    // Fire-and-forget: backend already learned of this record via the
    // master wallet's /link page, but we re-register from the tenant side
    // too so cross-device recovery from this RP works (lookupWallet by
    // credentialId returns the same safe_address).
    void registerWalletWithBackend({
      credentialId: pending.credentialId,
      pubKeyX: pending.pubKeyX,
      pubKeyY: pending.pubKeyY,
      signerAddress: pending.signerAddress as Address,
      safeAddress: safeAddress as Address,
      rpId: pending.rpId,
    });

    setIdentity({
      credentialId: record.credentialId,
      signerAddress: record.signerAddress,
      safeAddress: record.safeAddress,
    });

    setState({ kind: 'done', safeAddress: safeAddress as Address });
  }, [setIdentity]);

  // Once persisted, hop the user straight to the wallet home. Tiny delay
  // so the success Card is visible for a beat — pure UX, no state machine
  // dependency on this.
  useEffect(() => {
    if (state.kind === 'done') {
      const t = window.setTimeout(() => setLocation('/'), 1200);
      return () => window.clearTimeout(t);
    }
  }, [state, setLocation]);

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto pt-safe pb-safe">
      <BrandHeader />
      <main className="flex-1 flex flex-col justify-center gap-6 pb-12">
        {state.kind === 'parsing' && <Loading text="Učitavanje rezultata…" />}
        {state.kind === 'persisting' && <Loading text="Spremam linkani Safe…" />}
        {state.kind === 'done' && (
          <Card padding="md" className="flex flex-col items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Check className="h-6 w-6" />
            </div>
            <p className="font-semibold text-ink-primary">Linkano</p>
            <p className="text-sm text-ink-secondary text-center">
              Tvoj Safe je sad dostupan i ovdje. Otvori wallet…
            </p>
          </Card>
        )}
        {state.kind === 'missing-pending' && (
          <ErrorBox
            title="Linking sesija je istekla"
            detail="Nismo pronašli pending passkey u ovoj sesiji. To se dogodi ako je prošlo previše vremena ili ako si linking počeo na drugom uređaju."
            action={
              <Button onClick={() => setLocation('/')} size="lg" block>
                Natrag na početak
              </Button>
            }
          />
        )}
        {state.kind === 'invalid' && (
          <ErrorBox title="Neispravan return" detail={state.reason} action={null} />
        )}
        {state.kind === 'error' && (
          <ErrorBox title="Greška" detail={state.message} action={null} />
        )}
      </main>
    </div>
  );
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-12">
      <Loader2 className="h-6 w-6 text-ink-muted animate-spin" />
      <p className="text-sm text-ink-secondary">{text}</p>
    </div>
  );
}

function ErrorBox({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Card padding="md" className="border-brand-red-500/40">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-brand-red-700 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1 min-w-0">
            <p className="text-sm font-medium text-ink-primary">{title}</p>
            <p className="text-xs text-ink-secondary break-all">{detail}</p>
          </div>
        </div>
      </Card>
      {action}
    </div>
  );
}
