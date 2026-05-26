import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import {
  AlertCircle,
  Check,
  ChevronRight,
  Fingerprint,
  Link2,
  Loader2,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { Address, Hex } from 'viem';
import { isAddress } from 'viem';
import { Button, Card } from '../ui';
import { BrandHeader } from '../components/Brand';
import {
  listKnownPasskeys,
  lookupPasskey,
  pickExistingPasskey,
  recordRpId,
  savePasskey,
  signWithPasskey,
  type PasskeyRecord,
} from '../lib/passkey';
import { encodeWebAuthnSignature, getSafeTxHash } from '../lib/safe';
import { encodeAddOwnerWithThreshold } from '../lib/safeOwners';
import { fetchEureBalances, formatEureShort } from '../lib/balances';
import { relayTx } from '../lib/relay';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { humanizeError } from '../lib/errors';
import { haptic } from '../lib/haptic';
import { postLinkMessage } from '../lib/linking';
import { brand } from '../app/brand';

/**
 * Cross-TLD linking authorize page.
 *
 * Lives at `/link` on the MASTER wallet (wallet.domovina.ai). Tenants
 * (zupa321.hr, sportklub.hr, …) open this page in an iframe or via
 * top-level redirect with the new tenant-side passkey passed as URL
 * params. The master wallet authenticates the user with their existing
 * passkey and signs `addOwnerWithThreshold(newSigner, 1)` on whichever
 * Safe they choose; the new tenant passkey becomes a co-owner of the
 * same Safe, so the user has one balance + one identity across all
 * their wallets.
 *
 * Threshold stays at 1 so either passkey can move funds alone — this
 * matches the established pattern from Settings → Proširi pristup.
 */
type Stage =
  | { kind: 'parsing' } // initial — extracting query params
  | { kind: 'invalid'; reason: string } // bad/missing params → render error + close
  | { kind: 'auth-required' } // user has no local passkey → pickExistingPasskey
  | { kind: 'choose-safe'; passkeys: PasskeyRecord[] } // user has passkeys → show Safe picker
  | { kind: 'confirming'; chosen: PasskeyRecord } // user picked a Safe → final confirm screen
  | { kind: 'signing'; chosen: PasskeyRecord } // signing addOwner with chosen passkey
  | { kind: 'relaying'; chosen: PasskeyRecord } // tx submitted, waiting
  | { kind: 'success'; safeAddress: Address; txHash: Hex }
  | { kind: 'error'; message: string };

type LinkRequest = {
  newSigner: Address;
  newCredentialId: string;
  newPubKeyX: string;
  newPubKeyY: string;
  newRpId: string;
  newLabel?: string;
  returnMode: 'postMessage' | 'redirect';
  parentOrigin?: string;
  returnUrl?: string;
  tenantBrand?: string;
  tenantName?: string;
};

export function Link() {
  const [, setLocation] = useLocation();
  const [stage, setStage] = useState<Stage>({ kind: 'parsing' });
  const req = useMemo(() => parseLinkRequest(window.location.search), []);

  // Boot: validate request + decide initial stage
  useEffect(() => {
    if (!req.ok) {
      setStage({ kind: 'invalid', reason: req.reason });
      return;
    }
    const known = listKnownPasskeys();
    if (known.length === 0) {
      setStage({ kind: 'auth-required' });
    } else {
      setStage({ kind: 'choose-safe', passkeys: known });
    }
  }, [req]);

  // postMessage / redirect plumbing: any time we land in success/error,
  // notify the tenant via the chosen return channel.
  useEffect(() => {
    if (!req.ok) return;
    if (stage.kind === 'success') {
      respondSuccess(req, stage.safeAddress, stage.txHash);
    }
    if (stage.kind === 'error') {
      respondError(req, stage.message);
    }
    if (stage.kind === 'invalid') {
      respondError(req, stage.reason);
    }
  }, [stage, req]);

  async function authenticate() {
    setStage({ kind: 'parsing' }); // reuse the loading state visually
    try {
      const { credentialId } = await pickExistingPasskey();
      let record = lookupPasskey(credentialId);
      if (!record) {
        const remote = await lookupWallet(credentialId);
        if (!remote) {
          setStage({
            kind: 'error',
            message:
              'Ovaj passkey nije registriran. Otvori ga na originalnom uređaju ili kreiraj novi wallet.',
          });
          return;
        }
        const restored: PasskeyRecord = {
          credentialId,
          pubKey: { x: remote.pub_key_x, y: remote.pub_key_y },
          signerAddress: remote.signer_address,
          safeAddress: remote.safe_address,
          createdAt: remote.created_at,
          rpId: remote.rp_id,
        };
        savePasskey(restored);
        record = restored;
      }
      const known = listKnownPasskeys();
      setStage({ kind: 'choose-safe', passkeys: known });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  async function performLink(chosen: PasskeyRecord) {
    if (!req.ok) return;
    if (chosen.pubKey.x === '0' || chosen.pubKey.y === '0') {
      setStage({
        kind: 'error',
        message:
          'Pubkey master passkey-a nije poznat na ovom uređaju. Otvori master wallet na uređaju gdje je passkey kreiran i pokreni linking odande.',
      });
      return;
    }
    if (chosen.signerAddress.toLowerCase() === req.newSigner.toLowerCase()) {
      setStage({
        kind: 'error',
        message: 'Novi signer je identičan postojećem master signer-u — linking nepotreban.',
      });
      return;
    }

    setStage({ kind: 'signing', chosen });
    haptic('tap');

    const addOwnerData = encodeAddOwnerWithThreshold(req.newSigner, 1n);
    let safeTxHash: Hex;
    try {
      const { hash } = await getSafeTxHash(chosen.safeAddress, {
        to: chosen.safeAddress,
        value: 0n,
        data: addOwnerData,
      });
      safeTxHash = hash;
    } catch (e) {
      setStage({ kind: 'error', message: humanizeError(e, 'generic') });
      return;
    }

    let signature: Hex;
    try {
      const assertion = await signWithPasskey(
        chosen.credentialId,
        hexToBytes(safeTxHash),
        recordRpId(chosen),
      );
      signature = encodeWebAuthnSignature({ ...assertion, signerAddress: chosen.signerAddress });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
      return;
    }

    setStage({ kind: 'relaying', chosen });

    const result = await relayTx({
      safeAddress: chosen.safeAddress,
      signerAddress: chosen.signerAddress,
      pubKeyX: chosen.pubKey.x,
      pubKeyY: chosen.pubKey.y,
      to: chosen.safeAddress,
      value: '0',
      data: addOwnerData,
      signature,
    });

    if (!result.ok) {
      haptic('error');
      setStage({
        kind: 'error',
        message: result.rateLimited
          ? 'Dosegao si dnevni limit (5 besplatnih transakcija).'
          : result.error,
      });
      return;
    }

    // Register the new (tenant-side) passkey with the backend, linked to
    // the SAME Safe address — the family endpoint will then surface it
    // as part of this wallet group on every device.
    void registerWalletWithBackend({
      credentialId: req.newCredentialId,
      pubKeyX: req.newPubKeyX,
      pubKeyY: req.newPubKeyY,
      signerAddress: req.newSigner,
      safeAddress: chosen.safeAddress,
      rpId: req.newRpId,
    });

    haptic('success');
    setStage({ kind: 'success', safeAddress: chosen.safeAddress, txHash: result.txHash });
  }

  // ----- render -----

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto pt-safe pb-safe">
      <BrandHeader />
      <main className="flex-1 flex flex-col justify-center gap-6 pb-12">
        {stage.kind === 'parsing' && <ParsingView />}
        {stage.kind === 'invalid' && <ErrorView message={stage.reason} fatal />}
        {stage.kind === 'auth-required' && req.ok && (
          <AuthRequiredView req={req} onAuthenticate={authenticate} />
        )}
        {stage.kind === 'choose-safe' && req.ok && (
          <ChooseSafeView
            req={req}
            passkeys={stage.passkeys}
            onPick={(p) => setStage({ kind: 'confirming', chosen: p })}
          />
        )}
        {stage.kind === 'confirming' && req.ok && (
          <ConfirmView
            req={req}
            chosen={stage.chosen}
            onConfirm={() => performLink(stage.chosen)}
            onCancel={() =>
              setStage({ kind: 'choose-safe', passkeys: listKnownPasskeys() })
            }
          />
        )}
        {stage.kind === 'signing' && (
          <ProgressView icon={<Fingerprint />} title="Otvori Face ID" subtitle="Potpiši addOwner s master passkey-em." />
        )}
        {stage.kind === 'relaying' && (
          <ProgressView icon={<Loader2 className="animate-spin" />} title="Šaljem na Gnosis…" subtitle="Čekam potvrdu transakcije." />
        )}
        {stage.kind === 'success' && req.ok && (
          <SuccessView
            req={req}
            safeAddress={stage.safeAddress}
            txHash={stage.txHash}
            onDone={() => {
              if (req.returnMode === 'redirect' && req.returnUrl) {
                window.location.href = withResultParams(req.returnUrl, {
                  safeAddress: stage.safeAddress,
                  txHash: stage.txHash,
                });
              } else {
                // postMessage path: tenant is in another window; this page
                // can just navigate to home for the user.
                setLocation('/');
              }
            }}
          />
        )}
        {stage.kind === 'error' && <ErrorView message={stage.message} fatal={false} onRetry={() => {
          if (req.ok) setStage({ kind: 'choose-safe', passkeys: listKnownPasskeys() });
        }} />}
      </main>
    </div>
  );
}

// ---------- helpers ----------

function parseLinkRequest(search: string): { ok: true } & LinkRequest | { ok: false; reason: string } {
  const p = new URLSearchParams(search);
  const newSigner = p.get('newSigner');
  const newCredentialId = p.get('newCredentialId');
  const newPubKeyX = p.get('newPubKeyX');
  const newPubKeyY = p.get('newPubKeyY');
  const newRpId = p.get('newRpId');
  const returnMode = p.get('returnMode');
  if (!newSigner || !isAddress(newSigner)) return { ok: false, reason: 'Missing or invalid newSigner.' };
  if (!newCredentialId || !/^0x[0-9a-fA-F]+$/.test(newCredentialId)) return { ok: false, reason: 'Missing or invalid newCredentialId.' };
  if (!newPubKeyX || !/^\d+$/.test(newPubKeyX)) return { ok: false, reason: 'Missing newPubKeyX.' };
  if (!newPubKeyY || !/^\d+$/.test(newPubKeyY)) return { ok: false, reason: 'Missing newPubKeyY.' };
  if (!newRpId) return { ok: false, reason: 'Missing newRpId.' };
  if (returnMode !== 'postMessage' && returnMode !== 'redirect') {
    return { ok: false, reason: 'returnMode must be postMessage or redirect.' };
  }
  return {
    ok: true,
    newSigner: newSigner as Address,
    newCredentialId,
    newPubKeyX,
    newPubKeyY,
    newRpId,
    newLabel: p.get('newLabel') ?? undefined,
    returnMode,
    parentOrigin: p.get('parentOrigin') ?? undefined,
    returnUrl: p.get('returnUrl') ?? undefined,
    tenantBrand: p.get('tenantBrand') ?? undefined,
    tenantName: p.get('tenantName') ?? undefined,
  };
}

function respondSuccess(req: ({ ok: true } & LinkRequest) | { ok: false; reason: string }, safeAddress: Address, txHash: Hex) {
  if (!req.ok) return;
  if (req.returnMode === 'postMessage' && window.parent !== window && req.parentOrigin) {
    postLinkMessage(window.parent, { type: 'link-result', safeAddress, txHash }, req.parentOrigin);
  }
}

function respondError(req: ({ ok: true } & LinkRequest) | { ok: false; reason: string }, error: string) {
  if (!req.ok) return;
  if (req.returnMode === 'postMessage' && window.parent !== window && req.parentOrigin) {
    postLinkMessage(window.parent, { type: 'link-error', error }, req.parentOrigin);
  }
}

function withResultParams(returnUrl: string, result: { safeAddress: Address; txHash: Hex }): string {
  const u = new URL(returnUrl);
  u.searchParams.set('safeAddress', result.safeAddress);
  u.searchParams.set('txHash', result.txHash);
  return u.toString();
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function shortAddr(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// ---------- views ----------

function ParsingView() {
  return (
    <div className="flex flex-col items-center gap-3 py-8">
      <Loader2 className="h-6 w-6 text-ink-muted animate-spin" />
      <p className="text-sm text-ink-secondary">Učitavanje…</p>
    </div>
  );
}

function AuthRequiredView({ req, onAuthenticate }: { req: { ok: true } & LinkRequest; onAuthenticate: () => void }) {
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-brand-primary">
          <Link2 className="h-5 w-5" />
          <h2 className="font-semibold">Linkaj wallet</h2>
        </div>
        <p className="text-sm text-ink-secondary">
          {req.tenantName ?? 'Drugi wallet'} traži pristup tvom {brand.name}-u.
          Otvori postojeći passkey kako bismo znali koji Safe linkamo.
        </p>
      </Card>
      <Button onClick={onAuthenticate} size="xl" block>
        <Fingerprint className="h-5 w-5" />
        Otvori passkey
      </Button>
    </div>
  );
}

function ChooseSafeView({
  req,
  passkeys,
  onPick,
}: {
  req: { ok: true } & LinkRequest;
  passkeys: PasskeyRecord[];
  onPick: (p: PasskeyRecord) => void;
}) {
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  useEffect(() => {
    fetchEureBalances(passkeys.map((p) => p.safeAddress)).then(setBalances).catch(() => {});
  }, [passkeys]);

  // Dedupe Safes — multiple passkeys may share one safeAddress (legacy +
  // parent-RP, etc.) but for linking we only care about the Safe identity
  // and need one passkey per Safe to sign with.
  const seen = new Set<string>();
  const oneCardPerSafe = passkeys.filter((p) => {
    const key = p.safeAddress.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-brand-primary">
          <Link2 className="h-5 w-5" />
          <h2 className="font-semibold">Odaberi Safe za linkanje</h2>
        </div>
        <p className="text-sm text-ink-secondary">
          {req.tenantName ?? 'Drugi wallet'} će dobiti ovlasti potpisivanja za
          odabrani Safe. Threshold ostaje 1 — bilo koji passkey može sam
          poslati novce. Ovaj korak je{' '}
          <span className="font-medium text-ink-primary">jedna onchain transakcija</span>.
        </p>
      </Card>

      <div className="flex flex-col gap-2">
        {oneCardPerSafe.map((p) => (
          <button
            key={p.credentialId}
            type="button"
            onClick={() => onPick(p)}
            className="text-left flex items-center gap-3 rounded-2xl border border-surface-border bg-surface-raised hover:bg-surface-sunken active:scale-[0.99] transition p-4"
          >
            <div className="flex flex-col leading-tight min-w-0 flex-1">
              <span className="text-xs uppercase tracking-widest text-ink-muted truncate">
                {p.keychainName ?? 'Safe'}
              </span>
              <span className="font-mono text-sm text-ink-primary truncate">
                {shortAddr(p.safeAddress)}
              </span>
              <span className="text-[11px] text-ink-secondary tabular-nums">
                {balances.has(p.safeAddress.toLowerCase())
                  ? `${formatEureShort(balances.get(p.safeAddress.toLowerCase())!)} EURe`
                  : '…'}
              </span>
            </div>
            <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}

function ConfirmView({
  req,
  chosen,
  onConfirm,
  onCancel,
}: {
  req: { ok: true } & LinkRequest;
  chosen: PasskeyRecord;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-brand-primary">
          <ShieldCheck className="h-5 w-5" />
          <h2 className="font-semibold">Potvrdi linkanje</h2>
        </div>
        <Row label="Tvoj Safe" value={shortAddr(chosen.safeAddress)} mono />
        <Row label="Novi signer (passkey)" value={shortAddr(req.newSigner)} mono />
        <Row label="Domena novog walleta" value={req.newRpId} />
        {req.newLabel && <Row label="Naziv passkey-a" value={req.newLabel} />}
        <p className="text-xs text-ink-muted pt-1">
          Ovaj signer postaje co-owner tvog Safe-a. Threshold ostaje 1 — sam može potpisati.
          Možeš ga ukloniti kasnije iz Settings → Linked passkeys.
        </p>
      </Card>
      <Button onClick={onConfirm} size="xl" block>
        <Fingerprint className="h-5 w-5" />
        Potpiši i linkaj
      </Button>
      <Button onClick={onCancel} variant="ghost" size="md" block>
        <X className="h-4 w-4" /> Otkaži
      </Button>
    </div>
  );
}

function ProgressView({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 animate-route-enter">
      <div className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-sunken text-brand-primary [&_svg]:h-7 [&_svg]:w-7">
        {icon}
      </div>
      <div className="text-center flex flex-col gap-1">
        <p className="font-semibold text-ink-primary text-lg">{title}</p>
        <p className="text-sm text-ink-secondary max-w-xs">{subtitle}</p>
      </div>
    </div>
  );
}

function SuccessView({
  req,
  safeAddress,
  txHash,
  onDone,
}: {
  req: { ok: true } & LinkRequest;
  safeAddress: Address;
  txHash: Hex;
  onDone: () => void;
}) {
  const returnLabel =
    req.returnMode === 'redirect' ? `Vrati me na ${req.tenantName ?? 'drugi wallet'}` : 'Zatvori';
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white">
          <Check className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold text-ink-primary">Linkano</h2>
        <p className="text-sm text-ink-secondary text-center max-w-sm">
          {req.tenantName ?? 'Drugi wallet'} sada može potpisivati transakcije za tvoj Safe{' '}
          <span className="font-mono">{shortAddr(safeAddress)}</span>.
        </p>
      </div>
      <Card padding="md" className="flex flex-col gap-1">
        <Row
          label="Transakcija"
          value={
            <a
              href={`https://gnosisscan.io/tx/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="underline text-ink-primary"
            >
              {shortAddr(txHash)}
            </a>
          }
          mono
        />
      </Card>
      <Button onClick={onDone} size="xl" block>
        {returnLabel}
      </Button>
    </div>
  );
}

function ErrorView({ message, fatal, onRetry }: { message: string; fatal: boolean; onRetry?: () => void }) {
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="border-brand-red-500/40">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-brand-red-700 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1 min-w-0">
            <p className="text-sm font-medium text-ink-primary">Linkanje neuspješno</p>
            <p className="text-xs text-ink-secondary break-all">{message}</p>
          </div>
        </div>
      </Card>
      {!fatal && onRetry && (
        <Button onClick={onRetry} variant="secondary" size="lg" block>
          Pokušaj ponovo
        </Button>
      )}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-widest text-ink-muted">{label}</span>
      <span className={(mono ? 'font-mono ' : '') + 'text-sm text-ink-primary break-all'}>
        {value}
      </span>
    </div>
  );
}
