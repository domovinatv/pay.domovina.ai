import { useEffect, useMemo, useState } from 'react';
import {
  KeyRound,
  ShieldCheck,
  Zap,
  Plus,
  RefreshCw,
  Sparkles,
  Fingerprint,
  ChevronRight,
  Archive,
  AlertTriangle,
  Check,
} from 'lucide-react';
import type { Address } from 'viem';
import { BrandHeader } from '../components/Brand';
import { AddressChip, Button, Card, Field, Input } from '../ui';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';
import { humanizeError } from '../lib/errors';
import {
  archivePasskey,
  createPasskey,
  listKnownPasskeys,
  lookupPasskey,
  pickExistingPasskey,
  purposeToKeychainName,
  savePasskey,
  setActivePasskey,
  suggestPasskeyName,
  PASSKEY_PURPOSE_SUGGESTIONS,
  type PasskeyRecord,
} from '../lib/passkey';
import { fetchEureBalances, formatEureShort } from '../lib/balances';
import { predictSignerAddress, predictSafeAddress } from '../lib/safe';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { brand } from '../app/brand';
import {
  buildLinkAuthorizeUrl,
  isSafariLike,
  parseLinkMessage,
  stashPendingLink,
} from '../lib/linking';
import { getLinkTargets } from '../app/brand';
import type { BrandConfig } from '../brands/_shared/types';
import { Link2 } from 'lucide-react';

/** Above this count we surface a discouragement hint inline and gate
 * creation behind an explicit confirmation step. Three is the threshold
 * where the wallet list stops feeling intentional and starts feeling
 * like the user is accidentally accumulating fragments. */
const MANY_WALLETS_THRESHOLD = 3;

type Stage =
  | { kind: 'welcome' }
  | { kind: 'welcome-known'; known: PasskeyRecord[] }
  | { kind: 'confirm-create-many'; existingCount: number }
  | { kind: 'confirm-archive'; record: PasskeyRecord }
  | { kind: 'naming'; suggestedName: string }
  | { kind: 'creating' }
  | { kind: 'opening' }
  | { kind: 'pick-link-target'; targets: BrandConfig[] } // N-to-N: which peer authorizes
  | { kind: 'linking-create'; targetDomain: string; targetName: string } // enrolling the new requester-side passkey
  | { kind: 'linking-bridge'; iframeUrl: string; targetOrigin: string } // iframe path
  | { kind: 'linking-redirected' } // redirect path: page about to navigate
  | { kind: 'created'; record: PasskeyRecord }
  | { kind: 'error'; message: string };

export function Landing() {
  const setIdentity = useWalletStore((s) => s.setIdentity);
  const [stage, setStage] = useState<Stage>(() => {
    const known = listKnownPasskeys();
    return known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' };
  });

  // Refresh the known list whenever we return to a welcome stage (e.g. after
  // signing out, this component remounts; this also handles cancelled flows).
  useEffect(() => {
    if (stage.kind === 'welcome' || stage.kind === 'welcome-known') {
      const known = listKnownPasskeys();
      if (known.length > 0 && stage.kind !== 'welcome-known') {
        setStage({ kind: 'welcome-known', known });
      } else if (known.length === 0 && stage.kind !== 'welcome') {
        setStage({ kind: 'welcome' });
      }
    }
  }, [stage.kind]);

  function startCreate() {
    haptic('tap');
    const known = listKnownPasskeys();
    if (known.length >= MANY_WALLETS_THRESHOLD) {
      // User already has a pile of wallets; pause and explain before the
      // Face ID prompt fires. They can still create — just with intent.
      setStage({ kind: 'confirm-create-many', existingCount: known.length });
      return;
    }
    setStage({ kind: 'naming', suggestedName: suggestPasskeyName() });
  }

  function proceedToNaming() {
    haptic('tap');
    setStage({ kind: 'naming', suggestedName: suggestPasskeyName() });
  }

  function requestArchive(record: PasskeyRecord) {
    haptic('tap');
    setStage({ kind: 'confirm-archive', record });
  }

  function confirmArchive(record: PasskeyRecord) {
    haptic('success');
    archivePasskey(record.credentialId);
    const known = listKnownPasskeys();
    setStage(known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' });
  }

  async function confirmCreate(chosenName: string) {
    setStage({ kind: 'creating' });
    haptic('tap');
    try {
      const { credentialId, pubKey, keychainName, rpId } = await createPasskey(chosenName);
      const signerAddress = await predictSignerAddress(pubKey);
      const safeAddress = await predictSafeAddress(signerAddress);

      const record: PasskeyRecord = {
        credentialId,
        pubKey: { x: pubKey.x.toString(), y: pubKey.y.toString() },
        signerAddress,
        safeAddress,
        createdAt: new Date().toISOString(),
        keychainName,
        rpId,
      };
      savePasskey(record);

      void registerWalletWithBackend({
        credentialId,
        pubKeyX: pubKey.x.toString(),
        pubKeyY: pubKey.y.toString(),
        signerAddress,
        safeAddress,
        rpId,
      });

      haptic('success');
      setStage({ kind: 'created', record });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  async function openKnown(record: PasskeyRecord) {
    haptic('tap');
    // No WebAuthn re-auth on open — Send requires Face ID anyway, and skipping
    // it avoids an iOS race where Keychain leaves credentials in a "pending"
    // state. See [[feedback-webauthn-ios-pending-race]].
    const healed = await healStubPubKey(record);
    setActivePasskey(healed.credentialId);
    setIdentity({
      credentialId: healed.credentialId,
      signerAddress: healed.signerAddress,
      safeAddress: healed.safeAddress,
    });
  }

  async function openExisting(opts: { legacyOnly?: boolean } = {}) {
    setStage({ kind: 'opening' });
    haptic('tap');
    try {
      const { credentialId } = await pickExistingPasskey(opts);
      let record = lookupPasskey(credentialId);
      if (!record) {
        // Cross-device fallback: passkey synced via iCloud/Google but no
        // localStorage on this device. Try the backend registry.
        const remote = await lookupWallet(credentialId);
        if (!remote) {
          throw new Error(
            'Ovaj passkey nije registriran ni lokalno ni na serveru. Otvori na izvornom uređaju ili kreiraj novi wallet.',
          );
        }
        // pubKey + rpId come from the backend registry — without them Send
        // would deploy the wrong signer (stub-0 guard in functions/api/relay.ts)
        // and signWithPasskey would call get() under the wrong RP scope.
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
      } else {
        // Existing record may carry a stub pubKey from a pre-fix cross-device
        // restore (when publicWalletView did not yet return pub_key_x/y).
        // Heal it now so Send works without the user needing to clear data.
        record = await healStubPubKey(record);
      }
      setActivePasskey(record.credentialId);
      setIdentity({
        credentialId: record.credentialId,
        signerAddress: record.signerAddress,
        safeAddress: record.safeAddress,
      });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  function enterWalletAfterCreate(record: PasskeyRecord) {
    setActivePasskey(record.credentialId);
    setIdentity({
      credentialId: record.credentialId,
      signerAddress: record.signerAddress,
      safeAddress: record.safeAddress,
    });
  }

  function resetToWelcome() {
    const known = listKnownPasskeys();
    setStage(known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' });
  }

  async function openLegacy() {
    await openExisting({ legacyOnly: true });
  }

  /**
   * Cross-TLD linking entry point. PEER-TO-PEER: any brand build can be
   * the requester, any other brand can be the authorizer. Step 1 shows
   * a picker of known sibling brands so the user chooses which existing
   * wallet they want to grow (e.g. zupa user wants to link to their
   * sportklub Safe).
   */
  function pickLinkTarget() {
    haptic('tap');
    const targets = getLinkTargets();
    setStage({ kind: 'pick-link-target', targets });
  }

  /**
   * After the target peer is chosen: enroll a fresh passkey under THIS
   * build's RP, then open the authorizer's `/link` page so the user
   * can sign addOwnerWithThreshold on whichever Safe they choose there.
   * Iframe path on non-Safari, redirect path on Safari (ITP partitions
   * third-party iframe storage on Safari, breaking WebAuthn there).
   */
  async function startLinkExisting(target: { domain: string; name: string }) {
    haptic('tap');
    setStage({ kind: 'linking-create', targetDomain: target.domain, targetName: target.name });
    try {
      // 1. Enroll a new passkey under this tenant's RP.
      const { credentialId, pubKey, keychainName, rpId } = await createPasskey(
        suggestPasskeyName(),
      );
      const signerAddress = await predictSignerAddress(pubKey);

      const pubKeyX = pubKey.x.toString();
      const pubKeyY = pubKey.y.toString();

      const safariPath = isSafariLike();

      if (safariPath) {
        // Redirect path: stash the new passkey in sessionStorage so
        // /link-callback can read it back after the round-trip, then
        // hop to the chosen target's authorize page.
        stashPendingLink({
          credentialId,
          pubKeyX,
          pubKeyY,
          signerAddress,
          keychainName,
          rpId,
          stashedAt: Date.now(),
        });
        const returnUrl = `${window.location.origin}/link-callback`;
        const url = buildLinkAuthorizeUrl({
          targetDomain: target.domain,
          newSigner: signerAddress as Address,
          newCredentialId: credentialId,
          newPubKeyX: pubKeyX,
          newPubKeyY: pubKeyY,
          newRpId: rpId,
          newLabel: keychainName,
          returnMode: 'redirect',
          returnUrl,
        });
        setStage({ kind: 'linking-redirected' });
        window.location.href = url;
        return;
      }

      // iframe path: render an iframe to the chosen target's authorize
      // page, listen for the postMessage result, persist the PasskeyRecord
      // when it arrives.
      const iframeUrl = buildLinkAuthorizeUrl({
        targetDomain: target.domain,
        newSigner: signerAddress as Address,
        newCredentialId: credentialId,
        newPubKeyX: pubKeyX,
        newPubKeyY: pubKeyY,
        newRpId: rpId,
        newLabel: keychainName,
        returnMode: 'postMessage',
        parentOrigin: window.location.origin,
      });
      const targetOrigin = `https://${target.domain}`;

      // We persist the new passkey to localStorage as soon as the target
      // peer confirms the link — see the message handler below.
      function handler(event: MessageEvent) {
        if (event.origin !== targetOrigin) return;
        const msg = parseLinkMessage(event.data);
        if (!msg) return;
        if (msg.type === 'link-result') {
          window.removeEventListener('message', handler);
          const record: PasskeyRecord = {
            credentialId,
            pubKey: { x: pubKeyX, y: pubKeyY },
            signerAddress: signerAddress as Address,
            safeAddress: msg.safeAddress,
            createdAt: new Date().toISOString(),
            keychainName,
            rpId,
          };
          savePasskey(record);
          void registerWalletWithBackend({
            credentialId,
            pubKeyX,
            pubKeyY,
            signerAddress: signerAddress as Address,
            safeAddress: msg.safeAddress,
            rpId,
          });
          haptic('success');
          setStage({ kind: 'created', record });
        } else if (msg.type === 'link-error') {
          window.removeEventListener('message', handler);
          haptic('error');
          setStage({ kind: 'error', message: msg.error });
        }
      }
      window.addEventListener('message', handler);
      setStage({ kind: 'linking-bridge', iframeUrl, targetOrigin });
    } catch (e) {
      haptic('error');
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto pt-safe pb-safe">
      <BrandHeader />

      <main className="flex-1 flex flex-col justify-center gap-8 pb-12">
        {stage.kind === 'welcome' && (
          <WelcomeView
            onCreate={startCreate}
            onCrossDevice={() => openExisting()}
            onLegacy={openLegacy}
            onLinkExisting={pickLinkTarget}
          />
        )}

        {stage.kind === 'welcome-known' && (
          <WelcomeKnownView
            known={stage.known}
            onOpenKnown={openKnown}
            onCreate={startCreate}
            onCrossDevice={() => openExisting()}
            onLegacy={openLegacy}
            onLinkExisting={pickLinkTarget}
            onRequestArchive={requestArchive}
          />
        )}

        {stage.kind === 'pick-link-target' && (
          <PickLinkTargetView
            targets={stage.targets}
            onPick={(t) => startLinkExisting({ domain: t.domain, name: t.name })}
            onPickCustom={(domain) =>
              startLinkExisting({ domain, name: domain })
            }
            onCancel={resetToWelcome}
          />
        )}

        {stage.kind === 'linking-create' && (
          <ProgressInline
            title="Otvori Face ID"
            subtitle={`Kreiram passkey ovog walleta prije linkanja na ${stage.targetName}.`}
          />
        )}

        {stage.kind === 'linking-bridge' && (
          <LinkingBridgeView iframeUrl={stage.iframeUrl} onCancel={resetToWelcome} />
        )}

        {stage.kind === 'linking-redirected' && (
          <ProgressInline
            title="Preusmjeravam na DOMOVINA Wallet…"
            subtitle="Tamo ćeš odobriti linkanje pa te vraćamo natrag."
          />
        )}

        {stage.kind === 'confirm-create-many' && (
          <ConfirmCreateManyView
            existingCount={stage.existingCount}
            onCancel={resetToWelcome}
            onConfirm={proceedToNaming}
          />
        )}

        {stage.kind === 'confirm-archive' && (
          <ConfirmArchiveView
            record={stage.record}
            onCancel={resetToWelcome}
            onConfirm={() => confirmArchive(stage.record)}
          />
        )}

        {stage.kind === 'naming' && (
          <NamingView
            suggestedName={stage.suggestedName}
            onCancel={resetToWelcome}
            onConfirm={confirmCreate}
          />
        )}

        {stage.kind === 'creating' && <CreatingView />}

        {stage.kind === 'opening' && <OpeningView />}

        {stage.kind === 'created' && (
          <CreatedView record={stage.record} onEnter={() => enterWalletAfterCreate(stage.record)} />
        )}

        {stage.kind === 'error' && (
          <ErrorView message={stage.message} onRetry={resetToWelcome} />
        )}
      </main>
    </div>
  );
}

/**
 * If a PasskeyRecord still carries the ('0','0') stub from a pre-publicWalletView
 * cross-device restore, hit the backend, populate the real pubKey + rpId, and
 * persist. Idempotent; bails out cleanly if the backend is unreachable so we
 * never block wallet open on a transient network error.
 */
async function healStubPubKey(record: PasskeyRecord): Promise<PasskeyRecord> {
  if (record.pubKey.x !== '0' && record.pubKey.y !== '0') return record;
  console.log('[Landing] stub pubKey detected — refetching from backend', {
    credentialId: record.credentialId.slice(0, 14) + '…',
  });
  try {
    const remote = await lookupWallet(record.credentialId);
    if (!remote || remote.pub_key_x === '0' || remote.pub_key_y === '0') {
      console.warn('[Landing] backend lookup did not yield a real pubKey; leaving stub');
      return record;
    }
    const healed: PasskeyRecord = {
      ...record,
      pubKey: { x: remote.pub_key_x, y: remote.pub_key_y },
      rpId: record.rpId ?? remote.rp_id,
    };
    savePasskey(healed);
    return healed;
  } catch (e) {
    console.warn('[Landing] stub pubKey heal failed', e);
    return record;
  }
}

function WelcomeView({
  onCreate,
  onCrossDevice,
  onLegacy,
  onLinkExisting,
}: {
  onCreate: () => void;
  onCrossDevice: () => void;
  onLegacy: () => void;
  /** Only set on TENANT builds (non-default brand). undefined on master. */
  onLinkExisting?: () => void;
}) {
  return (
    <div className="flex flex-col gap-8 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <h2 className="text-2xl font-semibold text-ink-primary">{brand.copy.welcomeTitle}</h2>
        <p className="text-ink-secondary">{brand.copy.welcomeSubtitle}</p>
      </div>

      <Card padding="md" className="flex flex-col gap-3">
        <FeatureRow
          icon={<KeyRound />}
          title="Passkey, ne ključ"
          description="Tvoj passkey živi u iCloud Keychain / 1Password."
        />
        <FeatureRow
          icon={<ShieldCheck />}
          title="Mi ne vidimo ništa"
          description="Sve potpise radi tvoj Face ID lokalno."
        />
        <FeatureRow
          icon={<Zap />}
          title="Gas plaćamo mi"
          description="5 besplatnih transakcija dnevno."
        />
      </Card>

      <div className="flex flex-col gap-3">
        <Button onClick={onCreate} size="xl" block>
          <Plus className="h-5 w-5" />
          Kreiraj wallet
        </Button>
        <Button onClick={onCrossDevice} variant="secondary" size="lg" block>
          <RefreshCw className="h-4 w-4" />
          Otvori postojeći passkey
        </Button>
        {onLinkExisting && (
          <Button onClick={onLinkExisting} variant="secondary" size="lg" block>
            <Link2 className="h-4 w-4" />
            Linkaj postojeći wallet
          </Button>
        )}
        <Button onClick={onLegacy} variant="ghost" size="sm" block>
          Ne vidim ga — stari passkey (wallet.domovina.ai)
        </Button>
      </div>
    </div>
  );
}

function WelcomeKnownView({
  known,
  onOpenKnown,
  onCreate,
  onCrossDevice,
  onLegacy,
  onLinkExisting,
  onRequestArchive,
}: {
  known: PasskeyRecord[];
  onOpenKnown: (record: PasskeyRecord) => void;
  onCreate: () => void;
  onCrossDevice: () => void;
  onLegacy: () => void;
  /** Only set on TENANT builds. undefined on master. */
  onLinkExisting?: () => void;
  onRequestArchive: (record: PasskeyRecord) => void;
}) {
  const activeCred = useWalletStore((s) => s.credentialId);
  const balances = useEureBalances(known);

  // Sort: active wallet pinned to top, then by balance desc, then by
  // createdAt desc so newer wallets are above older ones at equal balance.
  const sorted = useMemo(() => {
    const list = [...known];
    list.sort((a, b) => {
      if (a.credentialId === activeCred) return -1;
      if (b.credentialId === activeCred) return 1;
      const ba = balances.get(a.safeAddress.toLowerCase()) ?? 0n;
      const bb = balances.get(b.safeAddress.toLowerCase()) ?? 0n;
      if (ba !== bb) return bb > ba ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return list;
  }, [known, activeCred, balances]);

  const tooManyHint =
    known.length >= MANY_WALLETS_THRESHOLD ? (
      <p className="text-xs text-ink-muted text-center px-2 pb-1">
        Imaš {known.length} waleta na ovom uređaju. Za većinu ljudi jedan je dovoljan —{' '}
        koristi <span className="font-medium text-ink-secondary">Arhiviraj</span> da skineš nepotrebne s liste
        (passkey i novci ostaju netaknuti).
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-5 animate-route-enter">
      <div className="text-center flex flex-col gap-1">
        <h2 className="text-2xl font-semibold text-ink-primary">Dobrodošao natrag</h2>
        <p className="text-sm text-ink-secondary">
          {known.length === 1
            ? 'Wallet je spreman za otvaranje.'
            : 'Odaberi wallet koji želiš otvoriti.'}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {sorted.map((record) => (
          <WalletCard
            key={record.credentialId}
            record={record}
            balance={balances.get(record.safeAddress.toLowerCase())}
            active={record.credentialId === activeCred}
            onOpen={() => onOpenKnown(record)}
            onArchive={() => onRequestArchive(record)}
          />
        ))}
      </div>

      {tooManyHint}

      <div className="flex flex-col gap-2 pt-1">
        <Button onClick={onCreate} variant="ghost" size="md" block>
          <Plus className="h-4 w-4" />
          Kreiraj novi wallet
        </Button>
        <Button onClick={onCrossDevice} variant="ghost" size="sm" block>
          <RefreshCw className="h-4 w-4" />
          Otvori drugi passkey (iCloud / Google sync)
        </Button>
        {onLinkExisting && (
          <Button onClick={onLinkExisting} variant="ghost" size="sm" block>
            <Link2 className="h-4 w-4" />
            Linkaj još jedan wallet (drugi domen)
          </Button>
        )}
        <Button onClick={onLegacy} variant="ghost" size="sm" block>
          Ne vidim ga — stari passkey (wallet.domovina.ai)
        </Button>
      </div>
    </div>
  );
}

/**
 * Fetch EURe balances for the given passkey records via Multicall3. Returns
 * a map keyed by lowercased safeAddress so callers can render the value
 * inline. Refetches whenever the list of addresses changes (e.g. user
 * archives one).
 */
function useEureBalances(known: PasskeyRecord[]): Map<string, bigint> {
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  const addressKey = known.map((r) => r.safeAddress.toLowerCase()).sort().join(',');
  useEffect(() => {
    let cancelled = false;
    if (known.length === 0) {
      setBalances(new Map());
      return;
    }
    fetchEureBalances(known.map((r) => r.safeAddress))
      .then((m) => {
        if (!cancelled) setBalances(m);
      })
      .catch((e) => {
        console.warn('[Landing] balance fetch failed', e);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressKey]);
  return balances;
}

function WalletCard({
  record,
  balance,
  active,
  onOpen,
  onArchive,
}: {
  record: PasskeyRecord;
  balance: bigint | undefined;
  active: boolean;
  onOpen: () => void;
  onArchive: () => void;
}) {
  return (
    <div
      className={
        'group relative rounded-3xl border shadow-card transition ' +
        (active
          ? 'bg-brand-navy-50 border-brand-navy-200 dark:bg-brand-navy-900/30 dark:border-brand-navy-700'
          : 'bg-surface-raised border-surface-border hover:bg-surface-sunken')
      }
    >
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left flex items-center gap-3 p-4 active:scale-[0.99] transition"
      >
        <div
          aria-hidden
          className="h-12 w-12 rounded-2xl shrink-0 ring-1 ring-black/5"
          style={{ background: gradientFor(record.safeAddress) }}
        />
        <div className="flex flex-col leading-tight min-w-0 flex-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs uppercase tracking-widest text-ink-muted truncate">
              {displayPasskeyLabel(record)}
            </span>
            {active && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-brand-navy-100 text-brand-navy-700 text-[10px] px-1.5 py-0.5 dark:bg-brand-navy-800 dark:text-brand-navy-100 shrink-0">
                <Check className="h-2.5 w-2.5" /> aktivan
              </span>
            )}
          </div>
          <span className="font-mono text-sm text-ink-primary truncate">
            {shorten(record.safeAddress)}
          </span>
          <div className="flex items-baseline gap-2">
            <span
              className={
                'text-sm tabular-nums ' +
                (balance === undefined
                  ? 'text-ink-muted'
                  : balance === 0n
                    ? 'text-ink-muted'
                    : 'text-ink-primary font-medium')
              }
            >
              {balance === undefined ? '…' : `${formatEureShort(balance)} EURe`}
            </span>
            <span className="text-[11px] text-ink-muted">
              · {formatDate(record.createdAt)}
            </span>
          </div>
        </div>
        <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onArchive();
        }}
        aria-label="Arhiviraj wallet"
        className="absolute top-2 right-2 h-8 w-8 inline-flex items-center justify-center rounded-full text-ink-muted hover:text-ink-primary hover:bg-surface-sunken/80 active:scale-95 transition"
      >
        <Archive className="h-4 w-4" />
      </button>
    </div>
  );
}

function PickLinkTargetView({
  targets,
  onPick,
  onPickCustom,
  onCancel,
}: {
  targets: BrandConfig[];
  onPick: (t: BrandConfig) => void;
  onPickCustom: (domain: string) => void;
  onCancel: () => void;
}) {
  const [customMode, setCustomMode] = useState(false);
  const [customDomain, setCustomDomain] = useState('');

  function trySubmitCustom() {
    const cleaned = customDomain.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!cleaned || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(cleaned)) return;
    if (cleaned === window.location.hostname) return; // can't link to self
    onPickCustom(cleaned);
  }

  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-sunken text-brand-primary">
          <Link2 className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">Iz kojeg walleta linkaš?</h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          Odaberi wallet u kojem već imaš Safe. Otvorit ćemo ga, autenticirat ćeš se,
          i ovaj <span className="font-medium text-ink-primary">{brand.name}</span> postat
          će dodatni potpisnik istog Safe-a (threshold = 1).
        </p>
      </div>

      {!customMode && (
        <div className="flex flex-col gap-2">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className="text-left flex items-center gap-3 rounded-2xl border border-surface-border bg-surface-raised hover:bg-surface-sunken active:scale-[0.99] transition p-4"
            >
              <div
                aria-hidden
                className="h-10 w-10 rounded-2xl shrink-0 ring-1 ring-black/5"
                style={{ background: `linear-gradient(135deg, ${t.colors.primary}, ${t.colors.accent})` }}
              />
              <div className="flex flex-col leading-tight min-w-0 flex-1">
                <span className="font-medium text-ink-primary truncate">{t.name}</span>
                <span className="text-xs text-ink-muted font-mono truncate">{t.domain}</span>
              </div>
              <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />
            </button>
          ))}
          <button
            type="button"
            onClick={() => setCustomMode(true)}
            className="text-left flex items-center gap-3 rounded-2xl border border-dashed border-surface-border bg-surface-base hover:bg-surface-sunken active:scale-[0.99] transition p-4"
          >
            <div className="flex flex-col leading-tight min-w-0 flex-1">
              <span className="font-medium text-ink-secondary">Drugi wallet (custom URL)</span>
              <span className="text-xs text-ink-muted">Za wallete čije domene nisu u listi.</span>
            </div>
            <ChevronRight className="h-5 w-5 text-ink-muted shrink-0" />
          </button>
        </div>
      )}

      {customMode && (
        <Card padding="md" className="flex flex-col gap-3">
          <Field
            label="Domena ciljnog walleta"
            hint="Npr. wallet.example.com — bez https://"
            error={
              customDomain && customDomain.trim() === window.location.hostname
                ? 'Ne možeš linkati ovaj wallet sam sa sobom.'
                : undefined
            }
          >
            {(id) => (
              <Input
                id={id}
                type="text"
                autoFocus
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') trySubmitCustom();
                }}
                placeholder="wallet.example.com"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Button onClick={trySubmitCustom} size="lg" block>
            <Link2 className="h-4 w-4" />
            Otvori autorizaciju
          </Button>
          <Button onClick={() => setCustomMode(false)} variant="ghost" size="sm" block>
            Natrag na listu
          </Button>
        </Card>
      )}

      <Button onClick={onCancel} variant="ghost" size="md" block>
        Otkaži
      </Button>
    </div>
  );
}

function LinkingBridgeView({ iframeUrl, onCancel }: { iframeUrl: string; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-3 animate-route-enter">
      <Card padding="md" className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-brand-primary">
          <Link2 className="h-5 w-5" />
          <h2 className="font-semibold">Linkanje s DOMOVINA Walletom</h2>
        </div>
        <p className="text-sm text-ink-secondary">
          U okvirima ispod otvori se DOMOVINA Wallet. Tamo odaberi Safe na
          koji želiš spojiti ovaj {brand.name} i potpiši Face ID-em.
          Kad završi, automatski se vraćamo ovamo.
        </p>
      </Card>
      <div className="rounded-3xl overflow-hidden border border-surface-border bg-surface-raised shadow-card">
        <iframe
          src={iframeUrl}
          title="DOMOVINA Wallet linking"
          allow="publickey-credentials-get; publickey-credentials-create"
          className="block w-full h-[520px] bg-surface-base"
        />
      </div>
      <Button onClick={onCancel} variant="ghost" size="md" block>
        Otkaži linkanje
      </Button>
    </div>
  );
}

function ProgressInline({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 animate-route-enter">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-brand-primary/20 animate-ping" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-primary text-brand-primary-fg">
          <Fingerprint className="h-10 w-10" />
        </div>
      </div>
      <div className="text-center flex flex-col gap-1">
        <p className="font-semibold text-ink-primary text-lg">{title}</p>
        <p className="text-sm text-ink-secondary max-w-xs">{subtitle}</p>
      </div>
    </div>
  );
}

function ConfirmCreateManyView({
  existingCount,
  onCancel,
  onConfirm,
}: {
  existingCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">
          Stvarno još jedan wallet?
        </h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          Već imaš <span className="font-semibold text-ink-primary">{existingCount}</span>{' '}
          waleta na ovom uređaju. Svaki novi wallet znači novu adresu, novi
          passkey u Keychainu, i poseban balans — kasnije je teško pratiti
          koji je za što.
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-3 text-sm text-ink-secondary">
        <p>
          Za većinu ljudi <span className="font-semibold text-ink-primary">jedan wallet je dovoljan</span>.
          Dobri razlozi za drugi:
        </p>
        <ul className="list-disc list-inside flex flex-col gap-1 text-ink-secondary">
          <li>Odvojeni hot wallet od ušteđevine</li>
          <li>Wallet za firmu odvojen od privatnog</li>
          <li>Testni wallet koji ne miješaš s pravim novcima</li>
        </ul>
        <p>
          Ako samo zaboravljaš koji je koji — prvo{' '}
          <span className="font-medium text-ink-primary">arhiviraj</span> stare iz liste,
          pa onda kreiraj novi.
        </p>
      </Card>

      <div className="flex flex-col gap-2">
        <Button onClick={onConfirm} size="xl" block>
          <Plus className="h-5 w-5" />
          Ipak želim novi wallet
        </Button>
        <Button onClick={onCancel} variant="ghost" size="md" block>
          Otkaži — vrati me na popis
        </Button>
      </div>
    </div>
  );
}

function ConfirmArchiveView({
  record,
  onCancel,
  onConfirm,
}: {
  record: PasskeyRecord;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-sunken text-ink-secondary">
          <Archive className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">Sakrij wallet s liste?</h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          <span className="font-mono text-ink-primary">{shorten(record.safeAddress)}</span>{' '}
          ({displayPasskeyLabel(record)}) izlazi iz lokalnog popisa.
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-2 text-sm text-ink-secondary">
        <p>
          <span className="font-medium text-ink-primary">Novci ostaju netaknuti</span> na adresi i u
          Safe-u na blockchainu. Passkey ostaje u iCloud Keychain / Google Password
          Manageru.
        </p>
        <p>
          Možeš ga uvijek vratiti preko{' '}
          <span className="font-medium text-ink-primary">Otvori drugi passkey</span> ili{' '}
          <span className="font-medium text-ink-primary">Stari passkey</span> na sljedećem ekranu.
        </p>
      </Card>

      <div className="flex flex-col gap-2">
        <Button onClick={onConfirm} size="xl" block>
          <Archive className="h-5 w-5" />
          Da, sakrij s liste
        </Button>
        <Button onClick={onCancel} variant="ghost" size="md" block>
          Otkaži
        </Button>
      </div>
    </div>
  );
}

function NamingView({
  suggestedName,
  onCancel,
  onConfirm,
}: {
  suggestedName: string;
  onCancel: () => void;
  onConfirm: (name: string) => void;
}) {
  const [name, setName] = useState(suggestedName);
  const trimmed = name.trim();
  const tooShort = trimmed.length === 0;
  const tooLong = trimmed.length > 64;
  const invalid = tooShort || tooLong;

  // Existing wallet labels — surfaced so the user picks something distinct
  // from "Glavni" if they already have a Glavni. Read once on mount; the
  // user is heading into a destination they cannot easily back out of.
  const existingLabels = useMemo(() => {
    return listKnownPasskeys()
      .map((r) => r.keychainName ?? (r.nameSuffix ? `wa_${r.nameSuffix}` : null))
      .filter((s): s is string => !!s);
  }, []);

  const collides = existingLabels.some(
    (l) => l.localeCompare(trimmed, 'hr', { sensitivity: 'base' }) === 0,
  );

  function applyPurpose(purpose: string) {
    setName(purposeToKeychainName(purpose));
  }

  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-sunken text-brand-navy-500">
          <KeyRound className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">
          Kako ćeš zvati ovaj wallet?
        </h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          Ovaj naziv ostaje{' '}
          <span className="font-semibold text-ink-primary">trajno spremljen</span> u
          Apple Passwords / iCloud Keychain / Google Password Manageru.
          Vidjet ćeš ga svaki put kad ti OS ponudi Face ID na bilo kojoj
          <span className="whitespace-nowrap"> *.domovina.ai</span> stranici, pa odaberi nešto što ćeš{' '}
          <span className="font-semibold text-ink-primary">prepoznati za 6 mjeseci</span>.
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-4">
        <Field
          label="Naziv passkeya"
          hint="Tap na predložak ispod ili upiši svoj. Naziv ostaje u OS Keychainu kako ga sada upišeš."
          error={
            tooLong
              ? 'Maksimalno 64 znaka.'
              : collides
                ? 'Već imaš passkey s istim nazivom — odaberi drugi da se kasnije ne pomiješaju.'
                : undefined
          }
        >
          {(id) => (
            <Input
              id={id}
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !invalid) onConfirm(trimmed);
              }}
              maxLength={80}
              invalid={tooLong || collides}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          )}
        </Field>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-widest text-ink-muted">
            Brzi predlošci
          </span>
          <div className="flex flex-wrap gap-1.5">
            {PASSKEY_PURPOSE_SUGGESTIONS.map((p) => {
              const candidate = purposeToKeychainName(p);
              const taken = existingLabels.some(
                (l) => l.localeCompare(candidate, 'hr', { sensitivity: 'base' }) === 0,
              );
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => applyPurpose(p)}
                  disabled={taken}
                  className={
                    'rounded-full text-xs px-3 py-1 transition active:scale-95 ' +
                    (taken
                      ? 'bg-surface-sunken/60 text-ink-muted line-through cursor-not-allowed'
                      : 'bg-surface-sunken hover:bg-surface-border text-ink-secondary')
                  }
                  title={taken ? 'Već postoji wallet s tim nazivom' : undefined}
                >
                  {p}
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      <Card
        padding="md"
        className="flex flex-col gap-2 border-dashed bg-surface-sunken/40"
      >
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-ink-muted">
          <KeyRound className="h-3 w-3" />
          U OS Keychainu izgleda ovako
        </div>
        <div
          className={
            'font-mono text-base break-all leading-snug ' +
            (trimmed ? 'text-ink-primary' : 'text-ink-muted')
          }
        >
          {trimmed || 'upiši naziv…'}
        </div>
        {existingLabels.length > 0 && (
          <div className="pt-1 flex flex-col gap-1 text-[11px] text-ink-muted leading-snug">
            <span className="uppercase tracking-widest">
              Već postoje na ovom uređaju
            </span>
            <span className="font-mono break-all">
              {existingLabels.slice(0, 5).join(' · ')}
              {existingLabels.length > 5 && ` · +${existingLabels.length - 5}`}
            </span>
          </div>
        )}
      </Card>

      <div className="flex flex-col gap-2">
        <Button
          onClick={() => onConfirm(trimmed)}
          size="xl"
          block
          disabled={invalid || collides}
        >
          <Fingerprint className="h-5 w-5" />
          Otvori Face ID i kreiraj
        </Button>
        <Button onClick={onCancel} variant="ghost" size="md" block>
          Odustani
        </Button>
      </div>
    </div>
  );
}

function displayPasskeyLabel(record: PasskeyRecord): string {
  if (record.keychainName) return record.keychainName;
  if (record.nameSuffix) return `wa_${record.nameSuffix}`;
  return 'Safe';
}

function CreatingView() {
  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12 animate-route-enter">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-brand-navy-400/20 animate-ping" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-navy-700 text-white dark:bg-brand-navy-400 dark:text-brand-navy-900">
          <Fingerprint className="h-10 w-10" />
        </div>
      </div>
      <div className="text-center flex flex-col gap-1">
        <p className="font-semibold text-ink-primary text-lg">Otvori Face&nbsp;ID</p>
        <p className="text-sm text-ink-secondary max-w-xs">
          Sustav će tražiti potvrdu. Tvoj passkey će se pohraniti u Keychain.
        </p>
      </div>
    </div>
  );
}

function OpeningView() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 animate-route-enter">
      <RefreshCw className="h-8 w-8 text-ink-muted animate-spin" />
      <p className="text-sm text-ink-secondary">Otvori passkey…</p>
    </div>
  );
}

function CreatedView({ record, onEnter }: { record: PasskeyRecord; onEnter: () => void }) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-emerald-400/30 blur-xl" />
          <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500 text-white">
            <Sparkles className="h-10 w-10" />
          </div>
        </div>
        <div className="text-center flex flex-col gap-1">
          <h2 className="text-2xl font-semibold text-ink-primary">Tvoj wallet je spreman</h2>
          <p className="text-sm text-ink-secondary max-w-xs">
            Passkey je u Keychain, Safe smart account je rezerviran na Gnosis Chainu.
          </p>
        </div>
      </div>

      <Card padding="md" className="flex flex-col items-center gap-3">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">Tvoja adresa</span>
        <AddressChip address={record.safeAddress} truncate={false} className="max-w-full" />
        {(record.keychainName || record.nameSuffix) && (
          <p className="text-xs text-ink-muted text-center max-w-xs">
            U Apple Passwords / Google Password Manageru ovaj passkey vidiš kao{' '}
            <span className="font-mono text-ink-secondary break-all">
              {record.keychainName ?? `DOMOVINA wa_${record.nameSuffix}`}
            </span>.
          </p>
        )}
      </Card>

      <Button onClick={onEnter} size="xl" block>
        Otvori wallet
        <ChevronRight className="h-5 w-5" />
      </Button>
    </div>
  );
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4 animate-route-enter">
      <Card padding="md" className="border-brand-red-500/40">
        <p className="text-sm text-brand-red-700 text-center" role="alert">
          {message}
        </p>
      </Card>
      <Button onClick={onRetry} variant="secondary" size="lg" block>
        Natrag
      </Button>
    </div>
  );
}

function FeatureRow({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-sunken text-brand-navy-500 [&_svg]:h-5 [&_svg]:w-5">
        {icon}
      </div>
      <div className="flex flex-col leading-tight">
        <p className="font-medium text-ink-primary">{title}</p>
        <p className="text-sm text-ink-secondary">{description}</p>
      </div>
    </div>
  );
}

function shorten(addr: Address): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function gradientFor(addr: string): string {
  const seed = addr.toLowerCase();
  const h1 = parseInt(seed.slice(2, 6) || '0', 16) % 360;
  const h2 = (h1 + 60 + (parseInt(seed.slice(6, 8) || '0', 16) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}
