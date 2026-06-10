import { useEffect, useMemo, useRef, useState } from 'react';
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
  Download,
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
  discoverViaConditional,
  identityKeychainName,
  isConditionalMediationSupported,
  listKnownPasskeys,
  lookupPasskey,
  passkeyProviderHint,
  pickExistingPasskey,
  savePasskey,
  setActivePasskey,
  type PasskeyRecord,
} from '../lib/passkey';
import { RP_ID } from '../lib/constants';
import { createBootstrapEoa, signAttach, submitBootstrapDeploy } from '../lib/bootstrap';
import { downloadPaperWalletPdf, type PaperWalletFormat } from '../lib/paperWallet';
import {
  bootstrapAccountView,
  deriveAccount,
  ensureRecoveryOwner,
  listAccountsForIdentity,
  setActiveAccountAddress,
  syncAccountsWithBackend,
  type WalletAccount,
} from '../lib/accounts';
import { AccountRow } from '../components/WalletSwitcherSheet';
import { fetchEureBalances, formatEureShort } from '../lib/balances';
import {
  lookupWallet,
  lookupWalletStrict,
  RegistryUnavailableError,
  registerWalletWithBackend,
} from '../lib/registry';
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
  | { kind: 'confirm-archive'; record: PasskeyRecord; balance?: bigint }
  | { kind: 'naming' }
  // A create that hit InvalidStateError found an existing passkey on this device.
  // We NEVER auto-enter it (it may be a broken/orphan one) — the user explicitly
  // chooses: open it, or create a new wallet anyway.
  | { kind: 'found-existing'; credentialId?: string }
  // A chosen passkey authenticated but resolves to no usable wallet (no registry
  // entry / undeployed) — e.g. an orphaned test passkey. Guide to create.
  | { kind: 'unusable-passkey' }
  // 'passkey' = waiting on the Face ID ceremony; 'deploying' = ceremony done,
  // backend is deploying the Safe on-chain (the slow part — needs visible progress
  // or the screen reads as frozen).
  | { kind: 'creating'; phase: CreatePhase }
  | { kind: 'opening' }
  | { kind: 'created'; record: PasskeyRecord; recoverySeed?: string }
  // SDK createAccount() handoff (e.g. pinka campaign): identity is established,
  // now ask consent to open a NEW derived account named after the host's request.
  | { kind: 'create-account-confirm'; record: PasskeyRecord; name: string }
  | { kind: 'create-account-deriving' }
  // SDK connect() handoff: identity established — let the user pick WHICH of the
  // identity's N accounts (bootstrap + derived) to hand back. Before this stage
  // the handoff always returned the bootstrap, hiding the other accounts.
  | { kind: 'connect-pick-account'; record: PasskeyRecord }
  | { kind: 'error'; message: string };

type CreatePhase = 'passkey' | 'deploying' | 'deriving';

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
 * them. `account` is the user's pick from the connect-time account picker —
 * dw_safe is THAT account's Safe (bootstrap or derived); dw_signer/dw_cred stay
 * the identity (one passkey signs for all N accounts). Embed's send() resolves
 * derived accounts (saltNonce/recoveryOwner) from the registry by address. */
function finishConnectReturn(
  cr: ConnectReturn,
  record: PasskeyRecord,
  account?: Pick<WalletAccount, 'safeAddress'>,
): void {
  const u = new URL(cr.url);
  u.searchParams.set('dw_return', '1');
  u.searchParams.set('dw_safe', account?.safeAddress ?? record.safeAddress);
  u.searchParams.set('dw_signer', record.signerAddress);
  u.searchParams.set('dw_cred', record.credentialId);
  if (cr.state) u.searchParams.set('dw_state', cr.state);
  window.location.replace(u.toString());
}

/** Read the createAccount() handoff (`?dw_create_account=1&dw_name=…&dw_return=…`).
 * Same CSRF/allowlist contract as connect; `name` is the host's requested account
 * label (e.g. the pinka campaign title). Null when this isn't that handoff. */
type CreateAccountReturn = { url: string; state: string | null; name: string };
function readCreateAccountReturn(): CreateAccountReturn | null {
  if (typeof window === 'undefined') return null;
  const p = new URLSearchParams(window.location.search);
  if (p.get('dw_create_account') !== '1') return null;
  const ret = p.get('dw_return');
  if (!ret || !isAllowedReturn(ret)) return null;
  return { url: ret, state: p.get('dw_state'), name: p.get('dw_name') ?? '' };
}

/** Hand the newly derived campaign account back to the host. `dw_account` is the
 * derived (campaign) Safe; `dw_safe`/`dw_signer`/`dw_cred` are the connecting
 * identity (the return doubles as a connect), `dw_salt` the account's saltNonce. */
function finishCreateAccountReturn(
  cr: CreateAccountReturn,
  record: PasskeyRecord,
  account: { safeAddress: string; saltNonce?: string },
): void {
  const u = new URL(cr.url);
  u.searchParams.set('dw_return', '1');
  u.searchParams.set('dw_account', account.safeAddress);
  u.searchParams.set('dw_safe', record.safeAddress);
  u.searchParams.set('dw_signer', record.signerAddress);
  u.searchParams.set('dw_cred', record.credentialId);
  if (account.saltNonce) u.searchParams.set('dw_salt', account.saltNonce);
  if (cr.state) u.searchParams.set('dw_state', cr.state);
  window.location.replace(u.toString());
}

/** Tell the host the user declined (or derivation failed). The host SDK rejects
 * createAccount() with this so its wizard can restore the draft and offer a retry. */
function finishCreateAccountReturnError(cr: CreateAccountReturn, code = 'cancelled'): void {
  const u = new URL(cr.url);
  u.searchParams.set('dw_return', '1');
  u.searchParams.set('dw_error', code);
  if (cr.state) u.searchParams.set('dw_state', cr.state);
  window.location.replace(u.toString());
}

export function Landing() {
  const setAccount = useWalletStore((s) => s.setAccount);
  // When opened via the SDK "Kreiraj novčanik" handoff, redirect back to the
  // host with the wallet identity instead of entering the wallet UI.
  const connectReturn = useMemo(() => readConnectReturn(), []);
  const createAccountReturn = useMemo(() => readCreateAccountReturn(), []);
  // Called once an identity (passkey) is established. Routes the post-identity step:
  // a createAccount handoff → consent screen (then derive+return); a plain connect
  // handoff → redirect identity back; otherwise → false so the caller enters the UI.
  function maybeReturn(record: PasskeyRecord): boolean {
    if (createAccountReturn) {
      setStage({ kind: 'create-account-confirm', record, name: createAccountReturn.name });
      return true;
    }
    if (!connectReturn) return false;
    // Don't return the bootstrap blindly — the identity may hold N accounts. The
    // picker stage syncs the registry, auto-returns when there's only one, and
    // otherwise lets the user choose which account the host gets.
    setStage({ kind: 'connect-pick-account', record });
    return true;
  }

  async function confirmCreateAccount(record: PasskeyRecord, name: string) {
    if (!createAccountReturn) return;
    haptic('tap');
    setStage({ kind: 'create-account-deriving' });
    try {
      // Pure-local derive of a 1-of-2 [signer, recoveryOwner] Safe — no Face ID, no
      // tx (deploys lazily on first send via the relay cold path). Reuses the same
      // "Novi račun" path as WalletSwitcher so the account is native + cross-device.
      const acc = await deriveAccount(record.credentialId, name.trim() || 'Kampanja');
      finishCreateAccountReturn(createAccountReturn, record, acc);
    } catch (e) {
      // e.g. a legacy identity with no recoveryOwner can't derive — tell the host so
      // its wizard can fall back to the legacy client-side derive path.
      console.error('[Landing] createAccount derive failed', e);
      finishCreateAccountReturnError(createAccountReturn, 'derive_failed');
    }
  }

  function rejectCreateAccount() {
    haptic('tap');
    if (createAccountReturn) {
      finishCreateAccountReturnError(createAccountReturn, 'cancelled');
      return;
    }
    resetToWelcome();
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

  // ── Conditional-mediation (autofill) discovery — the zero-friction probe.
  // On the welcome stages we arm a background, NON-modal WebAuthn get() that
  // surfaces the user's existing passkeys (incl. iCloud/Google-synced ones not in
  // this device's localStorage) via OS autofill. If the user taps a suggestion we
  // OPEN that wallet instead of letting them create a duplicate. Invisible when no
  // passkey exists (no first-timer trap) — and where unsupported, the modal probe
  // in confirmCreate is the fallback. Requires the autocomplete="webauthn" field
  // rendered below. See docs/passkey-onboarding-industry-standards.md.
  const [condSupported, setCondSupported] = useState(false);
  const conditionalAbortRef = useRef<AbortController | null>(null);
  function abortConditional() {
    conditionalAbortRef.current?.abort();
    conditionalAbortRef.current = null;
  }

  useEffect(() => {
    isConditionalMediationSupported().then(setCondSupported);
  }, []);

  useEffect(() => {
    if (!condSupported) return;
    // Only on the EMPTY welcome — on welcome-known the wallet cards + the
    // explicit "Otvori postojeći" picker cover every open path, and a second
    // passkey entry point read as a redundant duplicate of the card list.
    if (stage.kind !== 'welcome') return;
    let done = false;
    const ctrl = new AbortController();
    conditionalAbortRef.current = ctrl;
    (async () => {
      const credId = await discoverViaConditional(RP_ID, ctrl.signal);
      if (done || !credId) return;
      conditionalAbortRef.current = null;
      setStage({ kind: 'opening' });
      try {
        await enterByCredentialId(credId);
      } catch (e) {
        if (e instanceof UnusableWalletError) {
          setStage({ kind: 'unusable-passkey' });
        } else if (e instanceof RegistryUnavailableError) {
          setStage({
            kind: 'error',
            message: 'Ne mogu dohvatiti tvoj novčanik (mreža ili server). Pokušaj ponovno.',
          });
        } else {
          setStage({ kind: 'error', message: humanizeError(e, 'passkey') });
        }
      }
    })();
    return () => {
      done = true;
      ctrl.abort();
      if (conditionalAbortRef.current === ctrl) conditionalAbortRef.current = null;
    };
    // enterByCredentialId is stable enough for this effect; re-arming on stage.kind
    // + condSupported is the intended trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [condSupported, stage.kind]);

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

  function requestArchive(record: PasskeyRecord, balance?: bigint) {
    haptic('tap');
    setStage({ kind: 'confirm-archive', record, balance });
  }

  function confirmArchive(record: PasskeyRecord) {
    haptic('success');
    // LOCAL-ONLY by design: archive hides the wallet from THIS device's list and
    // nothing more. ██ NEVER signal the password manager to delete the passkey
    // (signalUnknownCredential or similar) — the passkey is a Safe owner that may
    // sign for N accounts across all synced devices; deleting it can permanently
    // lock funds on-chain. See the WARNING block in lib/passkey.ts. ██
    archivePasskey(record.credentialId);
    const known = listKnownPasskeys();
    setStage(known.length > 0 ? { kind: 'welcome-known', known } : { kind: 'welcome' });
  }

  /**
   * Create the identity passkey. Goes STRAIGHT to navigator.credentials.create()
   * — NO get-first probe (a get() shows "Use a saved passkey" and never offers
   * create, which trapped users). We pass excludeCredentials = locally-known creds
   * so the authenticator REFUSES a same-device duplicate (InvalidStateError →
   * found-existing). A random user.id per create is deliberate (a stable one would
   * OVERWRITE the passkey → orphan the funded Safe). Cross-device/cleared-storage
   * dedup is impossible without showing the picker, so that rarer case can still
   * dup; "Otvori postojeći" / "Svejedno kreiraj novi" are the explicit paths.
   */
  async function confirmCreate() {
    haptic('tap');
    abortConditional(); // release the autofill get() before any explicit ceremony
    const known = listKnownPasskeys();

    // Phase-1 duplicate guard (docs/passkey-onboarding-industry-standards.md).
    // When there is NO local record, a passkey for our RP may still exist in
    // iCloud/Google: cleared site data, the installed PWA vs a Safari tab (separate
    // localStorage), another browser, or a second synced device. Without a check,
    // create() mints a SECOND 'domovina-wallet-v1' (each = a new identity + Safe +
    // seed) because Apple/Google dedupe on (rpId, user.id) and our user.id is random
    // per create (a stable one would OVERWRITE → orphan a funded Safe — never do
    // that). So we PROBE with the OS passkey picker first and OPEN the existing one
    // instead of duplicating it. The probe is gated to the empty-registry case so it
    // adds ZERO friction to the common "create an additional wallet" path (where a
    // local record exists and excludeCredentials already blocks a same-device dup).
    // (A zero-friction conditional-mediation autofill probe is the future upgrade;
    // it needs a welcome-screen sign-in field — see the doc.)
    if (known.length === 0) {
      let probed: string | null = null;
      try {
        probed = (await pickExistingPasskey()).credentialId;
      } catch {
        probed = null; // dismissed / none for our RP → genuine first-timer, create
      }
      if (probed) {
        setStage({ kind: 'opening' });
        try {
          await enterByCredentialId(probed);
          return;
        } catch (e) {
          if (e instanceof UnusableWalletError) {
            setStage({ kind: 'unusable-passkey' });
            return;
          }
          if (e instanceof RegistryUnavailableError) {
            setStage({
              kind: 'error',
              message: 'Ne mogu dohvatiti tvoj novčanik (mreža ili server). Pokušaj ponovno.',
            });
            return;
          }
          // Unknown failure resolving the picked passkey — fall through to create.
          console.warn('[Landing] probe-open failed, proceeding to create', e);
        }
      }
    }

    // excludeCredentials = locally-known creds → the authenticator refuses a
    // same-device duplicate (InvalidStateError → found-existing). Random user.id is
    // deliberate; "Svejedno kreiraj novi" remains the explicit no-excludes path.
    await runCreate(known.map((k) => k.credentialId));
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
    setStage({ kind: 'creating', phase: 'passkey' });
    haptic('tap');
    try {
      const eoa = await createBootstrapEoa();
      // Phase-4 distinguishable label: append the short Safe address so two
      // passkeys (if a duplicate ever slips through cross-provider/-device) are
      // selectable in Apple Passwords / Google PM by their address — they no longer
      // read as identical 'domovina-wallet-v1'. The address is known here (derived
      // from the bootstrap EOA before the passkey exists). Stays under the 64-char
      // keychain cap. See docs/passkey-onboarding-industry-standards.md.
      const shortSafe = `${eoa.safeAddress.slice(2, 6)}…${eoa.safeAddress.slice(-4)}`;
      const { credentialId, pubKey, keychainName, rpId } = await createPasskey(
        `${identityKeychainName()} · ${shortSafe}`,
        { excludeCredentialIds },
      );
      // Face ID is done — the rest is the backend deploying the Safe on Gnosis.
      // Without this phase switch the screen kept saying "Otvori Face ID" and
      // read as frozen for the several seconds the deploy takes.
      setStage({ kind: 'creating', phase: 'deploying' });
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
    // Backfill local accounts → backend + pull any minted on another device.
    void syncAccountsWithBackend(healed.credentialId);
    void ensureRecoveryOwner(healed.credentialId);
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
      // Strict lookup: a 404 means "no wallet" (→ UnusableWalletError → create),
      // but a network/5xx throws RegistryUnavailableError so we DON'T tell a user
      // with a real funded wallet to "create a new one" on a transient blip.
      const remote = await lookupWalletStrict(credentialId);
      if (!remote) {
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
        // Restore the identity's recovery owner so THIS device can also mint
        // further accounts ("Novi račun"), not just view the synced ones.
        recoveryOwner: remote.recovery_owner ?? undefined,
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
    // Cross-device restore: pull this identity's derived accounts from the backend
    // (so ALL N show in the switcher, not just bootstrap) and backfill any local-only
    // ones up. Fire-and-forget — WalletSwitcher reads localStorage live on open.
    void syncAccountsWithBackend(record.credentialId);
    // Make the recovery owner available here too (backend or on-chain), so "Novi
    // račun" works on this device — not just where the wallet was created.
    void ensureRecoveryOwner(record.credentialId);
    // SDK connect handoff: if opened via "Kreiraj/Imam novčanik" from a host
    // page, redirect the wallet identity back instead of entering the UI.
    if (maybeReturn(record)) return;
    setAccount(bootstrapAccountView(record));
  }

  async function openExisting(opts: { legacyOnly?: boolean } = {}) {
    abortConditional(); // release the autofill get() before the explicit picker
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
      if (e instanceof RegistryUnavailableError) {
        setStage({
          kind: 'error',
          message: 'Ne mogu dohvatiti tvoj novčanik (mreža ili server). Pokušaj ponovno.',
        });
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
      if (e instanceof RegistryUnavailableError) {
        setStage({
          kind: 'error',
          message: 'Ne mogu dohvatiti tvoj novčanik (mreža ili server). Pokušaj ponovno.',
        });
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

      {createAccountReturn && (
        <div className="mt-4 rounded-2xl border border-surface-border bg-surface-raised px-4 py-3 text-sm text-ink-secondary">
          <span className="font-medium text-ink-primary">
            {(() => {
              try {
                return new URL(createAccountReturn.url).hostname;
              } catch {
                return 'Aplikacija';
              }
            })()}
          </span>{' '}
          traži otvaranje novog računa. Prijavi se ili kreiraj novčanik — vraćamo te natrag.
        </div>
      )}

      <main className="flex-1 flex flex-col justify-center gap-8 pb-12">
        {condSupported && stage.kind === 'welcome' && <ConditionalSignInField />}

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
            balance={stage.balance}
            onCancel={resetToWelcome}
            onConfirm={() => confirmArchive(stage.record)}
          />
        )}

        {stage.kind === 'naming' && (
          <ConfirmCreateView onCancel={resetToWelcome} onConfirm={confirmCreate} />
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

        {stage.kind === 'creating' && <CreatingView phase={stage.phase} />}

        {stage.kind === 'opening' && <OpeningView />}

        {stage.kind === 'created' && (
          <CreatedView
            record={stage.record}
            recoverySeed={stage.recoverySeed}
            onEnter={() => enterWalletAfterCreate(stage.record)}
          />
        )}

        {stage.kind === 'create-account-confirm' && (
          <CreateAccountConfirmView
            name={stage.name}
            host={(() => {
              try {
                return new URL(createAccountReturn?.url ?? '').hostname;
              } catch {
                return 'Aplikacija';
              }
            })()}
            onConfirm={() => confirmCreateAccount(stage.record, stage.name)}
            onReject={rejectCreateAccount}
          />
        )}

        {stage.kind === 'create-account-deriving' && <CreatingView phase="deriving" />}

        {stage.kind === 'connect-pick-account' && connectReturn && (
          <ConnectPickAccountView
            record={stage.record}
            host={(() => {
              try {
                return new URL(connectReturn.url).hostname;
              } catch {
                return 'aplikacijom';
              }
            })()}
            onPick={(account) => finishConnectReturn(connectReturn, stage.record, account)}
            onBack={resetToWelcome}
          />
        )}

        {stage.kind === 'error' && (
          <ErrorView message={stage.message} onRetry={resetToWelcome} />
        )}
      </main>
    </div>
  );
}

/** Consent card for the SDK createAccount() handoff. Opening a derived account is
 * pure-local (no Face ID beyond the already-established session), so this is a
 * consent step, not a signature. */
/**
 * Connect-time account picker (SDK dw_connect handoff). The identity is already
 * established; before handing dw_safe back to the host we sync the account
 * registry (cross-device: accounts minted elsewhere) and let the user choose
 * which of their N accounts to connect. With a single account there is nothing
 * to choose — auto-return immediately (no extra tap for the common case).
 */
function ConnectPickAccountView({
  record,
  host,
  onPick,
  onBack,
}: {
  record: PasskeyRecord;
  host: string;
  onPick: (account: WalletAccount) => void;
  onBack: () => void;
}) {
  const [accounts, setAccounts] = useState<WalletAccount[] | null>(null);
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map());
  // onPick navigates away; the ref guards against firing it twice (StrictMode
  // double-mount or a late sync resolving after the user already tapped).
  const pickedRef = useRef(false);
  function pick(account: WalletAccount) {
    if (pickedRef.current) return;
    pickedRef.current = true;
    haptic('tap');
    onPick(account);
  }

  useEffect(() => {
    let dead = false;
    (async () => {
      // Pull accounts minted on other devices before deciding if a picker is
      // even needed — without this the list is whatever localStorage happens
      // to hold (the original "only the default shows up" bug).
      try {
        await syncAccountsWithBackend(record.credentialId);
      } catch {
        /* best-effort — local list still works */
      }
      if (dead) return;
      const list = listAccountsForIdentity(record.credentialId);
      if (list.length <= 1) {
        // Single account → nothing to pick.
        if (!pickedRef.current) {
          pickedRef.current = true;
          onPick(list[0] ?? bootstrapAccountView(record));
        }
        return;
      }
      setAccounts(list);
      fetchEureBalances(list.map((a) => a.safeAddress))
        .then((b) => {
          if (!dead) setBalances(b);
        })
        .catch((e) => console.warn('[Landing] picker balance fetch failed', e));
    })();
    return () => {
      dead = true;
    };
    // record is stable for the lifetime of this stage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (accounts === null) {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-ink-secondary animate-route-enter">
        <RefreshCw className="h-6 w-6 animate-spin" />
        Učitavam račune…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <KeyRound className="h-10 w-10 mx-auto text-brand-navy-500" />
        <h2 className="text-2xl font-semibold text-ink-primary">Odaberi račun</h2>
        <p className="text-ink-secondary">
          <span className="font-medium text-ink-primary">{host}</span> se povezuje s jednim
          od tvojih računa — odaberi kojim.
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {accounts.map((account) => (
          <li key={account.safeAddress}>
            <AccountRow
              account={account}
              balance={balances.get(account.safeAddress.toLowerCase())}
              active={false}
              onClick={() => pick(account)}
            />
          </li>
        ))}
      </ul>

      <p className="text-center text-xs text-ink-muted">
        Svi računi su pod istim passkeyem — odabir samo određuje koju adresu
        aplikacija dobiva.
      </p>

      <Button onClick={onBack} variant="ghost" size="md" block>
        Natrag
      </Button>
    </div>
  );
}

function CreateAccountConfirmView({
  name,
  host,
  onConfirm,
  onReject,
}: {
  name: string;
  host: string;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const label = name.trim() || 'Kampanja';
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <Sparkles className="h-10 w-10 mx-auto text-brand-navy-500" />
        <h2 className="text-2xl font-semibold text-ink-primary">Otvori novi račun</h2>
        <p className="text-ink-secondary">
          <span className="font-medium text-ink-primary">{host}</span> traži otvaranje novog
          računa u tvom novčaniku:
        </p>
      </div>
      <Card padding="md" className="flex flex-col gap-1 text-center">
        <span className="text-[11px] uppercase tracking-widest text-ink-muted">Naziv računa</span>
        <span className="text-lg font-semibold text-ink-primary break-words">{label}</span>
      </Card>
      <p className="text-center text-xs text-ink-muted">
        Novi račun je nova adresa pod istim passkeyem i istim recovery ključem. Bez gas-a dok
        ne primi ili pošalje sredstva.
      </p>
      <div className="flex flex-col gap-3">
        <Button onClick={onConfirm} size="xl" block>
          <Check className="h-5 w-5" />
          Otvori račun
        </Button>
        <Button onClick={onReject} variant="ghost" size="md" block>
          Odbij
        </Button>
      </div>
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

/** Autofill anchor for conditional-mediation passkey discovery. The actual get()
 * is armed in Landing's effect; this just provides the autocomplete="webauthn"
 * field the OS attaches passkey suggestions to. The user doesn't type — tapping the
 * field surfaces their saved passkey (where the platform supports it). */
function ConditionalSignInField() {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="dw-passkey-autofill" className="px-1 text-xs text-ink-muted">
        Već imaš wallet? Otvori ga postojećim passkeyem:
      </label>
      <div className="relative">
        <Fingerprint className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
        <input
          id="dw-passkey-autofill"
          type="text"
          autoComplete="webauthn"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="Dodirni i odaberi spremljeni passkey"
          className="w-full rounded-2xl border border-surface-border bg-surface-raised py-3 pl-9 pr-3 text-sm text-ink-primary placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand-navy-300"
        />
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
          Kreiraj novi wallet
        </Button>
        <Button onClick={onCrossDevice} variant="ghost" size="sm" block>
          <RefreshCw className="h-4 w-4" />
          Otvori postojeći wallet (passkey)
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
  onRequestArchive: (record: PasskeyRecord, balance?: bigint) => void;
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
            onArchive={() => onRequestArchive(record, balances.get(record.safeAddress.toLowerCase()))}
          />
        ))}
      </div>

      {tooManyHint}

      <div className="flex flex-col gap-2 pt-1">
        <Button onClick={onCrossDevice} variant="ghost" size="sm" block>
          <RefreshCw className="h-4 w-4" />
          Wallet nije na popisu? Otvori ga passkeyem
        </Button>
        <Button onClick={onCreate} variant="ghost" size="sm" block>
          <Plus className="h-4 w-4" />
          Kreiraj novi wallet (novi passkey)
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
  balance,
  onCancel,
  onConfirm,
}: {
  record: PasskeyRecord;
  balance?: bigint;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const funded = balance !== undefined && balance > 0n;
  return (
    <div className="flex flex-col gap-6 animate-route-enter">
      <div className="text-center flex flex-col gap-2">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-sunken text-ink-secondary">
          <Archive className="h-7 w-7" />
        </div>
        <h2 className="text-2xl font-semibold text-ink-primary">Ukloni ovaj novčanik?</h2>
        <p className="text-sm text-ink-secondary max-w-sm mx-auto">
          <span className="font-mono text-ink-primary">{shorten(record.safeAddress)}</span>{' '}
          ({displayPasskeyLabel(record)})
        </p>
        <p className="text-sm">
          <span className="text-ink-muted">Stanje: </span>
          <span className={funded ? 'font-semibold text-brand-red-700' : 'font-medium text-ink-secondary'}>
            {balance === undefined ? '…' : `${formatEureShort(balance)} EURe`}
          </span>
        </p>
      </div>

      {funded ? (
        <Card padding="md" className="flex items-start gap-2 border-brand-red-500/40 text-sm text-brand-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <p>
            Ovaj novčanik <span className="font-semibold">ima sredstva</span>. Ako ga ukloniš
            ovdje, novci ostaju na adresi na blockchainu, ali ga moraš ponovno otvoriti
            (passkey / recovery ključ) da im pristupiš. Razmisli prije nego nastaviš.
          </p>
        </Card>
      ) : (
        <Card padding="md" className="flex flex-col gap-2 text-sm text-ink-secondary">
          <p>
            <span className="font-medium text-ink-primary">Prazan novčanik.</span> Sigurno za
            uklanjanje — novci (ako ikad stignu) ostaju na adresi na blockchainu.
          </p>
        </Card>
      )}

      <Card padding="md" className="flex flex-col gap-2 text-sm text-ink-secondary">
        <p>
          Uklanjanje vrijedi <span className="font-medium text-ink-primary">samo za popis na
          ovom uređaju</span>. Tvoj passkey ostaje netaknut u Apple Passwords / Google
          Password Manageru — i dalje je potpisnik svih svojih računa, pa mu uvijek možeš
          pristupiti.
        </p>
        <p>
          Wallet vraćaš preko{' '}
          <span className="font-medium text-ink-primary">Wallet nije na popisu? Otvori ga
          passkeyem</span> na prethodnom ekranu.
        </p>
      </Card>

      <div className="flex flex-col gap-2">
        <Button onClick={onConfirm} size="xl" block variant={funded ? 'secondary' : 'primary'}>
          <Archive className="h-5 w-5" />
          {funded ? 'Svejedno ukloni' : 'Ukloni novčanik'}
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
          rezervu — uvezeš ga u MetaMask ili Safe Mobile i isti wallet koristiš bilo gdje.
          Wallet radi i bez njega — passkey je glavni.
        </p>
      </div>

      <Card padding="md" className="flex flex-col gap-3">
        <FeatureRow
          icon={<KeyRound />}
          title="Jedan passkey"
          description="Tvoj jedini ključ za prijavu — u Apple Passwords / Google Password Manageru."
        />
        <FeatureRow
          icon={<ShieldCheck />}
          title="Recovery ključ"
          description="Rezerva za MetaMask, app.safe.global i Safe Mobile. Prikaže se jednom."
        />
        <FeatureRow
          icon={<Zap />}
          title="Nula vendor lock-ina"
          description="Tvoj wallet je standardni Safe — od prvog dana ga možeš koristiti i bez ove aplikacije. 100% P2P."
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
 * Passkey-store recommendation: Apple Passwords / Google Password Manager and
 * NOTHING else. On iPhone/Android the native store gates the signer behind
 * hardware unlock (Secure Enclave / StrongBox + biometrija) — browser-extension
 * managers (LastPass, 1Password, Brave profil…) don't give that guarantee. We
 * cannot pick the provider for the user (WebAuthn gives the RP no such control
 * — see passkeyProviderHint), so we recommend loudly and point at the OS
 * setting; the final choice stays theirs. Expanded steps collapsed by default.
 */
function ProviderHintCard() {
  const [open, setOpen] = useState(false);
  const hint = passkeyProviderHint();
  return (
    <div className="rounded-2xl border border-surface-border bg-surface-sunken/50">
      <div className="flex items-start gap-2 px-4 pt-3">
        <ShieldCheck className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
        <p className="text-xs leading-relaxed text-ink-secondary">
          <span className="font-semibold text-ink-primary">
            Preporuka: spremi passkey u Apple Passwords ili Google Password Manager.
          </span>{' '}
          Na iPhoneu i Androidu oni otključavaju potpisnika hardverski (Secure Enclave /
          StrongBox + Face ID), pa je to najsigurnija razina zaštite. Browser ekstenzije
          poput LastPassa, 1Passworda ili Brave profila{' '}
          <span className="font-semibold">ne preporučujemo</span> — odluka je na kraju tvoja.
        </p>
      </div>
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
function displayPasskeyLabel(record: PasskeyRecord): string {
  if (record.keychainName) return record.keychainName;
  if (record.nameSuffix) return `wa_${record.nameSuffix}`;
  return 'Safe';
}

/** Rotating educational lines for the on-chain deploy wait — the user reads
 * what's actually happening instead of staring at a frozen screen. */
const DEPLOY_MESSAGES = [
  'Deployam tvoj Safe smart account na Gnosis Chain…',
  'Tvoj passkey postaje vlasnik novog Safe-a…',
  'Standardni Safe — ista tehnologija koja onchain čuva milijarde eura…',
  'Gas za deploy plaćamo mi — tebe ovo ništa ne košta…',
  'Pripremam i tvoj 12-riječni recovery seed…',
  'Još koja sekunda — blockchain potvrđuje transakciju…',
];

function CreatingView({ phase }: { phase: CreatePhase }) {
  // Cycle the deploy messages so the wait feels alive; index resets per mount.
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    if (phase !== 'deploying') return;
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % DEPLOY_MESSAGES.length), 2800);
    return () => clearInterval(t);
  }, [phase]);

  if (phase === 'passkey') {
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

  return (
    <div className="flex flex-col items-center justify-center gap-6 py-12 animate-route-enter">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-brand-navy-400/20 animate-ping" />
        <div className="relative flex h-20 w-20 items-center justify-center rounded-full bg-brand-navy-700 text-white dark:bg-brand-navy-400 dark:text-brand-navy-900">
          <RefreshCw className="h-10 w-10 animate-spin" />
        </div>
      </div>
      <div className="text-center flex flex-col gap-2">
        <p className="font-semibold text-ink-primary text-lg">
          {phase === 'deriving' ? 'Otvaram novi račun…' : 'Kreiram tvoj wallet…'}
        </p>
        {phase === 'deploying' && (
          <p className="text-sm text-ink-secondary max-w-xs min-h-[2.5rem]" aria-live="polite">
            {DEPLOY_MESSAGES[msgIdx]}
          </p>
        )}
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
  // MANDATORY seed onboarding: the seed is the ONLY portable key and it's shown
  // exactly once, so entering the wallet requires the full pass — reveal →
  // copy/download (backedUp) → explicit "I know this never shows again"
  // checkbox. The old "Nastavi bez seeda" skip is gone by product decision: we
  // guarantee the user SAW and ACTED on the seed; whether they truly stored it
  // safely is their responsibility.
  const [backedUp, setBackedUp] = useState(false);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const words = recoverySeed ? recoverySeed.split(/\s+/) : [];

  async function copySeed() {
    if (!recoverySeed) return;
    // The click itself is the act we gate on — clipboard failure (rare, non-secure
    // contexts) must not dead-end the mandatory flow, the words stay readable.
    setBackedUp(true);
    try {
      await navigator.clipboard.writeText(recoverySeed);
      setCopied(true);
      haptic('success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — user can still read the words */
    }
  }

  const [generating, setGenerating] = useState<PaperWalletFormat | null>(null);

  async function downloadPaperWallet(format: PaperWalletFormat) {
    if (!recoverySeed || generating) return;
    setGenerating(format);
    try {
      await downloadPaperWalletPdf(record.safeAddress, recoverySeed, format);
      setBackedUp(true);
      haptic('success');
    } catch (e) {
      // PDF generation is pure-local; a failure here shouldn't dead-end the
      // flow — the user still has Kopiraj seed as the backup action.
      console.error('[CreatedView] paper wallet PDF failed', e);
      haptic('error');
    } finally {
      setGenerating(null);
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
              Recovery seed — obavezan korak
            </span>
            <p className="text-xs text-ink-secondary leading-snug">
              12-riječni rezervni ključ — uvezeš ga u MetaMask (desktop) ili{' '}
              <span className="font-medium text-ink-primary">Safe Mobile</span> (iOS/Android)
              i isti Safe koristiš svugdje, potpuno bez ove aplikacije. Prikazuje se{' '}
              <span className="font-semibold">samo sad i nikad više</span> — nigdje nije
              spremljen, zato ga moraš pogledati i spremiti prije ulaska u wallet.
            </p>
          </div>
          <Button onClick={() => setRevealed(true)} size="md" block>
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
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => void downloadPaperWallet('a4')}
              disabled={generating !== null}
              variant="secondary"
              size="md"
              block
            >
              <Download className="h-4 w-4" />
              {generating === 'a4' ? 'Generiram…' : 'Paper wallet A4'}
            </Button>
            <Button
              onClick={() => void downloadPaperWallet('photo')}
              disabled={generating !== null}
              variant="secondary"
              size="md"
              block
            >
              <Download className="h-4 w-4" />
              {generating === 'photo' ? 'Generiram…' : 'Foto 15×10'}
            </Button>
          </div>
          <p className="text-[11px] text-ink-muted leading-snug">
            <span className="font-medium text-ink-secondary">Paper wallet</span> je obostrani
            PDF (2 stranice): <span className="font-medium text-ink-secondary">javna strana</span>{' '}
            s QR adresom koju smiješ slati za uplate i{' '}
            <span className="font-medium text-ink-secondary">privatna strana</span> sa seedom
            i označenom zonom za sigurnosnu naljepnicu. A4 za običan printer, 15×10 cm za
            foto printer (DNP termosublimacija). Isprintaj obje strane, laminiraj ih
            leđa-o-leđa, seed prelijepi naljepnicom — i spremi (ili zakopaj). Generira se
            potpuno offline; obriši datoteku nakon ispisa.{' '}
            <span className="font-medium text-ink-secondary">Preporuka za uvoz:</span>{' '}
            <span className="font-medium text-ink-secondary">Safe Mobile</span> (iOS/Android) —
            ima potpisivanje, push notifikacije kad ti stignu tokeni i sve Safe funkcije. Na
            desktopu radi i MetaMask (Uvezi račun → Tajna fraza za oporavak) uz
            app.safe.global. Tako od prvog dana nisi vezan za DOMOVINA Wallet — tvoj Safe je
            100% tvoj, u bilo kojem Safe walletu. Ovaj ključ je drugi potpisnik (1-od-2) —
            wallet i dalje radi i bez njega, preko passkeya.
          </p>
          <label
            className={
              'flex items-start gap-2.5 rounded-xl bg-surface-sunken px-3 py-2.5 select-none ' +
              (backedUp ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed')
            }
          >
            <input
              type="checkbox"
              checked={savedConfirmed}
              disabled={!backedUp}
              onChange={(e) => setSavedConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-brand-navy-500"
            />
            <span className="text-xs text-ink-primary leading-snug">
              Spremio/la sam svih 12 riječi na sigurno mjesto. Svjestan/na sam da je ovo{' '}
              <span className="font-semibold">zadnji i jedini put</span> da se prikazuju —
              nisu nigdje spremljene i nitko ih ne može vratiti.
            </span>
          </label>
          {!backedUp && (
            <p className="text-[11px] text-ink-muted text-center">
              Kopiraj seed ili preuzmi paper wallet da nastaviš.
            </p>
          )}
        </Card>
      )}

      <Button
        onClick={onEnter}
        disabled={!!recoverySeed && !(revealed && savedConfirmed)}
        size="xl"
        block
      >
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
