// Zajednički dijelovi za funding-init: okruženja, Safe deploy, .env.
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient, createWalletClient, http, encodeFunctionData,
  keccak256, toBytes, hexToBigInt, getAddress, zeroAddress,
} from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Safe ugovori po okruženju. Na Gnosisu je 1.5.0, kao energy Safeovi koje je
// napravio app.safe.global. Chiado ima samo kanonski 1.3.0: 1.4.1 i 1.5.0 tamo
// nisu deployani (provjereno 11. 10. 2026.). setup() i ERC-1271 preko fallback
// handlera rade isto, pa je 1.3.0 dovoljan za test toka.
export const SAFE_CONTRACTS = {
  '1.5.0': {
    factory: '0x14F2982D601c9458F93bd70B218933A6f8165e7b',
    singletonL2: '0xEdd160fEBBD92E350D4D398fb636302fccd67C7e',
    fallbackHandler: '0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4',
  },
  '1.3.0': {
    factory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
    singletonL2: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
    fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  },
};

// Potpisnici kao kod energy Safeova (energy.domovina.ai lib/beta-projects.ts).
export const DEFAULT_OWNERS = [
  '0x4924f440A12ac82F6e06B058a33d7fd8182f1944', // ms-dom-energy-signer
  '0xF3c4d416Fa863F0801605629097ffF07f1d46FB8', // ds-dom-energy-signer
  '0xC2386b03441C6104F8d40E52e74306EAE830A24B', // md-dom-energy-signer
];
export const DEFAULT_THRESHOLD = 2;

export const ENVS = {
  sandbox: { chain: gnosisChiado, rpc: 'https://rpc.chiadochain.net', explorer: 'https://gnosis-chiado.blockscout.com', safeVersion: '1.3.0' },
  prod: { chain: gnosis, rpc: 'https://rpc.gnosischain.com', explorer: 'https://gnosisscan.io', safeVersion: '1.5.0' },
};

const factoryAbi = [{
  type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable',
  inputs: [{ name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }],
  outputs: [{ name: 'proxy', type: 'address' }],
}];
const setupAbi = [{
  type: 'function', name: 'setup', stateMutability: 'nonpayable',
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
  ],
  outputs: [],
}];
const safeReadAbi = [
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

export function envFile(env) {
  return join(HERE, `.env.${env}`);
}

export function loadEnv(env) {
  const out = {};
  const f = envFile(env);
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/// Upiše ili zamijeni jedan ključ u .env.<env> (chmod 600). Vrijednost se ne ispisuje.
export function setEnvVar(env, key, value) {
  const f = envFile(env);
  const lines = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${key}=`)) : [];
  lines.push(`${key}=${value}`);
  writeFileSync(f, lines.join('\n') + '\n');
  chmodSync(f, 0o600);
}

export function clients(env, privateKey) {
  const cfg = ENVS[env];
  if (!cfg) throw new Error(`nepoznato okruženje: ${env} (sandbox|prod)`);
  const pub = createPublicClient({ chain: cfg.chain, transport: http(cfg.rpc) });
  const account = privateKey ? privateKeyToAccount(privateKey) : undefined;
  const wallet = account ? createWalletClient({ chain: cfg.chain, transport: http(cfg.rpc), account }) : undefined;
  return { cfg, pub, wallet, account };
}

/// Salt iz čitljive oznake, npr. "italk-sandbox:main" ili "project:<slug>".
export function saltFromLabel(label) {
  return hexToBigInt(keccak256(toBytes(label)));
}

export function safeInitializer(owners, threshold, fallbackHandler) {
  return encodeFunctionData({
    abi: setupAbi, functionName: 'setup',
    args: [owners.map((o) => o.toLowerCase()), BigInt(threshold), zeroAddress, '0x', fallbackHandler, zeroAddress, 0n, zeroAddress],
  });
}

/// Predvidi adresu (simulacijom tvornice) i, ako treba, deployaj Safe.
/// Vraća { address, deployed, txHash }. Idempotentno: postojeći Safe se samo provjeri.
export async function ensureSafe({ cfg, pub, wallet, account }, { owners, threshold, saltLabel, dryRun }) {
  const sc = SAFE_CONTRACTS[cfg.safeVersion];
  const initializer = safeInitializer(owners, threshold, sc.fallbackHandler);
  const saltNonce = saltFromLabel(saltLabel);
  const args = [sc.singletonL2, initializer, saltNonce];

  for (const [name, a] of [['SafeProxyFactory', sc.factory], ['SafeL2 singleton', sc.singletonL2], ['fallback handler', sc.fallbackHandler]]) {
    const code = await pub.getCode({ address: a });
    if (!code || code === '0x') throw new Error(`${name} ${a} nema koda na ovom chainu`);
  }

  const from = account?.address ?? zeroAddress;
  let address;
  try {
    ({ result: address } = await pub.simulateContract({ address: sc.factory, abi: factoryAbi, functionName: 'createProxyWithNonce', args, account: from }));
  } catch (e) {
    // Simulacija pada ako proxy s tim saltom već postoji ("Create2 call failed").
    address = null;
  }

  if (address) {
    const code = await pub.getCode({ address });
    if (code && code !== '0x') return { address, deployed: true, txHash: null, existed: true };
  }
  if (!address) throw new Error('simulacija deploya nije uspjela; Safe s ovim saltom možda već postoji pod drugim vlasnicima');
  if (dryRun) return { address, deployed: false, txHash: null };
  if (!wallet) throw new Error('za deploy treba DEPLOYER_PRIVATE_KEY');

  const txHash = await wallet.writeContract({ address: sc.factory, abi: factoryAbi, functionName: 'createProxyWithNonce', args });
  const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') throw new Error(`deploy tx nije uspio: ${txHash}`);
  const code = await pub.getCode({ address });
  if (!code || code === '0x') throw new Error(`nakon deploya nema koda na ${address}`);
  return { address, deployed: true, txHash };
}

/// Provjera da Safe na lancu ima točno očekivane vlasnike i prag.
export async function verifySafe(pub, address, owners, threshold) {
  const [onOwners, onThreshold] = await Promise.all([
    pub.readContract({ address, abi: safeReadAbi, functionName: 'getOwners' }),
    pub.readContract({ address, abi: safeReadAbi, functionName: 'getThreshold' }),
  ]);
  const want = owners.map((o) => o.toLowerCase()).sort();
  const got = onOwners.map((o) => o.toLowerCase()).sort();
  const ok = JSON.stringify(want) === JSON.stringify(got) && Number(onThreshold) === threshold;
  return { ok, owners: onOwners, threshold: Number(onThreshold) };
}
