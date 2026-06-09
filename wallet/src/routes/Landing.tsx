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
  Copy,
  Eye,
  ShieldAlert,
} from 'lucide-react';
import type { Address } from 'viem';
import { BrandHeader } from '../components/Brand';
import { AddressChip, Button, Card } from '../ui';
import { useWalletStore } from '../state/store';
import { haptic } from '../lib/haptic';
import { humanizeError } from '../lib/errors';
import {
  archivePasskey,
  createPasskey,
  identityKeychainName,
  listKnownPasskeys,
  lookupPasskey,
  passkeyProviderHint,
  pickExistingPasskey,
  savePasskey,
  setActivePasskey,
  type PasskeyRecord,
} from '../lib/passkey';
import { createBootstrapEoa, signAttach, submitBootstrapDeploy } from '../lib/bootstrap';
import { bootstrapAccountView, setActiveAccountAddress } from '../lib/accounts';
import { fetchEureBalances, formatEureShort } from '../lib/balances';
import { lookupWallet, registerWalletWithBackend } from '../lib/registry';
import { brand } from '../app/brand';

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
  | { kind: 'naming' }
  // Reached only when the get-first probe found NO passkey for this RP, yet the
  // result is ambiguous (a dismissed probe is indistinguishable from "none
  // exist"). We ask once more before minting, so we never silently create a
  // second passkey for a user who already has one.
  | { kind: 'confirm-create-fresh' }
  // Probe (or a create that hit InvalidStateError) found an existing passkey on
  // this device. We NEVER auto-enter it (it may be a broken/orphan one) — the
  // user explicitly chooses: open it, or create a new wallet anyway.
  | { kind: 'found-existing'; credentialId?: string }
  // A chosen passkey authenticated but resolves to no usable wallet (no registry
  // entry / undeployed) — e.g. an orphaned test passkey. Guide to create.
  | { kind: 'unusable-passkey' }
  | { kind: 'probing' }
  | { kind: 'creating' }
  | { kind: 'opening' }
  | { kind: 'created'; record: PasskeyRecord; recoverySeed?: string }
  | { kind: 'error'; message: string };

/** A passkey authenticated but maps to no usable wallet (no local record and no
 * backend registry entry) — distinct from a generic failure so the UI can guide
 * the user to create a fresh wallet instead of dead-ending on an error. */
class UnusableWalletError extends Error {}

/** Origins allowed to receive a connect-return redirect (wallet identity in the
 * URL). Conservative allowlist — prevents this page being used as an open
 * redirector. Ecosystem tenants + pinka.io + localhost (dev). */
const RETURN_ALLOWLIST: readonly RegExp[] = [
  /^https:\/\/([a-z0-9-]+\.)*domovina\.ai$/i,
  /^https:\/\/([a-z0-9-]+\.)*pinka\.io$/i,
  /^http:\/\/localhost(:\d+)?$/i,
];

function isAllowedReturn(url: string): boolean {
  try {
    return RETURN_ALLOWLIST.some((re) => re.test(new URL(url).origin));
  } catch {
    return false;
  }
}

/** Read the connect-return target from our own URL (`?dw_connect=1&dw_return=…`),
 * validated against the allowlist. `state` is the host's single-use CSRF token,
 * echoed back unchanged. Null when this isn't an SDK connect handoff. */
type ConnectReturn = { url: string; state: string | null };
function readConnectReturn(): ConnectReturn | null {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search);
  if (p.get('dw_connect') !== '1') return null;
  const ret = p.get('dw_return');
  if (!ret || !isAllowedReturn(ret)) return null;
  return { url: ret, state: p.get('dw_state') };
}

/** Hand the wallet identity back to the host (e.g. pinka.io) and leave. The host
 * SDK's connect() CSRF-checks dw_state, reads these params, resolves, and strips
 * them. */
function finishConnectReturn(cr: ConnectReturn, record: PasskeyRecord): void {
  const u = new URL(cr.url);
  u.searchParams.set('dw_return', '1');
  u.searchParams.set('dw_safe', record.safeAddress);
  u.searchParams.set('dw_signer', record.signerAddress);
  u.searchParams.set('dw_cred', record.credentialId);
  if (cr.state) u.searchParams.set('dw_state', cr.state);
  window.location.replace(u.toString());
}

export function Landing() {
  const setAccount = useWalletStore((s) => s.setAccount);
  // When opened via the SDK "Kreiraj novčanik" handoff, redirect back to the
  // host with the wallet identity instead of entering the wallet UI.
  const connectReturn = useMemo(() => readConnectReturn(), []);
  function maybeReturn(record: PasskeyRecord): boolean {
    if (!connectReturn) return false;
    finishConnectReturn(connectReturn, record);
    return true;
  }
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
    setStage({ kind: 'naming' });
  }

  function proceedToNaming() {
    haptic('tap');
    setStage({ kind: 'naming' });
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

  /**
   * Get-first guard for the create flow (the fix for accidental duplicate
   * "DOMOVINA Wallet" passkeys). The OLD bug: every create() minted a fresh
   * random user.id, and Apple Passwords / Google PM dedupe on (rpId, user.id),
   * NOT on the display name — so a second tap silently produced a second
   * identical entry. Now:
   *   - If we already know a passkey locally, skip straight to create() but pass
   *     its credentialId as excludeCredentials → the authenticator throws
   *     InvalidStateError instead of duplicating (safe; nothing overwritten).
   *   - If the local registry is empty, the passkey may still exist synced via
   *     iCloud/Google but uncached here (exactly how the dupes were born). PROBE
   *     for it first; on a hit, load that identity and never create. On an
   *     ambiguous miss (dismiss looks like absent), ask once more before minting.
   */
  async function confirmCreate() {
    haptic('tap');
    // Create goes STRAIGHT to navigator.credentials.create() — NO get-first probe.
    // A probe is a get() ceremony, and a get() only ever lists EXISTING passkeys
    // and NEVER offers "create new" — that was the trap (Apple Passwords showing
    // "Use a saved passkey", blocking a fresh domovina-wallet). We also pass NO
    // excludeCredentials, so a device already holding (possibly broken/orphan)
    // passkeys can't refuse the create with InvalidStateError. Reuse has its own
    // explicit path ("Otvori postojeći"); duplicate wallets are benign (archivable).
    await runCreate([]);
  }

  /**
   * ADR 0013: create the ONE identity passkey (fixed name) + a 1-of-2 recovery
   * seed. Reuses the ADR 0012 bootstrap 'add' flow — deploy Safe(owner=ephemeral
   * EOA) then addOwner(passkeySigner) → owners=[passkey, EOA]. The EOA's 12-word
   * mnemonic is the recovery key (shown reveal-on-tap on the next screen, never
   * persisted). The passkey keychain name is the fixed brand identity, not the
   * address — with one passkey there's nothing to disambiguate.
   *
   * `excludeCredentialIds` are passed to navigator.credentials.create() so an
   * authenticator that already holds one of them refuses to mint a duplicate.
   */
  async function runCreate(excludeCredentialIds: string[]) {
    setStage({ kind: 'creating' });
    haptic('tap');
    try {
      const eoa = await createBootstrapEoa();
      const { credentialId, pubKey, keychainName, rpId } = await createPasskey(
        identityKeychainName(),
        { excludeCredentialIds },
      );
      const { signerAddress, eoaSignature } = await signAttach({ eoa, pubKey, mode: 'add' });

      const res = await submitBootstrapDeploy({
        safeAddress: eoa.safeAddress,
        ownerEoa: eoa.address,
        pubKeyX: pubKey.x.toString(),
        pubKeyY: pubKey.y.toString(),
        eoaSignature,
        mode: 'add',
      });
      if (!res.ok) throw new Error(res.error);

      const record: PasskeyRecord = {
        credentialId,
        pubKey: { x: pubKey.x.toString(), y: pubKey.y.toString() },
        signerAddress,
        safeAddress: eoa.safeAddress,
        createdAt: new Date().toISOString(),
        keychainName,
        rpId,
        // ADR 0013: the bootstrap EOA becomes the ONE reusable recovery owner
        // that co-owns every future derived account under this identity. We
        // persist only its public address — the mnemonic (shown once below)
        // is never written. Without this, "Novi račun" stays disabled.
        recoveryOwner: eoa.address,
      };
      savePasskey(record);

      void registerWalletWithBackend({
        credentialId,
        pubKeyX: pubKey.x.toString(),
        pubKeyY: pubKey.y.toString(),
        signerAddress,
        safeAddress: eoa.safeAddress,
        rpId,
        recoveryOwner: eoa.address,
      });

      haptic('success');
      setStage({ kind: 'created', record, recoverySeed: eoa.mnemonic });
    } catch (e) {
      haptic('error');
      // InvalidStateError = the authenticator already holds a DOMOVINA passkey
      // (an excluded cred, or a synced one). Don't dead-end — guide to open it.
      const msg = e instanceof Error ? e.message : String(e);
      if (/InvalidStateError|already.*(registered|exist)/i.test(msg)) {
        setStage({ kind: 'found-existing' });
        return;
      }
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
    setActiveAccountAddress(healed.safeAddress);
    if (maybeReturn(healed)) return;
    setAccount(bootstrapAccountView(healed));
  }

  /**
   * Resolve a credentialId to a full record and enter the wallet. Local registry
   * first; on a miss, the backend registry (cross-device case: passkey synced via
   * iCloud/Google but no localStorage here). Shared by the "Već imam passkey"
   * picker and the create-flow get-first probe — both end at "we hold a
   * credentialId, now load that identity". Throws on a passkey unknown to both
   * stores so the caller can surface it.
   */
  async function enterByCredentialId(credentialId: string) {
    let record = lookupPasskey(credentialId);
    if (!record) {
      const remote = await lookupWallet(credentialId);
      if (!remote) {
        // Authenticated, but no wallet behind this passkey (orphan/test) → let the
        // caller offer "create new" instead of surfacing a dead error.
        throw new UnusableWalletError('passkey maps to no usable wallet');
      }
      // pubKey + rpId come from the backend registry — without them Send would
      // deploy the wrong signer (stub-0 guard in functions/api/relay.ts) and
      // signWithPasskey would call get() under the wrong RP scope.
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
      // restore (when publicWalletView did not yet return pub_key_x/y). Heal it
      // now so Send works without the user needing to clear data.
      record = await healStubPubKey(record);
    }
    setActivePasskey(record.credentialId);
    setActiveAccountAddress(record.safeAddress);
    // SDK connect handoff: if opened via "Kreiraj/Imam novčanik" from a host
    // page, redirect the wallet identity back instead of entering the UI.
    if (maybeReturn(record)) return;
    setAccount(bootstrapAccountView(record));
  }

  async function openExisting(opts: { legacyOnly?: boolean } = {}) {
    setStage({ kind: 'opening' });
    haptic('tap');
    try {
      const { credentialId } = await pickExistingPasskey(opts);
      await enterByCredentialId(credentialId);
    } catch (e) {
      haptic('error');
      if (e instanceof UnusableWalletError) {
        setStage({ kind: 'unusable-passkey' });
        return;
      }
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  // From the "found existing" choice — open the specific probed credential, but
  // route a broken/orphan one to the guided "create new" instead of an error.
  async function openFoundExisting(credentialId: string) {
    setStage({ kind: 'opening' });
    haptic('tap');
    try {
      await enterByCredentialId(credentialId);
    } catch (e) {
      haptic('error');
      if (e instanceof UnusableWalletError) {
        setStage({ kind: 'unusable-passkey' });
        return;
      }
      setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
    }
  }

  function enterWalletAfterCreate(record: PasskeyRecord) {
    setActivePasskey(record.credentialId);
    setActiveAccountAddress(record.safeAddress);
    if (maybeReturn(record)) return;
    setAccount(bootstrapAccountView(record));
  }

  function resetToWelcome() {
    const known = listKnownPasskeys();
    setStage(known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' });
  }

  return (
    <div className="min-h-full flex flex-col px-6 max-w-md mx-auto pt-safe pb-safe">
      <BrandHeader />

      {connectReturn && (
        <div className="mt-4 rounded-2xl border border-surface-border bg-surface-raised px-4 py-3 text-sm text-ink-secondary">
          Povezuješ se s{' '}
          <span className="font-medium text-ink-primary">
            {(() => {
              try {
                return new URL(connectReturn.url).hostname;
              } catch {
                return 'aplikacijom';
              }
            })()}
          </span>
          . Kreiraj ili odaberi novčanik — vraćamo te natrag.
        </div>
      )}

      <main className="flex-1 flex flex-col justify-center gap-8 pb-12">
        {stage.kind === 'welcome' && (
          <WelcomeView onCreate={startCreate} onCrossDevice={() => openExisting()} />
        )}

        {stage.kind === 'welcome-known' && (
          <WelcomeKnownView
            known={stage.known}
            onOpenKnown={openKnown}
            onCreate={startCreate}
            onCrossDevice={() => openExisting()}
            onRequestArchive={requestArchive}
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
          <ConfirmCreateView onCancel={resetToWelcome} onConfirm={confirmCreate} />
        )}

        {stage.kind === 'confirm-create-fresh' && (
          <ConfirmCreateFreshView
            onCancel={resetToWelcome}
            onCreate={() => runCreate([])}
            onRetryExisting={() => openExisting()}
          />
        )}

        {stage.kind === 'found-existing' && (
          <FoundExistingView
            onOpen={
              stage.credentialId
                ? () => openFoundExisting(stage.credentialId as string)
                : () => openExisting()
            }
            onCreateAnyway={() => runCreate(stage.credentialId ? [stage.credentialId] : [])}
            onCancel={resetToWelcome}
          />
        )}

        {stage.kind === 'unusable-passkey' && (
          <UnusablePasskeyView onCreate={() => runCreate([])} onCancel={resetToWelcome} />
        )}

        {stage.kind === 'probing' && <ProbingView />}

        {stage.kind === 'creating' && <CreatingView />}

        {stage.kind === 'opening' && <OpeningView />}

        {stage.kind === 'created' && (
          <CreatedView
            record={stage.record}
            recoverySeed={stage.recoverySeed}
            onEnter={() => enterWalletAfterCreate(stage.record)}
          />
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

function FoundExistingView({
  onOpen,
  onCreateAnyway,
  onCancel,
}: {
  onOpen: () => void;
  onCreateAnyway: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <KeyRound className="h-10 w-10 mx-auto text-brand-navy-500" />
        <h2 className="text-2xl font-semibold text-ink-primary">Već postoji novčanik</h2>
        <p className="text-ink-secondary">
          Na ovom uređaju ili u tvom keychainu već postoji DOMOVINA novčanik. Otvori
          postojeći — ili kreiraj novi.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button onClick={onOpen} size="xl" block>
          <Fingerprint className="h-5 w-5" />
          Otvori postojeći
        </Button>
        <Button onClick={onCreateAnyway} variant="secondary" size="lg" block>
          <Plus className="h-5 w-5" />
          Svejedno kreiraj novi
        </Button>
        <Button onClick={onCancel} variant="ghost" size="sm" block>
          Natrag
        </Button>
      </div>
    </div>
  );
}

function UnusablePasskeyView({
  onCreate,
  onCancel,
}: {
  onCreate: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <ShieldAlert className="h-10 w-10 mx-auto text-brand-red-500" />
        <h2 className="text-2xl font-semibold text-ink-primary">Novčanik nije postavljen</h2>
        <p className="text-ink-secondary">
          Passkey je prepoznat, ali iza njega nema ispravnog novčanika (vjerojatno stari
          ili testni unos). Kreiraj novi da nastaviš.
        </p>
      </div>
      <div className="flex flex-col gap-3">
        <Button onClick={onCreate} size="xl" block>
          <Plus className="h-5 w-5" />
          Kreiraj novi novčanik
        </Button>
        <Button onClick={onCancel} variant="ghost" size="sm" block>
          Natrag
        </Button>
      </div>
    </div>
  );
}

function WelcomeView({
  onCreate,
  onCrossDevice,
}: {
  onCreate: () => void;
  onCrossDevice: () => void;
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
          description="Tvoj passkey živi u iCloud Keychain / Google Password Manageru."
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
        <Button onClick={onCrossDevice} variant="ghost" size="sm" block>
          <RefreshCw className="h-4 w-4" />
          Već imam passkey
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
  onRequestArchive,
}: {
  known: PasskeyRecord[];
  onOpenKnown: (record: PasskeyRecord) => void;
  onCreate: () => void;
  onCrossDevice: () => void;
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
        <Button onClick={onCrossDevice} variant="ghost" size="sm" block>
          <RefreshCw className="h-4 w-4" />
          Otvori s drugog uređaja (iCloud / Google sync)
        </Button>
        <Button onClick={onCreate} variant="ghost" size="sm" block>
          <Plus className="h-4 w-4" />
          Kreiraj novi wallet
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


function ConfirmCreateView({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-sunken text-brand-navy-500">
          <Fingerprint className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">Kreiraj {brand.copy.productName}</h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          Otvorit ćemo Face ID i napraviti tvoj passkey. Dobit ćeš i{' '}
          <span className="font-semibold text-ink-primary">12-riječni recovery ključ</span> kao
          rezervu (možeš ga uvesti u MetaMask). Wallet radi i bez njega — passkey je glavni.
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-3">
        <FeatureRow
          icon={<KeyRound />}
          title="Jedan passkey"
          description="Tvoj jedini ključ za prijavu — u iCloud / Google sync."
        />
        <FeatureRow
          icon={<ShieldCheck />}
          title="Recovery ključ"
          description="Rezerva za MetaMask / app.safe.global. Prikaže se jednom."
        />
      </Card>

      <ProviderHintCard />

      <div className="flex flex-col gap-2">
        <Button onClick={onConfirm} size="xl" block>
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

/**
 * Collapsible note telling the user WHICH password manager will store the
 * passkey and how to switch the default. We cannot pick the provider for them
 * (WebAuthn gives the RP no such control — see passkeyProviderHint), so the
 * honest move is to point at the OS setting. Collapsed by default to avoid
 * cluttering the happy path.
 */
function ProviderHintCard() {
  const [open, setOpen] = useState(false);
  const hint = passkeyProviderHint();
  return (
    <div className="rounded-2xl border border-surface-border bg-surface-sunken/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
      >
        <KeyRound className="h-4 w-4 text-ink-muted shrink-0" />
        <span className="text-sm text-ink-secondary flex-1">{hint.title}</span>
        <ChevronRight
          className={'h-4 w-4 text-ink-muted transition-transform ' + (open ? 'rotate-90' : '')}
        />
      </button>
      {open && (
        <p className="px-4 pb-3 -mt-1 text-xs leading-relaxed text-ink-muted">
          {hint.steps}
        </p>
      )}
    </div>
  );
}

/**
 * Shown after the get-first probe came back empty (the user has no passkey for
 * this RP, or dismissed the probe). We never auto-create here — the user picks:
 * mint a brand-new identity, OR retry opening an existing one (in case they
 * dismissed the probe by accident). This is the guardrail against silently
 * minting a second "DOMOVINA Wallet".
 */
function ConfirmCreateFreshView({
  onCancel,
  onCreate,
  onRetryExisting,
}: {
  onCancel: () => void;
  onCreate: () => void;
  onRetryExisting: () => void;
}) {
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-sunken text-brand-navy-500">
          <Sparkles className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">Kreiramo novi passkey?</h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          Nismo pronašli postojeći <span className="font-mono text-ink-secondary">domovina-wallet-v1</span>{' '}
          passkey na ovom uređaju. Ako ga već imaš (npr. na drugom uređaju u istom
          iCloud / Google računu), otvori ga — da ne dobiješ dva.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button onClick={onRetryExisting} size="xl" block>
          <RefreshCw className="h-5 w-5" />
          Otvori postojeći passkey
        </Button>
        <Button onClick={onCreate} variant="secondary" size="md" block>
          <Plus className="h-4 w-4" />
          Nemam ga — kreiraj novi
        </Button>
        <Button onClick={onCancel} variant="ghost" size="md" block>
          Odustani
        </Button>
      </div>
    </div>
  );
}

function ProbingView() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-12 animate-route-enter">
      <RefreshCw className="h-8 w-8 text-ink-muted animate-spin" />
      <p className="text-sm text-ink-secondary">Provjeravamo imaš li već passkey…</p>
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

function CreatedView({
  record,
  recoverySeed,
  onEnter,
}: {
  record: PasskeyRecord;
  recoverySeed?: string;
  onEnter: () => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const words = recoverySeed ? recoverySeed.split(/\s+/) : [];

  async function copySeed() {
    if (!recoverySeed) return;
    try {
      await navigator.clipboard.writeText(recoverySeed);
      setCopied(true);
      haptic('success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can still read the words */
    }
  }

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
            Passkey je u Keychain, Safe smart account je live na Gnosis Chainu.
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

      {recoverySeed && !revealed && (
        <Card padding="md" className="flex flex-col gap-3 border-dashed">
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-1.5 text-sm font-medium text-ink-primary">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Recovery seed (neobavezno)
            </span>
            <p className="text-xs text-ink-secondary leading-snug">
              12-riječni rezervni ključ — uvezeš ga u MetaMask ili app.safe.global i isti
              Safe koristiš svugdje. Možeš preskočiti i ostati samo na passkeyu. Prikazuje se{' '}
              <span className="font-semibold">samo sad</span>.
            </p>
          </div>
          <Button onClick={() => setRevealed(true)} variant="secondary" size="md" block>
            <Eye className="h-4 w-4" />
            Prikaži recovery seed
          </Button>
        </Card>
      )}

      {recoverySeed && revealed && (
        <Card padding="md" className="flex flex-col gap-3 border-brand-red-500/40">
          <div className="flex items-start gap-2 text-xs text-brand-red-700 leading-snug">
            <ShieldAlert className="h-4 w-4 shrink-0" />
            <span>
              Tko vidi ovih 12 riječi može potrošiti tvoj novac. Zapiši ih offline i nikom ih
              ne pokazuj. Nikad se više neće prikazati.
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {words.map((w, i) => (
              <div
                key={i}
                className="flex items-baseline gap-1 rounded-lg bg-surface-sunken px-2 py-1.5 font-mono text-sm"
              >
                <span className="text-[10px] text-ink-muted">{i + 1}</span>
                <span className="text-ink-primary break-all">{w}</span>
              </div>
            ))}
          </div>
          <Button onClick={copySeed} variant="secondary" size="md" block>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Kopirano' : 'Kopiraj seed'}
          </Button>
          <p className="text-[11px] text-ink-muted leading-snug">
            MetaMask: Uvezi račun → Tajna fraza za oporavak (SRP). Ovaj ključ je drugi
            potpisnik (1-od-2) — wallet i dalje radi i bez njega, preko passkeya.
          </p>
        </Card>
      )}

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
