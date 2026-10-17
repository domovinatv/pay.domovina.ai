/**
 * Safe multisig transactions without the Safe web app (ADR 0027): EIP-712
 * SafeTx, MultiSendCallOnly packing, full-batch simulation, signature
 * packing and the Safe Transaction Service queue. Shared by tools/funding and
 * the tenant setup dApp; pure (viem + fetch), so esbuild can bundle it.
 *
 * Verified 2026-10-17 on both chains we use: italk-sandbox main Safe on
 * Chiado runs 1.3.0, the MPT main Safe on Gnosis 1.4.1. Both versions share
 * the EIP-712 domain {chainId, verifyingContract} and the SafeTx type below.
 */
import {
  concatHex,
  decodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashTypedData,
  pad,
  size,
  sliceHex,
} from 'viem';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/// Per chain id: Safe Transaction Service and the MultiSendCallOnly /
/// SimulateTxAccessor deployments (1.3.0 on Chiado, the only version there;
/// 1.4.1 on Gnosis). Both are version-agnostic: called by delegatecall.
export const SAFE_CHAINS = {
  10200: {
    name: 'chiado',
    txService: 'https://api.safe.global/tx-service/chi',
    app: 'chi',
    multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
    simulateTxAccessor: '0x59AD6735bCd8152B84860Cb256dD9e96b85F69Da',
  },
  100: {
    name: 'gnosis',
    txService: 'https://api.safe.global/tx-service/gno',
    app: 'gno',
    multiSendCallOnly: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
    simulateTxAccessor: '0x3d4BA2E0884aa488718476ca2FB8Efc291A46199',
  },
};

export const SAFE_TX_ABI = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getTransactionHash', stateMutability: 'view', outputs: [{ type: 'bytes32' }], inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: '_nonce', type: 'uint256' },
  ] },
  { type: 'function', name: 'execTransaction', stateMutability: 'payable', outputs: [{ type: 'bool' }], inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' },
  ] },
  { type: 'function', name: 'simulateAndRevert', stateMutability: 'nonpayable', outputs: [], inputs: [
    { name: 'targetContract', type: 'address' }, { name: 'calldataPayload', type: 'bytes' },
  ] },
  { type: 'event', name: 'ExecutionSuccess', inputs: [
    { name: 'txHash', type: 'bytes32', indexed: false }, { name: 'payment', type: 'uint256', indexed: false },
  ] },
  { type: 'event', name: 'ExecutionFailure', inputs: [
    { name: 'txHash', type: 'bytes32', indexed: false }, { name: 'payment', type: 'uint256', indexed: false },
  ] },
];

const MULTISEND_ABI = [{ type: 'function', name: 'multiSend', stateMutability: 'payable', outputs: [],
  inputs: [{ name: 'transactions', type: 'bytes' }] }];

const ACCESSOR_ABI = [{ type: 'function', name: 'simulate', stateMutability: 'nonpayable', inputs: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
  { name: 'operation', type: 'uint8' },
], outputs: [
  { name: 'estimate', type: 'uint256' }, { name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' },
] }];

/// Safe MultiSend packing: operation(1) to(20) value(32) dataLength(32) data.
export function encodeMultiSendCallOnly(calls) {
  return encodeFunctionData({ abi: MULTISEND_ABI, functionName: 'multiSend', args: [concatHex(calls.map((c) =>
    encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, getAddress(c.to), BigInt(c.value ?? 0), BigInt(size(c.data)), c.data])))] });
}

/// A list of CALLs as one Safe tx: the call itself when there is one,
/// otherwise a DelegateCall to MultiSendCallOnly (the only delegatecall
/// target the Safe apps and the Transaction Service accept without warning).
export function batchToSafeTx(calls, chainId) {
  if (calls.length === 0) throw new Error('empty batch');
  if (calls.length === 1) {
    return { to: getAddress(calls[0].to), value: BigInt(calls[0].value ?? 0), data: calls[0].data, operation: 0 };
  }
  const c = SAFE_CHAINS[chainId];
  if (!c) throw new Error(`no MultiSendCallOnly known for chain ${chainId}`);
  return { to: getAddress(c.multiSendCallOnly), value: 0n, data: encodeMultiSendCallOnly(calls), operation: 1 };
}

/// EIP-712 typed data of a Safe tx (no gas refund: safeTxGas, baseGas,
/// gasPrice all 0, so the executor pays its own gas and nothing else moves).
export function safeTxTypedData({ chainId, safe, tx, nonce }) {
  return {
    domain: { chainId: Number(chainId), verifyingContract: getAddress(safe) },
    types: {
      SafeTx: [
        { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx',
    message: {
      to: getAddress(tx.to), value: BigInt(tx.value ?? 0), data: tx.data, operation: Number(tx.operation),
      safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS,
      nonce: BigInt(nonce),
    },
  };
}

/// safeTxHash computed locally AND by the Safe itself; any difference (wrong
/// chain, wrong Safe, unsupported version) is a hard stop before signing.
export async function safeTxHash(client, { chainId, safe, tx, nonce }) {
  const local = hashTypedData(safeTxTypedData({ chainId, safe, tx, nonce }));
  const onchain = await client.readContract({
    address: getAddress(safe), abi: SAFE_TX_ABI, functionName: 'getTransactionHash',
    args: [getAddress(tx.to), BigInt(tx.value ?? 0), tx.data, Number(tx.operation), 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, BigInt(nonce)],
  });
  if (local.toLowerCase() !== onchain.toLowerCase()) {
    throw new Error(`safeTxHash mismatch: local ${local}, Safe ${onchain}`);
  }
  return onchain;
}

/// Signature an owner gets for free by sending the execTransaction itself
/// (Safe signature type v=1: r = owner, s = 0).
export function preValidatedSignature(owner) {
  return concatHex([pad(getAddress(owner), { size: 32 }), pad('0x', { size: 32 }), '0x01']);
}

/// Safe wants signatures concatenated in ascending signer order, one per owner.
export function packSignatures(sigs) {
  const seen = new Set();
  const sorted = [...sigs].sort((a, b) => (a.signer.toLowerCase() < b.signer.toLowerCase() ? -1 : 1));
  for (const s of sorted) {
    const k = s.signer.toLowerCase();
    if (seen.has(k)) throw new Error(`two signatures from ${s.signer}`);
    seen.add(k);
    if (size(s.data) !== 65) throw new Error(`signature of ${s.signer} is ${size(s.data)} bytes, expected 65`);
  }
  return concatHex(sorted.map((s) => s.data));
}

/// Runs the Safe tx as the Safe (delegatecall into SimulateTxAccessor inside
/// simulateAndRevert): no signatures, no state change, the whole batch in
/// order. Returns { success, gas, returnData }.
export async function simulateSafeTx(client, { chainId, safe, tx }) {
  const c = SAFE_CHAINS[chainId];
  if (!c) throw new Error(`no SimulateTxAccessor known for chain ${chainId}`);
  const payload = encodeFunctionData({
    abi: ACCESSOR_ABI, functionName: 'simulate',
    args: [getAddress(tx.to), BigInt(tx.value ?? 0), tx.data, Number(tx.operation)],
  });
  const data = encodeFunctionData({ abi: SAFE_TX_ABI, functionName: 'simulateAndRevert', args: [c.simulateTxAccessor, payload] });
  let raw;
  try {
    await client.request({ method: 'eth_call', params: [{ to: getAddress(safe), data }, 'latest'] });
    throw new Error('simulateAndRevert did not revert');
  } catch (e) {
    raw = revertData(e);
    if (!raw) throw e;
  }
  // revert(success(32) | returndatasize(32) | returndata)
  const ok = BigInt(sliceHex(raw, 0, 32)) === 1n;
  if (!ok) return { success: false, gas: 0n, returnData: raw };
  const [gas, success, returnData] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'bool' }, { type: 'bytes' }],
    sliceHex(raw, 64),
  );
  return { success, gas, returnData };
}

function revertData(e) {
  for (let x = e; x; x = x.cause) {
    const d = x.data?.data ?? x.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length > 2) return d;
  }
  return null;
}

// ── Safe Transaction Service ──────────────────────────────────────────────

async function txs(url, init) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

function service(chainId) {
  const c = SAFE_CHAINS[chainId];
  if (!c) throw new Error(`no Safe Transaction Service known for chain ${chainId}`);
  return c.txService;
}

/// Queued (not executed) multisig txs of the Safe, newest nonce first.
export async function queuedSafeTxs(chainId, safe) {
  const r = await txs(`${service(chainId)}/api/v1/safes/${getAddress(safe)}/multisig-transactions/?executed=false&limit=100&ordering=-nonce`);
  if (r.status !== 200) throw new Error(`tx service ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json.results ?? [];
}

/// Next free nonce: one above the highest queued tx at or above the chain nonce.
export function nextNonce(onchainNonce, queued) {
  const live = queued.filter((t) => BigInt(t.nonce) >= onchainNonce);
  return live.length ? live.reduce((m, t) => (BigInt(t.nonce) > m ? BigInt(t.nonce) : m), 0n) + 1n : onchainNonce;
}

export async function getSafeTx(chainId, hash) {
  const r = await txs(`${service(chainId)}/api/v1/multisig-transactions/${hash}/`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`tx service ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json;
}

/// Propose a Safe tx signed by an owner or delegate (`sender`).
export async function proposeToService(chainId, { safe, tx, nonce, hash, sender, signature, origin }) {
  const body = {
    to: getAddress(tx.to), value: BigInt(tx.value ?? 0).toString(), data: tx.data, operation: Number(tx.operation),
    safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO_ADDRESS, refundReceiver: ZERO_ADDRESS,
    nonce: BigInt(nonce).toString(), contractTransactionHash: hash,
    sender: getAddress(sender), signature, origin,
  };
  const r = await txs(`${service(chainId)}/api/v1/safes/${getAddress(safe)}/multisig-transactions/`, { method: 'POST', body: JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`prijedlog odbijen (${r.status}): ${r.text.slice(0, 300)}`);
}

/// Add one owner's signature to a queued tx.
export async function confirmOnService(chainId, hash, signature) {
  const r = await txs(`${service(chainId)}/api/v1/multisig-transactions/${hash}/confirmations/`, {
    method: 'POST', body: JSON.stringify({ signature }),
  });
  if (r.status >= 300) throw new Error(`potvrda odbijena (${r.status}): ${r.text.slice(0, 300)}`);
}
