import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodePacked,
  http,
  isAddress,
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
};

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

    // Check deployment state of Safe + signer proxy. We need both to exist
    // before execTransaction can verify the WebAuthn signature.
    const [safeCode, signerCode] = await Promise.all([
      publicClient.getCode({ address: safeAddress }),
      publicClient.getCode({ address: signerAddress }),
    ]);
    const safeDeployed = !!safeCode && safeCode !== '0x';
    const signerDeployed = !!signerCode && signerCode !== '0x';

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

    let txHash: Hex;
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
        const initializer = encodeFunctionData({
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
        ops.push({
          to: SAFE_PROXY_FACTORY,
          value: 0n,
          data: encodeFunctionData({
            abi: PROXY_FACTORY_ABI,
            functionName: 'createProxyWithNonce',
            args: [SAFE_SINGLETON, initializer, 0n],
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

    if (safeDeployed && signerDeployed) {
      // Hot path: just submit the execTransaction directly.
      txHash = await sendHotPath();
    } else {
      // Cold path: batch what is missing (createSigner / createProxyWithNonce /
      // execTransaction) through MultiSendCallOnly. Relayer pays gas for the
      // whole batch.
      try {
        txHash = await sendColdPath(signerDeployed, safeDeployed);
        deployed = true;
      } catch (coldErr) {
        // Cold-path revert often means the RPC returned stale empty code for
        // an address that is actually deployed (eventual-consistency across
        // gateway nodes). CREATE2 inside multiSend then collides and reverts.
        // Re-poll code; if both ARE deployed now, retry as a clean hot path.
        const [safeCode2, signerCode2] = await Promise.all([
          publicClient.getCode({ address: safeAddress }),
          publicClient.getCode({ address: signerAddress }),
        ]);
        const safeNow = !!safeCode2 && safeCode2 !== '0x';
        const signerNow = !!signerCode2 && signerCode2 !== '0x';
        if (safeNow && signerNow) {
          console.warn(
            '[relay] cold-path reverted but Safe + signer ARE deployed; retrying hot path',
          );
          txHash = await sendHotPath();
        } else if (safeNow !== safeDeployed || signerNow !== signerDeployed) {
          // Partial deploy state changed between the two reads — re-run cold
          // path skipping whatever is now confirmed deployed.
          console.warn(
            `[relay] deployment state changed mid-flight (safe ${safeDeployed} -> ${safeNow}, signer ${signerDeployed} -> ${signerNow}); retrying cold path with refreshed skip flags`,
          );
          txHash = await sendColdPath(signerNow, safeNow);
          deployed = true;
        } else {
          throw coldErr;
        }
      }
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

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
