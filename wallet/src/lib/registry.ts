import type { Address } from 'viem';
import { PAYMENT_INTENT_API_BASE } from './constants';

export type PhoneBindingView = {
  phone_hash_short: string;
  first_bound_at: string;
  latest_verified_at: string;
  verification_count: number;
};

export type WalletRegistryView = {
  credential_id: string;
  pub_key_x: string;
  pub_key_y: string;
  signer_address: Address;
  safe_address: Address;
  rp_id: string;
  /** ADR 0013 reusable recovery owner (public address). Absent on legacy records /
   * older backends; lets a new device restore the identity's mint capability. */
  recovery_owner?: Address | null;
  has_phone: boolean;
  created_at: string;
  phone_bound_at: string | null;
  verification?: {
    count: number;
    first_at: string | null;
    latest_at: string | null;
  };
  phones?: PhoneBindingView[];
  last_binding?: {
    is_new_phone: boolean;
    verification_count: number;
  };
};

/**
 * Fire-and-forget register call after createPasskey. Failures here don't
 * block the user from using their wallet — they just lose customer-count
 * visibility and cross-device login. Best-effort.
 */
export async function registerWalletWithBackend(args: {
  credentialId: string;
  pubKeyX: string;
  pubKeyY: string;
  signerAddress: Address;
  safeAddress: Address;
  rpId: string;
  /** ADR 0013 reusable recovery owner address (public; never the mnemonic).
   * Lets the backend later rebuild the identity's derived accounts on a new
   * device. Optional — older/unupgraded backends ignore the extra field. */
  recoveryOwner?: Address;
}): Promise<WalletRegistryView | null> {
  console.log('[registry] register POST', { ...args, pubKeyX: args.pubKeyX.slice(0, 12) + '…' });
  try {
    const res = await fetch(`${PAYMENT_INTENT_API_BASE}/api/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const text = await res.text();
    console.log(`[registry] register response ${res.status}`, text.slice(0, 200));
    if (!res.ok) return null;
    return JSON.parse(text) as WalletRegistryView;
  } catch (e) {
    console.warn('[registry] register threw', e);
    return null;
  }
}

/**
 * ADR 0013 — best-effort registration of an ADDITIONAL account (Safe) under an
 * existing identity. Posts to a per-credential sub-collection so it can never
 * clobber the identity's primary (bootstrap) wallet record, which the backend
 * keys by credentialId. The backend must map credentialId → MANY safeAddresses
 * for cross-device restore of derived accounts to work; until it implements
 * this route the call 404s and we ignore it (the account still works locally
 * and deploys via the relay cold path on first send). Mnemonic is never sent —
 * only the recovery owner ADDRESS, which is public.
 */
export async function registerAccountWithBackend(args: {
  credentialId: string;
  safeAddress: Address;
  saltNonce: string;
  recoveryOwner: Address;
  name: string;
}): Promise<boolean> {
  try {
    const res = await fetch(
      `${PAYMENT_INTENT_API_BASE}/api/wallets/${encodeURIComponent(args.credentialId)}/accounts`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          safeAddress: args.safeAddress,
          saltNonce: args.saltNonce,
          recoveryOwner: args.recoveryOwner,
          name: args.name,
        }),
      },
    );
    console.log(`[registry] register account ${args.safeAddress.slice(0, 10)}… → ${res.status}`);
    return res.ok;
  } catch (e) {
    console.warn('[registry] register account threw', e);
    return false;
  }
}

/** A derived account as returned by the backend (cross-device restore). */
export type BackendAccount = {
  safe_address: Address;
  salt_nonce: string;
  recovery_owner: Address;
  name: string;
  created_at: string;
};

/** Fetch an identity's derived accounts from the backend so a new device can show
 * ALL of the user's accounts, not just the bootstrap one. Best-effort: returns []
 * on 404 (older backend / none) or any network error. */
export async function fetchAccountsFromBackend(credentialId: string): Promise<BackendAccount[]> {
  try {
    const res = await fetch(
      `${PAYMENT_INTENT_API_BASE}/api/wallets/${encodeURIComponent(credentialId)}/accounts`,
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { accounts?: BackendAccount[] };
    return body.accounts ?? [];
  } catch (e) {
    console.warn('[registry] fetch accounts threw', e);
    return [];
  }
}

export async function lookupWallet(credentialId: string): Promise<WalletRegistryView | null> {
  try {
    const res = await fetch(
      `${PAYMENT_INTENT_API_BASE}/api/wallets/${encodeURIComponent(credentialId)}`,
    );
    console.log(`[registry] lookup ${credentialId.slice(0, 14)}… → ${res.status}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[registry] lookup ${res.status}`);
      return null;
    }
    return (await res.json()) as WalletRegistryView;
  } catch (e) {
    console.warn('[registry] lookup threw', e);
    return null;
  }
}

/** Thrown by lookupWalletStrict when the registry can't be reached (network or
 * 5xx) — as opposed to a genuine 404. Lets callers avoid telling a user with a
 * real (possibly funded) wallet that it "doesn't exist". */
export class RegistryUnavailableError extends Error {}

/** Like lookupWallet, but distinguishes a genuine 404 (→ null, "no wallet") from
 * a transient failure (→ throws RegistryUnavailableError). Use on paths that
 * would otherwise route the user to "create a new wallet" on a network blip. */
export async function lookupWalletStrict(
  credentialId: string,
): Promise<WalletRegistryView | null> {
  let res: Response;
  try {
    res = await fetch(`${PAYMENT_INTENT_API_BASE}/api/wallets/${encodeURIComponent(credentialId)}`);
  } catch (e) {
    throw new RegistryUnavailableError(String(e));
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new RegistryUnavailableError(`registry ${res.status}`);
  return (await res.json()) as WalletRegistryView;
}

/** Submit an OTP verification id to bind a phone to an existing wallet record. */
export async function bindPhone(
  credentialId: string,
  otpVerificationId: string,
): Promise<{ ok: true; wallet: WalletRegistryView } | { ok: false; error: string }> {
  const res = await fetch(
    `${PAYMENT_INTENT_API_BASE}/api/wallets/${encodeURIComponent(credentialId)}/bind-phone`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ otpVerificationId }),
    },
  );
  if (!res.ok) {
    let err = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) err = body.error;
    } catch {
      /* ignore */
    }
    return { ok: false, error: err };
  }
  return { ok: true, wallet: (await res.json()) as WalletRegistryView };
}
