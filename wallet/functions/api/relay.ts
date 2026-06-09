import { encodeFunctionData, isAddress, zeroAddress, type Address, type Hex } from 'viem';
import {
  MULTISEND_CALL_ONLY,
  PROXY_FACTORY_ABI,
  SAFE_EXEC_TX_ABI,
  SAFE_PROXY_FACTORY,
  SAFE_SINGLETON,
  SAFE_WEBAUTHN_SIGNER_FACTORY,
  SIGNER_FACTORY_ABI,
  MULTISEND_ABI,
  buildSafeInitializer,
  encodeVerifiers,
  packMultiSend,
  predictSafeProxyAddress,
  type PackedCall,
} from '../_lib/safe';
import { isDeployed, loadRelayer } from '../_lib/relayer';
import {
  FREE_DAILY_LIMIT,
  bumpCount,
  readCount,
  signerDailyKey,
} from '../_lib/limits';
import { json } from '../_lib/http';

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
   */
  saltNonce?: string;
  /**
   * Optional reusable recovery owner (ADR 0013 derived account). When present,
   * the cold-path Safe is deployed 1-of-2 with owners [signerAddress,
   * recoveryOwner] (threshold 1) instead of 1/1 [signerAddress]. The address
   * derivation + CREATE2 guard use the same 2-owner initializer, so a mismatch
   * is rejected rather than stranding funds. Absent → single-owner Safe.
   */
  recoveryOwner?: string;
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

  // Optional ADR-0013 recovery owner. Validate up-front so a malformed value
  // fails loudly here rather than producing a wrong 2-owner initializer (and a
  // different counterfactual address) deep in the cold path.
  let recoveryOwner: Address | null = null;
  if (body.recoveryOwner != null) {
    if (!isAddress(body.recoveryOwner)) {
      return json({ ok: false, error: 'Invalid recoveryOwner' }, 400);
    }
    const ro = body.recoveryOwner.toLowerCase();
    if (ro === body.signerAddress.toLowerCase()) {
      return json({ ok: false, error: 'recoveryOwner === signerAddress' }, 400);
    }
    if (ro === body.safeAddress.toLowerCase()) {
      return json({ ok: false, error: 'recoveryOwner === safeAddress' }, 400);
    }
    recoveryOwner = body.recoveryOwner as Address;
  }

  // NOTE: the CREATE2 consistency guard (predictSafe(signer) === safeAddress) is
  // enforced LATER, only on the cold path (see below), not unconditionally here.
  // It must NOT run for an already-deployed Safe: ADR-0011/0012 bootstrap wallets
  // have a Safe whose initializer owner is an ephemeral EOA, so safeAddress derives
  // from the EOA, not from the passkey signer. predictSafe(signer) !== safeAddress
  // for those — correct and expected — and they only ever take the hot path.

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
  const rateKey = signerDailyKey('relay', body.signerAddress);
  const used = await readCount(env.RELAY_KV, rateKey);
  if (used >= FREE_DAILY_LIMIT) {
    return json({ ok: false, error: 'Daily limit reached', rateLimited: true }, 429);
  }

  try {
    const relayer = loadRelayer(env.RELAYER_PRIVATE_KEY, env.GNOSIS_RPC_URL);
    if (!relayer.ok) return json({ ok: false, error: relayer.error }, 500);
    const { publicClient, wallet } = relayer.clients;

    const safeAddress = body.safeAddress as Address;
    const signerAddress = body.signerAddress as Address;
    // The owner set the cold path deploys + the CREATE2 guard checks against.
    // 2 owners (1-of-2) for an ADR-0013 derived account, else the legacy single
    // owner. Order is significant — must match the client's predict (accounts.ts).
    const coldOwners: Address[] = recoveryOwner ? [signerAddress, recoveryOwner] : [signerAddress];

    // Pre-flight deploy check on the Safe address.
    //
    // The hot path (execTransaction on the Safe) cannot be trusted to FAIL
    // when the Safe is undeployed: a call to an address that holds no code
    // returns status=1 with empty logs (~21k gas), NOT a revert. The relayer
    // would then broadcast a no-op tx, return ok+txHash, and the user's EURe
    // would stay parked at the counterfactual address (see memory:
    // evm-call-to-empty-address). We accept the rare false-positive cold path
    // as the price of never silently dropping a user's send.
    const safeDeployedPre = await isDeployed(publicClient, safeAddress);

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
        const initializer = buildSafeInitializer(coldOwners);
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
      // CREATE2 consistency guard — cold path ONLY. The cold path deploys a Safe
      // whose address is fully determined by (coldOwners, saltNonce). If the
      // client's safeAddress doesn't match, we'd deploy at X while execTransaction
      // targets Y (no code) — EVM returns status=1 with no revert and the EURe is
      // stranded forever (see memory: evm-call-to-empty-address). ADR-0011/0012
      // bootstrap wallets never reach here (deployed at creation).
      const predictedSafe = predictSafeProxyAddress(coldOwners, saltNonce);
      if (predictedSafe.toLowerCase() !== safeAddress.toLowerCase()) {
        return json(
          {
            ok: false,
            error:
              `safeAddress ${safeAddress} does not match the Safe derived from ` +
              `owners [${coldOwners.join(', ')}] + saltNonce (${predictedSafe}). Refusing ` +
              `to deploy — this would strand funds at the counterfactual address.`,
          },
          400,
        );
      }
      // Safe is not deployed (per fresh getCode). Skip hot path entirely — calling
      // execTransaction on a code-less address silently succeeds. Cold path
      // atomically deploys the Safe (and the WebAuthn signer if also missing) then
      // runs execTransaction, so the EURe transfer either lands in the same tx or
      // the whole multiSend reverts loudly.
      const signerDeployedPre = await isDeployed(publicClient, signerAddress);
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
        const [safeNow, signerNow] = await Promise.all([
          isDeployed(publicClient, safeAddress),
          isDeployed(publicClient, signerAddress),
        ]);
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
      // Should be unreachable — either hot or cold assigns it before we get here.
      return json({ ok: false, error: 'No transaction was submitted' }, 500);
    }
    await bumpCount(env.RELAY_KV, rateKey, used);
    return json({ ok: true, txHash, deployed });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ ok: false, error: `Submit failed: ${msg}` }, 500);
  }
};
