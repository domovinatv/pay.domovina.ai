import type { Address } from 'viem';
import { erc20Abi, formatUnits } from 'viem';
import { EURE_ADDRESS, EURE_DECIMALS } from './constants';
import { publicClient } from './safe';

export async function getEureBalance(account: Address): Promise<{ raw: bigint; formatted: string }> {
  const raw = await publicClient.readContract({
    address: EURE_ADDRESS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account],
  });
  return { raw, formatted: formatUnits(raw, EURE_DECIMALS) };
}
