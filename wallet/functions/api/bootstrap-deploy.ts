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
 * never a Safe owner. All Safe/CREATE2 primitives come from ../_lib/safe so the
 * deployed initializer can never drift from relay.ts's.
 */
import { encodeFunctionData, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import {
  MULTISEND_CALL_ONLY,
  OWNER_MGMT_ABI,
  PROXY_FACTORY_ABI,
  SAFE_EXEC_TX_ABI,
  SAFE_PROXY_FACTORY,
  SAFE_SINGLETON,
  SAFE_WEBAUTHN_SIGNER_FACTORY,
  SENTINEL_OWNERS,
  SIGNER_FACTORY_ABI,
  MULTISEND_ABI,
  buildSafeInitializer,
  encodeVerifiers,
  packMultiSend,
  predictSafeProxyAddress,
  type PackedCall,
} from '../_lib/safe';
import { isDeployed, loadRelayer } from '../_lib/relayer';
import { FREE_DAILY_LIMIT, bumpCount, readCount, signerDailyKey } from '../_lib/limits';
import { json } from '../_lib/http';

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
  const predictedSafe = predictSafeProxyAddress([ownerEoa], 0n);
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
    const relayer = loadRelayer(env.RELAYER_PRIVATE_KEY, env.GNOSIS_RPC_URL);
    if (!relayer.ok) return json({ ok: false, error: relayer.error }, 500);
    const { publicClient, wallet } = relayer.clients;

    const verifiers = encodeVerifiers();
    const signerAddress = (await publicClient.readContract({
      address: SAFE_WEBAUTHN_SIGNER_FACTORY,
      abi: SIGNER_FACTORY_ABI,
      functionName: 'getSigner',
      args: [pubKeyX, pubKeyY, verifiers],
    })) as Address;

    // Idempotent retry: if the Safe is already deployed a prior bootstrap succeeded.
    if (await isDeployed(publicClient, safeAddress)) {
      return json({ ok: true, alreadyDeployed: true });
    }

    // Rate limit: per (passkey signer, UTC day). A fresh wallet uses a fresh signer,
    // so this caps how many sponsored bootstraps one identity can trigger per day.
    const rateKey = signerDailyKey('bootstrap', signerAddress);
    const used = await readCount(env.RELAY_KV, rateKey);
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
    if (!(await isDeployed(publicClient, signerAddress))) {
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
        args: [SAFE_SINGLETON, buildSafeInitializer([ownerEoa]), 0n],
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

    await bumpCount(env.RELAY_KV, rateKey, used);
    return json({ ok: true, txHash });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: `Bootstrap deploy failed: ${msg}` }, 500);
  }
};
