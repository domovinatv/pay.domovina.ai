/**
 * ADR 0011/0012 — bootstrap deploy for the "passkey name = Safe address" flow.
 *
 * Deploys a Safe whose initializer owner is a client-minted ephemeral EOA (so the
 * address is known BEFORE the passkey exists), then atomically attaches the passkey
 * WebAuthn signer in the SAME tx:
 *   - mode 'swap' → swapOwner(EOA → signer): owners=[signer] (max security)
 *   - mode 'add'  → addOwnerWithThreshold(signer, 1): owners=[signer, EOA] (1-of-2)
 *
 * The attach step runs via execTransaction signed off-chain by the EOA (a plain
 * EIP-712 Safe owner signature). The relayer pays gas as an external sender and is
 * never a Safe owner. Mirrors functions/api/relay.ts helpers verbatim so the
 * CREATE2 guard and the deployed initializer can never drift.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  getCreate2Address,
  http,
  isAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';

const FREE_DAILY_LIMIT = 5;

// Safe v1.4.1 canonical deployments on Gnosis (chain 100). Identical to relay.ts.
const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const;
const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as const; // SafeL2
const COMPATIBILITY_FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as const;
const MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as const;
const SAFE_PROXY_INIT_CODE_HASH =
  '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee' as const;

const SAFE_WEBAUTHN_SIGNER_FACTORY = '0x1d31F259eE307358a26dFb23EB365939E8641195' as const;
const DAIMO_P256_VERIFIER = '0xc2b78104907F722DABAc4C69f826a522B2754De4' as const;
const P256_PRECOMPILE = '0x0000000000000000000000000000000000000100' as const;

const SAFE_EXEC_TX_ABI = [
  {
    inputs: [
      { type: 'address', name: 'to' },
      { type: 'uint256', name: 'value' },
      { type: 'bytes', name: 'data' },
      { type: 'uint8', name: 'operation' },
      { type: 'uint256', name: 'safeTxGas' },
      { type: 'uint256', name: 'baseGas' },
      { type: 'uint256', name: 'gasPrice' },
      { type: 'address', name: 'gasToken' },
      { type: 'address', name: 'refundReceiver' },
      { type: 'bytes', name: 'signatures' },
    ],
    name: 'execTransaction',
    outputs: [{ type: 'bool' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

const SAFE_SETUP_ABI = [
  {
    inputs: [
      { type: 'address[]', name: '_owners' },
      { type: 'uint256', name: '_threshold' },
      { type: 'address', name: 'to' },
      { type: 'bytes', name: 'data' },
      { type: 'address', name: 'fallbackHandler' },
      { type: 'address', name: 'paymentToken' },
      { type: 'uint256', name: 'payment' },
      { type: 'address', name: 'paymentReceiver' },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const PROXY_FACTORY_ABI = [
  {
    inputs: [
      { type: 'address', name: '_singleton' },
      { type: 'bytes', name: 'initializer' },
      { type: 'uint256', name: 'saltNonce' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

const SIGNER_FACTORY_ABI = [
  {
    inputs: [
      { type: 'uint256', name: 'x' },
      { type: 'uint256', name: 'y' },
      { type: 'uint176', name: 'verifiers' },
    ],
    name: 'createSigner',
    outputs: [{ type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [
      { type: 'uint256', name: 'x' },
      { type: 'uint256', name: 'y' },
      { type: 'uint176', name: 'verifiers' },
    ],
    name: 'getSigner',
    outputs: [{ type: 'address', name: 'signer' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const OWNER_MGMT_ABI = [
  {
    inputs: [
      { type: 'address', name: 'prevOwner' },
      { type: 'address', name: 'oldOwner' },
      { type: 'address', name: 'newOwner' },
    ],
    name: 'swapOwner',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
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

const MULTISEND_ABI = [
  {
    inputs: [{ type: 'bytes', name: 'transactions' }],
    name: 'multiSend',
    outputs: [],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

// Safe owners linked-list sentinel; prevOwner pointer when the Safe has one owner.
const SENTINEL_OWNERS = '0x0000000000000000000000000000000000000001' as const;

type Env = {
  RELAY_KV: KVNamespace;
  RELAYER_PRIVATE_KEY: string;
  GNOSIS_RPC_URL?: string;
};

type Body = {
  safeAddress: string;
  ownerEoa: string;
  pubKeyX: string;
  pubKeyY: string;
  eoaSignature: string;
  mode: 'swap' | 'add';
};

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  for (const k of ['safeAddress', 'ownerEoa', 'pubKeyX', 'pubKeyY', 'eoaSignature']) {
    if (typeof (body as Record<string, unknown>)[k] !== 'string') {
      return json({ ok: false, error: `Missing field: ${k}` }, 400);
    }
  }
  if (body.mode !== 'swap' && body.mode !== 'add') {
    return json({ ok: false, error: `Invalid mode: ${body.mode}` }, 400);
  }
  if (!isAddress(body.safeAddress) || !isAddress(body.ownerEoa)) {
    return json({ ok: false, error: 'Invalid address' }, 400);
  }
  if (body.pubKeyX === '0' || body.pubKeyY === '0') {
    return json({ ok: false, error: 'Passkey pubkey missing (stub 0)' }, 400);
  }
  let pubKeyX: bigint;
  let pubKeyY: bigint;
  try {
    pubKeyX = BigInt(body.pubKeyX);
    pubKeyY = BigInt(body.pubKeyY);
  } catch {
    return json({ ok: false, error: 'Malformed pubkey' }, 400);
  }

  const safeAddress = body.safeAddress as Address;
  const ownerEoa = body.ownerEoa as Address;

  // CREATE2 consistency guard. The deployed Safe address is fully determined by the
  // initializer (owner = ownerEoa) and saltNonce 0. Reject a safeAddress that does
  // not match — otherwise we'd deploy a Safe at X while the swap/add targets Y, and
  // sponsor gas for a Safe the client cannot use.
  const predictedSafe = predictSafeProxyAddress(ownerEoa, 0n);
  if (predictedSafe.toLowerCase() !== safeAddress.toLowerCase()) {
    return json(
      {
        ok: false,
        error:
          `safeAddress ${safeAddress} does not match the Safe derived from ownerEoa ` +
          `(${predictedSafe}). Refusing to deploy.`,
      },
      400,
    );
  }

  try {
    const rawKey = (env.RELAYER_PRIVATE_KEY ?? '').trim();
    if (!rawKey) return json({ ok: false, error: 'RELAYER_PRIVATE_KEY not configured' }, 500);
    const normalizedKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedKey)) {
      return json({ ok: false, error: 'RELAYER_PRIVATE_KEY malformed' }, 500);
    }
    const account = privateKeyToAccount(normalizedKey);
    const rpcUrl = env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain: gnosis, transport });
    const wallet = createWalletClient({ account, chain: gnosis, transport });

    const verifiers = encodeVerifiers();
    const signerAddress = (await publicClient.readContract({
      address: SAFE_WEBAUTHN_SIGNER_FACTORY,
      abi: SIGNER_FACTORY_ABI,
      functionName: 'getSigner',
      args: [pubKeyX, pubKeyY, verifiers],
    })) as Address;

    // Idempotent retry: if the Safe is already deployed a prior bootstrap succeeded.
    const safeCodePre = await publicClient.getCode({ address: safeAddress });
    if (safeCodePre && safeCodePre !== '0x') {
      return json({ ok: true, alreadyDeployed: true });
    }

    // Rate limit: per (passkey signer, UTC day). A fresh wallet uses a fresh signer,
    // so this caps how many sponsored bootstraps one identity can trigger per day.
    const today = new Date().toISOString().slice(0, 10);
    const rateKey = `bootstrap:${signerAddress.toLowerCase()}:${today}`;
    const used = Number((await env.RELAY_KV.get(rateKey)) ?? 0);
    if (used >= FREE_DAILY_LIMIT) {
      return json({ ok: false, error: 'Daily limit reached', rateLimited: true }, 429);
    }

    // Owner-management call, executed by the Safe on itself via execTransaction. Must
    // be byte-identical to the client's buildAttachCalldata so the EOA sig verifies.
    const attachData =
      body.mode === 'swap'
        ? encodeFunctionData({
            abi: OWNER_MGMT_ABI,
            functionName: 'swapOwner',
            args: [SENTINEL_OWNERS, ownerEoa, signerAddress],
          })
        : encodeFunctionData({
            abi: OWNER_MGMT_ABI,
            functionName: 'addOwnerWithThreshold',
            args: [signerAddress, 1n],
          });

    const execCalldata = encodeFunctionData({
      abi: SAFE_EXEC_TX_ABI,
      functionName: 'execTransaction',
      args: [
        safeAddress,
        0n,
        attachData,
        0,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        body.eoaSignature as Hex,
      ],
    });

    const ops: PackedCall[] = [];
    const signerCodePre = await publicClient.getCode({ address: signerAddress });
    if (!signerCodePre || signerCodePre === '0x') {
      ops.push({
        to: SAFE_WEBAUTHN_SIGNER_FACTORY,
        value: 0n,
        data: encodeFunctionData({
          abi: SIGNER_FACTORY_ABI,
          functionName: 'createSigner',
          args: [pubKeyX, pubKeyY, verifiers],
        }),
      });
    }
    ops.push({
      to: SAFE_PROXY_FACTORY,
      value: 0n,
      data: encodeFunctionData({
        abi: PROXY_FACTORY_ABI,
        functionName: 'createProxyWithNonce',
        args: [SAFE_SINGLETON, buildSafeInitializer(ownerEoa), 0n],
      }),
    });
    ops.push({ to: safeAddress, value: 0n, data: execCalldata });

    const multiSendCalldata = encodeFunctionData({
      abi: MULTISEND_ABI,
      functionName: 'multiSend',
      args: [packMultiSend(ops)],
    });
    const txHash = await wallet.sendTransaction({
      to: MULTISEND_CALL_ONLY,
      data: multiSendCalldata,
    });

    // Wait for confirmation: the client only persists + reveals the wallet on a
    // confirmed deploy. A reverted bundle means the passkey is orphaned (no funds at
    // risk — the address was never revealed); the client tells the user to retry.
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 25_000 });
    if (receipt.status !== 'success') {
      return json({ ok: false, error: 'Bootstrap deploy reverted on-chain', txHash }, 502);
    }

    await env.RELAY_KV.put(rateKey, String(used + 1), { expirationTtl: 60 * 60 * 36 });
    return json({ ok: true, txHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: `Bootstrap deploy failed: ${msg}` }, 500);
  }
};

type PackedCall = { to: Address; value: bigint; data: Hex };

/** Pack MultiSendCallOnly transactions: 1 byte op || 20 bytes to || 32 bytes value || 32 bytes dataLen || data. */
function packMultiSend(ops: PackedCall[]): Hex {
  const parts: Hex[] = [];
  for (const op of ops) {
    const dataLen = (op.data.length - 2) / 2;
    parts.push(
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, op.to, op.value, BigInt(dataLen), op.data],
      ),
    );
  }
  return ('0x' + parts.map((p) => p.slice(2)).join('')) as Hex;
}

function encodeVerifiers(): bigint {
  return (BigInt(P256_PRECOMPILE) << 160n) | BigInt(DAIMO_P256_VERIFIER);
}

/** Safe v1.4.1 `setup` calldata for a 1/1 Safe owned solely by ownerEoa. Used for
 * BOTH the deploy and the CREATE2 guard so the predicted address is meaningful. */
function buildSafeInitializer(ownerEoa: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [[ownerEoa], 1n, zeroAddress, '0x', COMPATIBILITY_FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
  });
}

/** Deterministic counterfactual Safe address for (ownerEoa, saltNonce) under the
 * v1.4.1 SafeProxyFactory. Mirrors createProxyWithNonce's CREATE2. */
function predictSafeProxyAddress(ownerEoa: Address, saltNonce: bigint): Address {
  const initializer = buildSafeInitializer(ownerEoa);
  const salt = keccak256(encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]));
  return getCreate2Address({ from: SAFE_PROXY_FACTORY, salt, bytecodeHash: SAFE_PROXY_INIT_CODE_HASH });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
