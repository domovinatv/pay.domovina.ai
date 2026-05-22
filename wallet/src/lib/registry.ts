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
  signer_address: Address;
  safe_address: Address;
  rp_id: string;
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
