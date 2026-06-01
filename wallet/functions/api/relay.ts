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

// Safe v1.4.1 canonical deployments on Gnosis (chain 100), pulled from
// safe-global/safe-deployments. Same addresses as every other major EVM.
const SAFE_PROXY_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67' as const;
const SAFE_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762' as const; // SafeL2
const COMPATIBILITY_FALLBACK_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99' as const;
const MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' as const;

// keccak256(SafeProxyFactory.proxyCreationCode() ++ abi.encode(uint256(SAFE_SINGLETON))).
// Constant because both the proxy creation code (pure, on the v1.4.1 factory) and
// the singleton are fixed. Captured from the live Gnosis factory and verified to
// reproduce protocol-kit's predicted addresses for salt 0 AND a campaign salt.
// This is the CREATE2 init-code hash used to derive the counterfactual Safe addr.
const SAFE_PROXY_INIT_CODE_HASH =
  '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee' as const;

// Safe Passkey module v0.2.1 — see safe-modules-deployments
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

type Env = {
  RELAY_KV: KVNamespace;
  RELAYER_PRIVATE_KEY: string;
  GNOSIS_RPC_URL?: string;
};

type Body = {
  safeAddress: string;
  signerAddress: string;
  pubKeyX: string;
  pubKeyY: string;
  to: string;
  value: string;
  data: string;
  signature: string;
  /**
   * Optional CREATE2 saltNonce for the Safe proxy deploy (cold path).
   * Decimal uint256 string. Defaults to "0" — the personal-wallet derivation
   * (wallet/src/lib/safe.ts uses saltNonce '0'). pinka.finance per-campaign
   * Safes pass keccak("pinka:campaign:<id>") as a decimal string so the relay
   * deploys the Safe at the SAME counterfactual address the client funded.
   * Hardcoding 0 here would deploy a different address and silently strand the
   * EURe (see memory: evm-call-to-empty-address).
   */
  saltNonce?: string;
};

const UINT256_MAX = (1n << 256n) - 1n;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }
  for (const k of ['safeAddress', 'signerAddress', 'to', 'data', 'signature']) {
    if (typeof (body as Record<string, unknown>)[k] !== 'string') {
      return json({ ok: false, error: `Missing field: ${k}` }, 400);
    }
  }
  if (!isAddress(body.safeAddress) || !isAddress(body.signerAddress) || !isAddress(body.to)) {
    return json({ ok: false, error: 'Invalid address' }, 400);
  }
  if (body.safeAddress.toLowerCase() === body.signerAddress.toLowerCase()) {
    return json(
      { ok: false, error: 'safeAddress === signerAddress (identity bug — re-open passkey)' },
      400,
    );
  }
  // Parse the optional saltNonce up-front so a malformed value fails loudly
  // with a 400 rather than throwing deep in the cold-path encode. Absent →
  // "0" (personal-wallet default).
  let saltNonce: bigint;
  try {
    saltNonce = body.saltNonce == null ? 0n : BigInt(body.saltNonce);
  } catch {
    return json({ ok: false, error: `Invalid saltNonce: ${body.saltNonce}` }, 400);
  }
  if (saltNonce < 0n || saltNonce > UINT256_MAX) {
    return json({ ok: false, error: 'saltNonce out of uint256 range' }, 400);
  }

  // CREATE2 consistency guard. The relay trusts the client-supplied safeAddress
  // for the (no-op-safe) hot path, but the cold path DEPLOYS a Safe whose address
  // is fully determined by (signerAddress, saltNonce). If the client sends a
  // safeAddress that doesn't match that derivation, the cold path would deploy a
  // Safe at address X while execTransaction targets safeAddress Y (no code) —
  // EVM returns status=1 with no revert and the EURe is stranded forever (see
  // memory: evm-call-to-empty-address). Reject the inconsistent triple up-front.
  const predictedSafe = predictSafeProxyAddress(body.signerAddress as Address, saltNonce);
  if (predictedSafe.toLowerCase() !== body.safeAddress.toLowerCase()) {
    return json(
      {
        ok: false,
        error:
          `safeAddress ${body.safeAddress} does not match the Safe derived from ` +
          `signerAddress + saltNonce (${predictedSafe}). Refusing to deploy — this ` +
          `would strand funds at the counterfactual address.`,
      },
      400,
    );
  }

  // Reject stub pubkeys early — cross-device-restored passkey records store
  // ('0','0') until the next signing event refreshes them, and sending with
  // stubs would deploy a wrong signer at a CREATE2-derived address that does
  // not own the Safe.
  if (body.pubKeyX === '0' || body.pubKeyY === '0') {
    return json(
      {
        ok: false,
        error:
          'Passkey pubkey nije poznat na ovom uređaju (stub 0). Otvori wallet na uređaju gdje je passkey originalno kreiran, ili kreiraj novi wallet.',
      },
      400,
    );
  }

  // Rate limit: 5 free per (signerAddress, UTC day).
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `relay:${body.signerAddress.toLowerCase()}:${today}`;
  const used = Number((await env.RELAY_KV.get(rateKey)) ?? 0);
  if (used >= FREE_DAILY_LIMIT) {
    return json({ ok: false, error: 'Daily limit reached', rateLimited: true }, 429);
  }

  try {
    const rawKey = (env.RELAYER_PRIVATE_KEY ?? '').trim();
    if (!rawKey) {
      return json({ ok: false, error: 'RELAYER_PRIVATE_KEY not configured' }, 500);
    }
    // Normalize: wrangler secrets sometimes arrive without 0x prefix or with
    // stray whitespace; viem privateKeyToAccount is strict about both.
    const normalizedKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedKey)) {
      return json(
        { ok: false, error: `RELAYER_PRIVATE_KEY malformed (expected 0x + 64 hex chars, got ${normalizedKey.length} chars)` },
        500,
      );
    }
    const account = privateKeyToAccount(normalizedKey);
    const rpcUrl = env.GNOSIS_RPC_URL ?? 'https://rpc.gnosischain.com';
    const transport = http(rpcUrl);
    const publicClient = createPublicClient({ chain: gnosis, transport });
    const wallet = createWalletClient({ account, chain: gnosis, transport });

    const safeAddress = body.safeAddress as Address;
    const signerAddress = body.signerAddress as Address;

    // Pre-flight deploy check on the Safe address.
    //
    // The hot path (execTransaction on the Safe) cannot be trusted to FAIL
    // when the Safe is undeployed: a call to an address that holds no code
    // returns status=1 with empty logs (~21k gas), NOT a revert. viem's
    // gas estimation also succeeds because there's nothing to simulate.
    // The relayer would then broadcast a no-op tx, return ok+txHash, and
    // the user's EURe would stay parked at the counterfactual address.
    // Observed in https://gnosisscan.io/tx/0x6aa571f073b36f582b3e54fac7d7eac195c6ee54ae584ac4efe9aabe2382efe0.
    //
    // The previous "hot-first" rationale (avoid getCode because public
    // Gnosis RPC has eventually-consistent reads that say empty-when-full)
    // still applies — but its failure mode is a LOUD cold-path revert
    // (CREATE2 collision), not silent fund loss. We accept the rare
    // false-positive cold path as the price of never silently dropping a
    // user's send.
    const safeCodePre = await publicClient.getCode({ address: safeAddress });
    const safeDeployedPre = !!safeCodePre && safeCodePre !== '0x';

    const execCalldata = encodeFunctionData({
      abi: SAFE_EXEC_TX_ABI,
      functionName: 'execTransaction',
      args: [
        body.to as Address,
        BigInt(body.value),
        body.data as Hex,
        0,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        body.signature as Hex,
      ],
    });

    let txHash: Hex | null = null;
    let deployed = false;

    async function sendHotPath(): Promise<Hex> {
      return await wallet.sendTransaction({ to: safeAddress, data: execCalldata });
    }

    async function sendColdPath(skipSigner: boolean, skipSafe: boolean): Promise<Hex> {
      const verifiers = encodeVerifiers();
      const ops: PackedCall[] = [];
      if (!skipSigner) {
        ops.push({
          to: SAFE_WEBAUTHN_SIGNER_FACTORY,
          value: 0n,
          data: encodeFunctionData({
            abi: SIGNER_FACTORY_ABI,
            functionName: 'createSigner',
            args: [BigInt(body.pubKeyX), BigInt(body.pubKeyY), verifiers],
          }),
        });
      }
      if (!skipSafe) {
        const initializer = buildSafeInitializer(signerAddress);
        ops.push({
          to: SAFE_PROXY_FACTORY,
          value: 0n,
          data: encodeFunctionData({
            abi: PROXY_FACTORY_ABI,
            functionName: 'createProxyWithNonce',
            args: [SAFE_SINGLETON, initializer, saltNonce],
          }),
        });
      }
      ops.push({ to: safeAddress, value: 0n, data: execCalldata });

      const multiSendCalldata = encodeFunctionData({
        abi: MULTISEND_ABI,
        functionName: 'multiSend',
        args: [packMultiSend(ops)],
      });
      return await wallet.sendTransaction({
        to: MULTISEND_CALL_ONLY,
        data: multiSendCalldata,
      });
    }

    if (!safeDeployedPre) {
      // Safe is not deployed (per fresh getCode). Skip hot path entirely —
      // calling execTransaction on a code-less address silently succeeds
      // and the user's funds stay locked at the counterfactual address.
      // Cold path atomically deploys the Safe (and the WebAuthn signer if
      // also missing) then runs execTransaction, so the EURe transfer
      // either lands in the same tx or the whole multiSend reverts loudly.
      const signerCodePre = await publicClient.getCode({ address: signerAddress });
      const signerDeployedPre = !!signerCodePre && signerCodePre !== '0x';
      console.warn(
        `[relay] safe undeployed (signer=${signerDeployedPre}); going cold-path to deploy+send atomically`,
      );
      txHash = await sendColdPath(signerDeployedPre, false);
      deployed = true;
    } else {
      // Safe IS deployed (or the public RPC says so). Hot-first strategy:
      // try execTransaction directly; on revert, re-check deployment to
      // disambiguate "wrong signature/nonce" (propagate) from "RPC was
      // stale, deploy is incomplete" (cold-path with the missing pieces).
      let hotErr: unknown = null;
      try {
        txHash = await sendHotPath();
      } catch (e) {
        hotErr = e;
      }

      if (hotErr) {
        const [safeCode2, signerCode2] = await Promise.all([
          publicClient.getCode({ address: safeAddress }),
          publicClient.getCode({ address: signerAddress }),
        ]);
        const safeNow = !!safeCode2 && safeCode2 !== '0x';
        const signerNow = !!signerCode2 && signerCode2 !== '0x';
        if (safeNow && signerNow) {
          // Both deployed; hot SHOULD have worked. Propagate.
          throw hotErr;
        }
        console.warn(
          `[relay] hot failed and deployment incomplete (safe=${safeNow}, signer=${signerNow}); routing to cold path`,
        );
        txHash = await sendColdPath(signerNow, safeNow);
        deployed = true;
      }
    }

    if (!txHash) {
      // Should be unreachable — either hot or cold assigns it before we get
      // here. Defensive return in case the control flow ever changes.
      return json({ ok: false, error: 'No transaction was submitted' }, 500);
    }
    await env.RELAY_KV.put(rateKey, String(used + 1), { expirationTtl: 60 * 60 * 36 });
    return json({ ok: true, txHash, deployed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: `Submit failed: ${msg}` }, 500);
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
  // Concatenate the packed bytes (each part is already hex-prefixed).
  return ('0x' + parts.map((p) => p.slice(2)).join('')) as Hex;
}

function encodeVerifiers(): bigint {
  return (BigInt(P256_PRECOMPILE) << 160n) | BigInt(DAIMO_P256_VERIFIER);
}

/**
 * Safe v1.4.1 `setup` calldata for a 1/1 Safe owned solely by signerAddress.
 * Used both for the cold-path deploy AND the CREATE2 guard, so they can never
 * drift — the predicted address is only meaningful if the initializer here is
 * byte-identical to the one actually deployed.
 */
function buildSafeInitializer(signerAddress: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      [signerAddress],
      1n,
      zeroAddress,
      '0x',
      COMPATIBILITY_FALLBACK_HANDLER,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
}

/**
 * Deterministic counterfactual Safe address for (signerAddress, saltNonce) under
 * the v1.4.1 SafeProxyFactory. Mirrors `createProxyWithNonce`'s CREATE2:
 *   salt = keccak256(keccak256(initializer) ++ saltNonce)
 *   addr = CREATE2(factory, salt, keccak256(creationCode ++ singleton))
 * Verified against protocol-kit (the client's derivation) for salt 0 + campaign salts.
 */
function predictSafeProxyAddress(signerAddress: Address, saltNonce: bigint): Address {
  const initializer = buildSafeInitializer(signerAddress);
  const salt = keccak256(
    encodePacked(['bytes32', 'uint256'], [keccak256(initializer), saltNonce]),
  );
  return getCreate2Address({
    from: SAFE_PROXY_FACTORY,
    salt,
    bytecodeHash: SAFE_PROXY_INIT_CODE_HASH,
  });
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
