// Zajednički dijelovi za funding-init: okruženja, Safe deploy, .env.
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Safe ugovori, vlasnici, CREATE2 i Monerium link poruka žive u
// backend/safe-tx/lib/project-safe.mjs: istu biblioteku koristi setup dApp i
// worker (POST /admin/api/tenants/:id/projects, ADR 0027).
import {
  SAFE_CONTRACTS, DEFAULT_OWNERS, DEFAULT_THRESHOLD, MONERIUM_LINK_MESSAGE,
  saltFromLabel, linkSignatureSetupCall, isLinkSigned, safeInitializer, verifySafe,
  projectSafePlan, readProxyCreationCode, assertSafeContracts, hasCode, FACTORY_ABI,
} from '../../backend/safe-tx/lib/project-safe.mjs';

export { SAFE_CONTRACTS, DEFAULT_OWNERS, DEFAULT_THRESHOLD, MONERIUM_LINK_MESSAGE, saltFromLabel, linkSignatureSetupCall, isLinkSigned, safeInitializer, verifySafe };

export const ENVS = {
  sandbox: { chain: gnosisChiado, rpc: 'https://rpc.chiadochain.net', explorer: 'https://gnosis-chiado.blockscout.com', safeVersion: '1.3.0' },
  prod: { chain: gnosis, rpc: 'https://rpc.gnosischain.com', explorer: 'https://gnosisscan.io', safeVersion: '1.5.0' },
};

/// `env` is an environment name (`.env.<env>` next to these scripts) or, when
/// it contains a slash, a path to the env file itself.
export function envFile(env) {
  return env.includes('/') ? env : join(HERE, `.env.${env}`);
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

/// Predvidi adresu (CREATE2 kao SafeProxyFactory) i, ako treba, deployaj Safe.
/// Vraća { address, deployed, txHash }. Idempotentno: postojeći Safe se samo provjeri.
export async function ensureSafe({ cfg, pub, wallet }, { owners, threshold, saltLabel, dryRun, preSignLink = false }) {
  await assertSafeContracts(pub, cfg.safeVersion);
  const plan = projectSafePlan({
    version: cfg.safeVersion, owners, threshold, saltLabel, preSignLink,
    creationCode: await readProxyCreationCode(pub, cfg.safeVersion),
  });
  const { address } = plan;
  if (await hasCode(pub, address)) return { address, deployed: true, txHash: null, existed: true };

  if (dryRun) return { address, deployed: false, txHash: null };
  if (!wallet) throw new Error('za deploy treba DEPLOYER_PRIVATE_KEY');

  const txHash = await wallet.writeContract({ address: plan.factory, abi: FACTORY_ABI, functionName: 'createProxyWithNonce', args: plan.args });
  const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (rcpt.status !== 'success') throw new Error(`deploy tx nije uspio: ${txHash}`);
  if (!(await hasCode(pub, address))) throw new Error(`nakon deploya nema koda na ${address}`);
  return { address, deployed: true, txHash };
}
