// Project Safe (ADR 0027): deterministic address, birth with the Monerium link
// message already signed, and the on-chain checks Monerium itself runs.
// Shared by the setup dApp (browser), the Worker (POST …/projects) and
// tools/funding (funding-init, deploy-safe, link-safe).
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getContractAddress,
  hashMessage,
  hexToBigInt,
  keccak256,
  toBytes,
  zeroAddress,
} from 'viem';

// Safe contracts per version. Gnosis runs 1.5.0, like the energy Safes made by
// app.safe.global. Chiado has only canonical 1.3.0 (1.4.1 and 1.5.0 are not
// deployed there, checked 11. 10. 2026.). setup() and ERC-1271 through the
// fallback handler behave the same, so 1.3.0 is enough to test the flow.
// SignMessageLib 1.5.0 on Gnosis: codehash 0xd618…c50e = safe-deployments (17. 10. 2026.).
export const SAFE_CONTRACTS = {
  '1.5.0': {
    factory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
    singletonL2: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
    fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
    signMessageLib: '0x4FfeF8222648872B3dE295Ba1e49110E61f5b5aa',
  },
  '1.3.0': {
    factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
    singletonL2: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
    fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
    signMessageLib: '0xA65387F16B013cf2Af4605Ad8aA5ec25a2cbA3a2',
  },
};

export const SAFE_VERSION = { gnosis: '1.5.0', chiado: '1.3.0' };

// Signers as on the energy Safes (energy.domovina.ai lib/beta-projects.ts).
export const DEFAULT_OWNERS = [
  '0x4924f440A12ac82F6e06B058a33d7fd8182f1944', // ms-dom-energy-signer
  '0xF3c4d416Fa863F0801605629097ffF07f1d46FB8', // ds-dom-energy-signer
  '0xC2386b03441C6104F8d40E52e74306EAE830A24B', // md-dom-energy-signer
];
export const DEFAULT_THRESHOLD = 2;

export const FACTORY_ABI = [{
  type: 'function', name: 'proxyCreationCode', stateMutability: 'pure',
  inputs: [], outputs: [{ type: 'bytes' }],
}, {
  type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable',
  inputs: [{ name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }],
  outputs: [{ name: 'proxy', type: 'address' }],
}];
const SETUP_ABI = [{
  type: 'function', name: 'setup', stateMutability: 'nonpayable',
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
  ],
  outputs: [],
}];
export const SAFE_READ_ABI = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const SIGN_MESSAGE_LIB_ABI = [{
  type: 'function', name: 'signMessage', stateMutability: 'nonpayable',
  inputs: [{ name: '_data', type: 'bytes' }], outputs: [],
}];
const IS_VALID_SIGNATURE_ABI = [{
  type: 'function', name: 'isValidSignature', stateMutability: 'view',
  inputs: [{ name: '_dataHash', type: 'bytes32' }, { name: '_signature', type: 'bytes' }],
  outputs: [{ type: 'bytes4' }],
}];

/// Message Monerium asks to be signed as proof of address ownership (POST /addresses).
export const MONERIUM_LINK_MESSAGE = 'I hereby declare that I am the address owner.';
const ERC1271_MAGIC = '0x1626ba7e';

/// Salt from a readable label, e.g. "italk-sandbox:main" or "project:<slug>".
export function saltFromLabel(label) {
  return hexToBigInt(keccak256(toBytes(label)));
}

export const projectSaltLabel = (campaignId) => `project:${campaignId}`;

/// Delegatecall in setup() that makes the Safe "sign" the Monerium message at
/// birth (SignMessageLib → signedMessages[hash] = 1). For an empty signature
/// the fallback handler's ERC-1271 checks exactly signedMessages for
/// SafeMessage(abi.encode(hashMessage(message))), so this is the same record
/// as an owners' SignMessageLib transaction.
export function linkSignatureSetupCall(sc) {
  if (!sc.signMessageLib) throw new Error('SignMessageLib za ovu verziju Safea nije poznat');
  const data = encodeAbiParameters([{ type: 'bytes32' }], [hashMessage(MONERIUM_LINK_MESSAGE)]);
  return { to: sc.signMessageLib, data: encodeFunctionData({ abi: SIGN_MESSAGE_LIB_ABI, functionName: 'signMessage', args: [data] }) };
}

export function safeInitializer(owners, threshold, fallbackHandler, setupCall = null) {
  return encodeFunctionData({
    abi: SETUP_ABI, functionName: 'setup',
    args: [owners.map((o) => o.toLowerCase()), BigInt(threshold), setupCall?.to ?? zeroAddress, setupCall?.data ?? '0x', fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}

/// Owners and threshold a page or CLI may ask for: distinct addresses,
/// 1 ≤ threshold ≤ owners. Throws a readable error otherwise.
export function checkOwners(owners, threshold) {
  const lc = owners.map((o) => String(o).trim().toLowerCase());
  if (lc.length === 0) throw new Error('Safe treba barem jednog vlasnika');
  if (lc.some((o) => !/^0x[0-9a-f]{40}$/.test(o))) throw new Error('vlasnik nije EVM adresa');
  if (new Set(lc).size !== lc.length) throw new Error('isti vlasnik je naveden dvaput');
  const t = Number(threshold);
  if (!Number.isInteger(t) || t < 1 || t > lc.length) throw new Error(`prag mora biti 1…${lc.length}`);
}

/// Everything about the Safe that follows from owners, threshold and salt:
/// createProxyWithNonce args and the CREATE2 address. `creationCode` is the
/// factory's proxyCreationCode() (readProxyCreationCode); the address is what
/// SafeProxyFactory computes: salt = keccak(keccak(initializer) ++ saltNonce),
/// init code = proxyCreationCode ++ uint256(singleton).
export function projectSafePlan({ version, owners, threshold, saltLabel, preSignLink = true, creationCode }) {
  const sc = SAFE_CONTRACTS[version];
  if (!sc) throw new Error(`nepoznata verzija Safea: ${version}`);
  checkOwners(owners, threshold);
  const initializer = safeInitializer(owners, threshold, sc.fallbackHandler, preSignLink ? linkSignatureSetupCall(sc) : null);
  const saltNonce = saltFromLabel(saltLabel);
  const address = getContractAddress({
    opcode: 'CREATE2',
    from: sc.factory,
    salt: keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce])),
    bytecode: concat([creationCode, encodeAbiParameters([{ type: 'uint256' }], [hexToBigInt(sc.singletonL2)])]),
  });
  return { address, factory: sc.factory, args: [sc.singletonL2, initializer, saltNonce], contracts: sc };
}

export async function readProxyCreationCode(pub, version) {
  return pub.readContract({ address: SAFE_CONTRACTS[version].factory, abi: FACTORY_ABI, functionName: 'proxyCreationCode' });
}

/// Factory, singleton and fallback handler must have code on this chain.
export async function assertSafeContracts(pub, version) {
  const sc = SAFE_CONTRACTS[version];
  for (const [name, a] of [['SafeProxyFactory', sc.factory], ['SafeL2 singleton', sc.singletonL2], ['fallback handler', sc.fallbackHandler]]) {
    const code = await pub.getCode({ address: a });
    if (!code || code === '0x') throw new Error(`${name} ${a} nema koda na ovom chainu`);
  }
}

export async function hasCode(pub, address) {
  const code = await pub.getCode({ address });
  return !!code && code !== '0x';
}

/// Does the ERC-1271 check Monerium runs pass (isValidSignature(hash, "0x"))?
export async function isLinkSigned(pub, safe) {
  try {
    const r = await pub.readContract({ address: safe, abi: IS_VALID_SIGNATURE_ABI, functionName: 'isValidSignature', args: [hashMessage(MONERIUM_LINK_MESSAGE), '0x'] });
    return r === ERC1271_MAGIC;
  } catch {
    return false;
  }
}

export async function readSafeOwners(pub, address) {
  const [owners, threshold] = await Promise.all([
    pub.readContract({ address, abi: SAFE_READ_ABI, functionName: 'getOwners' }),
    pub.readContract({ address, abi: SAFE_READ_ABI, functionName: 'getThreshold' }),
  ]);
  return { owners, threshold: Number(threshold) };
}

export function sameOwners(a, b) {
  const n = (x) => JSON.stringify(x.map((o) => o.toLowerCase()).sort());
  return n(a) === n(b);
}

/// The Safe on chain has exactly the expected owners and threshold.
export async function verifySafe(pub, address, owners, threshold) {
  const on = await readSafeOwners(pub, address);
  return { ok: sameOwners(owners, on.owners) && on.threshold === threshold, ...on };
}
