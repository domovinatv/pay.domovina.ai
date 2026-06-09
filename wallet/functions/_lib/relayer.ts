/**
 * Relayer account + viem client construction, shared by every gas-sponsoring
 * Worker. The private-key normalization (trim → 0x prefix → 64-hex validation)
 * was previously duplicated in relay.ts and bootstrap-deploy.ts; wrangler secrets
 * sometimes arrive without the 0x prefix or with stray whitespace and viem's
 * privateKeyToAccount is strict about both (see memory: private-key-secret-
 * normalization).
 */
import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';

export type RelayerClients = ReturnType<typeof makeRelayer>['clients'];

/** A typed error string the caller turns into a 500 JSON response. */
export type RelayerLoadError = { ok: false; error: string };
export type RelayerLoadOk = { ok: true } & ReturnType<typeof makeRelayer>;

function makeRelayer(normalizedKey: Hex, rpcUrl: string) {
  const account = privateKeyToAccount(normalizedKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: gnosis, transport });
  const wallet = createWalletClient({ account, chain: gnosis, transport });
  return { account, clients: { publicClient, wallet } };
}

/**
 * Validate + normalize RELAYER_PRIVATE_KEY and build the public + wallet clients.
 * Returns a discriminated union so callers can early-return a clean 500 instead of
 * letting a malformed-secret error fall through to a generic catch.
 */
export function loadRelayer(
  rawKeyInput: string | undefined,
  rpcUrl: string | undefined,
): RelayerLoadOk | RelayerLoadError {
  const rawKey = (rawKeyInput ?? '').trim();
  if (!rawKey) return { ok: false, error: 'RELAYER_PRIVATE_KEY not configured' };
  const normalizedKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedKey)) {
    return {
      ok: false,
      error: `RELAYER_PRIVATE_KEY malformed (expected 0x + 64 hex chars, got ${normalizedKey.length} chars)`,
    };
  }
  return { ok: true, ...makeRelayer(normalizedKey, rpcUrl ?? 'https://rpc.gnosischain.com') };
}

/** Whether an address currently holds code on-chain (i.e. is deployed). */
export async function isDeployed(
  publicClient: RelayerClients['publicClient'],
  address: `0x${string}`,
): Promise<boolean> {
  const code = await publicClient.getCode({ address });
  return !!code && code !== '0x';
}
