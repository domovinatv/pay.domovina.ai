import { erc20Abi, formatUnits, type Address } from 'viem';
import { EURE_ADDRESS, EURE_DECIMALS } from './constants';
import { publicClient } from './safe';

/**
 * Batched EURe balance fetch for the wallet picker. Single eth_call via the
 * canonical Multicall3 (`gnosis.contracts.multicall3` in constants.ts), so
 * showing balances for 15 wallets is one network roundtrip instead of 15.
 * Read-only, no gas. Returns a map keyed by the lowercase address. Missing
 * entries mean either the RPC failed for that lookup OR the address was
 * never passed in — callers should treat absent as "loading / unknown",
 * not as zero.
 */
export async function fetchEureBalances(
  addresses: readonly Address[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (addresses.length === 0) return out;
  const results = await publicClient.multicall({
    contracts: addresses.map(
      (addr) =>
        ({
          address: EURE_ADDRESS,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [addr],
        }) as const,
    ),
    allowFailure: true,
  });
  results.forEach((r, i) => {
    if (r.status === 'success') {
      out.set(addresses[i].toLowerCase(), r.result as bigint);
    }
  });
  return out;
}

/** Human-friendly format for the wallet picker: "12.50", "0", "0.001". */
export function formatEureShort(raw: bigint): string {
  if (raw === 0n) return '0';
  const full = formatUnits(raw, EURE_DECIMALS);
  // Truncate to 2 decimals unless the amount is so tiny we'd round to zero.
  const num = Number(full);
  if (!Number.isFinite(num)) return full;
  if (num < 0.01) return num.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return num.toFixed(2);
}
