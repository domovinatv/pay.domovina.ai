import type { Address, Hex } from 'viem';

export type RelayRequest = {
  /** Safe (counterfactual or deployed) that will execute the user's tx. */
  safeAddress: Address;
  /** WebAuthn signer proxy address — also the Safe's sole owner. */
  signerAddress: Address;
  /** P-256 pubkey x, hex string. Server needs this to deploy the signer proxy on first send. */
  pubKeyX: string;
  /** P-256 pubkey y, hex string. */
  pubKeyY: string;
  /** Target contract (e.g. EURe). */
  to: Address;
  /** Value in wei. Stringified bigint to survive JSON. */
  value: string;
  /** Calldata for the target call (e.g. EURe.transfer encoded). */
  data: Hex;
  /** Safe contract-signature blob produced by encodeWebAuthnSignature. */
  signature: Hex;
};

export type RelayResponse =
  | { ok: true; txHash: Hex; deployed?: boolean }
  | { ok: false; error: string; rateLimited?: boolean };

export async function relayTx(req: RelayRequest): Promise<RelayResponse> {
  const res = await fetch('/api/relay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (res.status === 429) {
    return { ok: false, error: 'Daily free transaction limit reached', rateLimited: true };
  }
  return (await res.json()) as RelayResponse;
}

export type RelayStatus = {
  signerAddress: Address;
  used: number;
  remaining: number;
  limit: number;
  /** UTC midnight ISO when the counter resets. */
  resetsAt: string;
  /** Seconds remaining until reset. */
  resetsInSec: number;
};

/**
 * Fetch the current free-tier usage for the given signer. Backed by the
 * same KV key the POST handler increments, so the answer is authoritative
 * across tabs and devices. Safe to call on Send mount + a 60s tick.
 */
export async function getRelayStatus(signerAddress: Address): Promise<RelayStatus | null> {
  try {
    const res = await fetch(
      `/api/relay/status?signerAddress=${encodeURIComponent(signerAddress)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    return (await res.json()) as RelayStatus;
  } catch {
    return null;
  }
}
