import { useMemo, useState } from 'react';
import { Fingerprint, ShieldCheck, AlertTriangle, ChevronRight, ExternalLink } from 'lucide-react';
import { isAddress, type Address } from 'viem';
import { AddressChip, Button, Card, Field, Input } from '../ui';
import { haptic } from '../lib/haptic';
import { humanizeError } from '../lib/errors';
import { formatEureShort } from '../lib/balances';
import { RP_ID } from '../lib/constants';
import { LEGACY_RP_ID } from '../lib/passkey';
import {
  saltFromCampaignId,
  identifyPasskeyForSafe,
  eureBalanceOf,
  recoverFunds,
  type IdentifyResult,
} from '../lib/recover';

type Phase =
  | { kind: 'form' }
  | { kind: 'identifying' }
  | { kind: 'identified'; identity: IdentifyResult; balance: bigint }
  | { kind: 'withdrawing' }
  | { kind: 'done'; txHash: string }
  | { kind: 'error'; message: string };

function qp(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name) ?? '';
}

/**
 * Standalone fund-recovery flow for counterfactual passkey-owned Safes (e.g. pinka
 * per-campaign Safes). Reachable without an active wallet. Identifies the controlling
 * passkey via P-256 pubkey recovery (no credentialId/localStorage needed), then
 * deploys + withdraws via the relay. See src/lib/recover.ts + ADR 0011/0012.
 */
export function Recover() {
  const [safe, setSafe] = useState(qp('safe'));
  const [campaignId, setCampaignId] = useState(qp('campaign'));
  const rawSalt = qp('salt'); // optional override, set via URL only
  const [destination, setDestination] = useState(qp('to'));
  const [phase, setPhase] = useState<Phase>({ kind: 'form' });

  const saltNonce = useMemo(() => {
    if (rawSalt.trim()) return rawSalt.trim();
    if (campaignId.trim()) return saltFromCampaignId(campaignId.trim());
    return '0';
  }, [rawSalt, campaignId]);

  const safeValid = isAddress(safe.trim());
  const destValid = isAddress(destination.trim());

  async function onIdentify() {
    if (!safeValid) return;
    setPhase({ kind: 'identifying' });
    haptic('tap');
    try {
      const rpIds = Array.from(new Set([RP_ID, LEGACY_RP_ID]));
      const identity = await identifyPasskeyForSafe({
        targetSafe: safe.trim() as Address,
        saltNonce,
        rpIds,
      });
      if (!identity) {
        setPhase({
          kind: 'error',
          message:
            'Odabrani passkey ne kontrolira taj Safe. Provjeri adresu/kampanju, ili pokušaj s drugim passkeyem.',
        });
        return;
      }
      const balance = await eureBalanceOf(safe.trim() as Address);
      haptic('success');
      setPhase({ kind: 'identified', identity, balance });
    } catch (e) {
      haptic('error');
      setPhase({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  async function onWithdraw(identity: IdentifyResult) {
    if (!destValid) return;
    setPhase({ kind: 'withdrawing' });
    haptic('tap');
    try {
      const { txHash } = await recoverFunds({
        identity,
        safe: safe.trim() as Address,
        saltNonce,
        destination: destination.trim() as Address,
      });
      haptic('success');
      setPhase({ kind: 'done', txHash });
    } catch (e) {
      haptic('error');
      setPhase({ kind: 'error', message: humanizeError(e, 'generic') });
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 p-5">
      <div className="flex flex-col gap-1 pt-4">
        <h1 className="text-2xl font-semibold text-ink-primary">Povrat sredstava</h1>
        <p className="text-sm text-ink-secondary">
          Deploya counterfactual Safe i povlači EURe potpisom passkeyem. Za Safeove čiji je
          vlasnik passkey (npr. pinka kampanje).
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-4">
        <Field label="Safe adresa" hint="Adresa na kojoj sjede sredstva.">
          {(id) => (
            <Input
              id={id}
              type="text"
              value={safe}
              onChange={(e) => setSafe(e.target.value)}
              placeholder="0x…"
              invalid={!!safe && !safeValid}
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <Field
          label="Campaign ID"
          hint="Iz pinka URL-a. Izračuna saltNonce. (Ostavi prazno za osobni wallet / upiši raw salt dolje.)"
        >
          {(id) => (
            <Input
              id={id}
              type="text"
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              placeholder="54a40b03-…"
              autoComplete="off"
              spellCheck={false}
            />
          )}
        </Field>
        <div className="rounded-lg bg-surface-sunken/60 px-3 py-2 font-mono text-[11px] text-ink-muted break-all">
          saltNonce: {saltNonce}
        </div>
      </Card>

      {phase.kind === 'form' || phase.kind === 'identifying' ? (
        <Button onClick={onIdentify} size="xl" block disabled={!safeValid || phase.kind === 'identifying'}>
          <Fingerprint className="h-5 w-5" />
          {phase.kind === 'identifying' ? 'Tražim passkey…' : 'Pronađi passkey (Face ID)'}
        </Button>
      ) : null}

      {phase.kind === 'identified' && (
        <>
          <Card padding="md" className="flex flex-col gap-3 border-emerald-500/40">
            <span className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="h-4 w-4" /> Passkey kontrolira ovaj Safe
            </span>
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-muted">Saldo</span>
              <span className="font-semibold text-ink-primary">
                {formatEureShort(phase.balance)} EURe
              </span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-widest text-ink-muted">Signer (owner)</span>
              <AddressChip address={phase.identity.signerAddress} truncate={false} className="max-w-full" />
            </div>
          </Card>

          <Card padding="md" className="flex flex-col gap-4">
            <Field label="Pošalji na adresu" hint="Kamo prebaciti sva sredstva.">
              {(id) => (
                <Input
                  id={id}
                  type="text"
                  value={destination}
                  onChange={(e) => setDestination(e.target.value)}
                  placeholder="0x…"
                  invalid={!!destination && !destValid}
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </Field>
            <Button onClick={() => onWithdraw(phase.identity)} size="xl" block disabled={!destValid || phase.balance <= 0n}>
              <Fingerprint className="h-5 w-5" />
              Povuci {formatEureShort(phase.balance)} EURe (Face ID)
            </Button>
          </Card>
        </>
      )}

      {phase.kind === 'withdrawing' && (
        <Card padding="md" className="text-center text-sm text-ink-secondary">
          Deployam Safe i šaljem sredstva… ovo traje par sekundi.
        </Card>
      )}

      {phase.kind === 'done' && (
        <Card padding="md" className="flex flex-col items-center gap-3 border-emerald-500/40">
          <ShieldCheck className="h-10 w-10 text-emerald-500" />
          <p className="text-center text-sm text-ink-primary">Sredstva poslana. Safe je deployan.</p>
          <a
            href={`https://gnosisscan.io/tx/${phase.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-brand-navy-600 underline"
          >
            Pogledaj transakciju <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Card>
      )}

      {phase.kind === 'error' && (
        <Card padding="md" className="flex flex-col gap-3 border-brand-red-500/40">
          <p className="flex items-start gap-2 text-sm text-brand-red-700" role="alert">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {phase.message}
          </p>
          <Button onClick={() => setPhase({ kind: 'form' })} variant="secondary" size="md" block>
            Pokušaj ponovno <ChevronRight className="h-4 w-4" />
          </Button>
        </Card>
      )}
    </div>
  );
}
