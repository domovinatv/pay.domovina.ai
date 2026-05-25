import { encodeFunctionData, type Address, type Hex } from 'viem';

const OWNER_MANAGER_ABI = [
  {
    inputs: [
      { type: 'address', name: 'owner' },
      { type: 'uint256', name: '_threshold' },
    ],
    name: 'addOwnerWithThreshold',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

/** Encode a self-call on the Safe that adds `newOwner` and sets threshold.
 * The Safe self-call (target = safeAddress) is the canonical way to mutate
 * the owner set via execTransaction. */
export function encodeAddOwnerWithThreshold(newOwner: Address, threshold: bigint): Hex {
  return encodeFunctionData({
    abi: OWNER_MANAGER_ABI,
    functionName: 'addOwnerWithThreshold',
    args: [newOwner, threshold],
  });
}
