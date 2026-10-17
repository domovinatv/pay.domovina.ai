#!/usr/bin/env node
// router-scope: dodaj Safe projekta u rolu ProjectRouter glavnog Safe-a (ADR 0026)
// kao PRIJEDLOG u redu Safe-a. Vlasnici (2/3) ga potvrđuju u app.safe.global ili
// Safe mobilnoj aplikaciji („Needs confirmation").
//
//   node router-scope.mjs --env sandbox --recipient 0x<Safe projekta>
//   node router-scope.mjs --env prod --recipient 0x… --dry
//
// Prvo postavljanje (modul + scope + član) je isti batch kao safe-tx/009; s --setup
// ga delegate predloži kao jedan MultiSendCallOnly u red Safe-a (umjesto uploada u
// Transaction Builder). JSON za fork-simulaciju zapiše se uz to:
//   node router-scope.mjs --env sandbox --setup --router 0x<router EOA> --recipient 0x… [--recipient …]
//
// Prijedlog potpisuje ključ DELEGATEA (SAFE_DELEGATE_PRIVATE_KEY u .env.<env>).
// Delegate smije predložiti, ali ne i potpisati ni izvršiti, pa njegov ključ ne nosi
// rizik. Jednom ga doda vlasnik: app.safe.global → Settings → Setup → Proposers.
//
// Popis primatelja čita se s lanca (zadnji ScopeFunction na Roles modifieru), a
// novi scopeFunction nosi PUNI popis jer prepisuje cijelo stablo. Postavke iz
// .env.<env>: PROJECT_ROUTER_ROLES (Roles modifier), PROJECT_ROUTER_FROM_BLOCK
// (blok od kojeg se čitaju događaji), po želji MAIN_SAFE.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { decodeFunctionData, getAddress, isAddress } from 'viem';
import { writeFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';
import { clients, loadEnv } from './lib.mjs';
import { buildProjectRouterBatch, ROLE, toTxBuilderJson } from '../../backend/safe-tx/009-project-router-role.mjs';
import { ROLES_ABI } from '../../backend/safe-tx/lib/roles-v2.mjs';
import { SAFE_TX_ABI, ZERO_ADDRESS as ZERO, encodeMultiSendCallOnly } from '../../backend/safe-tx/lib/safe-tx.mjs';

/// funding env → 009 env + Safe Transaction Service
export const ROUTER_ENV = {
  // MultiSendCallOnly: 1.3.0 on Chiado (the only version there), 1.4.1 on Gnosis.
  sandbox: { chain: 'chiado', txService: 'https://api.safe.global/tx-service/chi', multiSend: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D' },
  prod: { chain: 'gnosis', txService: 'https://api.safe.global/tx-service/gno', multiSend: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2' },
};

export { encodeMultiSendCallOnly };

async function txs(url, init) {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

/// Queued (not executed) multisig txs of the Safe, newest nonce first.
async function queued(txService, safe) {
  const r = await txs(`${txService}/api/v1/safes/${safe}/multisig-transactions/?executed=false&limit=100&ordering=-nonce`);
  if (r.status !== 200) throw new Error(`tx service ${r.status}: ${r.text.slice(0, 200)}`);
  return r.json.results ?? [];
}

/// One Safe tx (CALL, no value) proposed to the queue, signed by the delegate.
export async function proposeSafeTx({ pub, txService, safe, to, data, operation = 0, delegateKey, origin }) {
  const delegate = privateKeyToAccount(delegateKey);
  const onchainNonce = await pub.readContract({ address: safe, abi: SAFE_TX_ABI, functionName: 'nonce' });
  const pending = await queued(txService, safe);
  const live = pending.filter((t) => BigInt(t.nonce) >= onchainNonce);
  const nonce = live.length ? BigInt(Math.max(...live.map((t) => Number(t.nonce)))) + 1n : onchainNonce;
  const safeTxHash = await pub.readContract({
    address: safe, abi: SAFE_TX_ABI, functionName: 'getTransactionHash',
    args: [to, 0n, data, operation, 0n, 0n, 0n, ZERO, ZERO, nonce],
  });
  const signature = await delegate.sign({ hash: safeTxHash });
  const body = {
    to, value: '0', data, operation,
    safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO,
    nonce: nonce.toString(), contractTransactionHash: safeTxHash,
    sender: delegate.address, signature, origin,
  };
  const r = await txs(`${txService}/api/v1/safes/${safe}/multisig-transactions/`, { method: 'POST', body: JSON.stringify(body) });
  if (r.status >= 300) throw new Error(`prijedlog odbijen (${r.status}): ${r.text.slice(0, 300)}`);
  return { safeTxHash, nonce, delegate: delegate.address };
}

/// Add `recipient` to ProjectRouter. Returns what happened, never throws for
/// "already done" states.
export async function addProjectToRouter({ env, recipient, vars, dry = false, log = console.log }) {
  const re = ROUTER_ENV[env];
  if (!re) throw new Error(`nepoznato okruženje ${env}`);
  if (!vars.PROJECT_ROUTER_ROLES) return { status: 'not_configured' };
  const { pub } = clients(env);
  const b = await buildProjectRouterBatch({
    env: re.chain,
    safe: vars.MAIN_SAFE || undefined,
    roles: vars.PROJECT_ROUTER_ROLES,
    fromBlock: vars.PROJECT_ROUTER_FROM_BLOCK ? BigInt(vars.PROJECT_ROUTER_FROM_BLOCK) : undefined,
    recipients: [recipient],
    legacyCleanup: false,
  }, pub);
  if (b.txs.length === 0) return { status: 'already_in_role', recipients: b.recipients };
  const labels = b.txs.map((t) => t._label);
  if (b.txs.length !== 1 || labels[0] !== 'Roles.scopeFunction') {
    // First setup (module, scopeTarget, member) is a reviewed 2/3 batch, not a
    // delegate proposal: generate it with safe-tx/009 and the Transaction Builder.
    return { status: 'needs_batch_009', steps: labels };
  }
  const tx = b.txs[0];
  // Same scopeFunction already waiting for owners → do not queue a duplicate.
  const dup = (await queued(re.txService, b.safe)).find(
    (t) => t.to && getAddress(t.to) === getAddress(tx.to) && (t.data ?? '').toLowerCase() === tx.data.toLowerCase(),
  );
  if (dup) return { status: 'already_proposed', safeTxHash: dup.safeTxHash, nonce: dup.nonce, recipients: b.recipients };
  // Sanity: the calldata really is scopeFunction(ProjectRouter, EURe, transfer, …).
  const d = decodeFunctionData({ abi: ROLES_ABI, data: tx.data });
  if (d.functionName !== 'scopeFunction' || d.args[0].toLowerCase() !== b.roleKey.toLowerCase()) {
    throw new Error('generated calldata is not scopeFunction(ProjectRouter, …)');
  }
  log(`  na lancu: ${b.before.join(', ') || '(prazno)'}`);
  log(`  novi skup: ${b.recipients.join(', ')}`);
  if (dry) return { status: 'dry', recipients: b.recipients };
  if (!vars.SAFE_DELEGATE_PRIVATE_KEY) return { status: 'no_delegate_key', recipients: b.recipients };
  const p = await proposeSafeTx({
    pub, txService: re.txService, safe: b.safe, to: getAddress(tx.to), data: tx.data,
    delegateKey: vars.SAFE_DELEGATE_PRIVATE_KEY, origin: `funding-init: ${ROLE} + ${recipient}`,
  });
  return { status: 'proposed', ...p, safe: b.safe, recipients: b.recipients };
}

/// First setup: the whole 009 batch as ONE queued Safe tx (DelegateCall to
/// MultiSendCallOnly — the only delegatecall target Safe apps accept), plus the
/// Transaction Builder JSON for 009-simulate-fork.mjs.
export async function proposeRouterSetup({ env, recipients, router, vars, dry = false, jsonOut }) {
  const re = ROUTER_ENV[env];
  if (!vars.PROJECT_ROUTER_ROLES) throw new Error('PROJECT_ROUTER_ROLES nije postavljen u .env');
  const { pub } = clients(env);
  const b = await buildProjectRouterBatch({
    env: re.chain,
    safe: vars.MAIN_SAFE || undefined,
    roles: vars.PROJECT_ROUTER_ROLES,
    fromBlock: vars.PROJECT_ROUTER_FROM_BLOCK ? BigInt(vars.PROJECT_ROUTER_FROM_BLOCK) : undefined,
    recipients,
    router,
  }, pub);
  if (b.txs.length === 0) return { status: 'already_in_role', recipients: b.recipients };
  writeFileSync(jsonOut, JSON.stringify(toTxBuilderJson(b), null, 2) + '\n');
  console.log(`  koraci: ${b.txs.map((t) => t._label).join(' → ')}`);
  console.log(`  skup: ${b.recipients.join(', ')}`);
  console.log(`  JSON za simulaciju: ${jsonOut}`);
  if (dry) return { status: 'dry', recipients: b.recipients };
  if (!vars.SAFE_DELEGATE_PRIVATE_KEY) return { status: 'no_delegate_key', recipients: b.recipients };
  const single = b.txs.length === 1;
  const p = await proposeSafeTx({
    pub, txService: re.txService, safe: b.safe,
    to: single ? getAddress(b.txs[0].to) : re.multiSend,
    data: single ? b.txs[0].data : encodeMultiSendCallOnly(b.txs),
    operation: single ? 0 : 1,
    delegateKey: vars.SAFE_DELEGATE_PRIVATE_KEY,
    origin: `safe-tx/009: ${ROLE} setup`,
  });
  return { status: 'proposed', ...p, safe: b.safe, recipients: b.recipients };
}

export function describeRouterResult(r, { env }) {
  const app = env === 'prod' ? 'gno' : 'chi';
  switch (r.status) {
    case 'not_configured': return 'ProjectRouter nije postavljen (PROJECT_ROUTER_ROLES u .env) — preskačem';
    case 'already_in_role': return 'Safe je već u roli ProjectRouter';
    case 'already_proposed': return `prijedlog već čeka potvrdu (nonce ${r.nonce}, ${r.safeTxHash})`;
    case 'needs_batch_009': return `rola još nije postavljena (${r.steps.join(' → ')}): prvo batch safe-tx/009 (2/3)`;
    case 'dry': return 'dry run — prijedlog nije poslan';
    case 'no_delegate_key': return 'nema SAFE_DELEGATE_PRIVATE_KEY u .env — prijedlog nije poslan';
    case 'proposed':
      return `prijedlog u redu Safe-a (nonce ${r.nonce}, delegate ${r.delegate}).\n` +
        `      Vlasnici potvrđuju: https://app.safe.global/transactions/queue?safe=${app}:${r.safe}\n` +
        `      Provjeriti u dekodiranom prikazu da su SVI stari projekti još na popisu.`;
    default: return JSON.stringify(r);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: a } = parseArgs({
    options: {
      env: { type: 'string', default: 'sandbox' },
      recipient: { type: 'string', multiple: true },
      vars: { type: 'string' },
      dry: { type: 'boolean', default: false },
      setup: { type: 'boolean', default: false },
      router: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const rec = a.recipient ?? [];
  if (rec.length === 0 || rec.some((r) => !isAddress(r, { strict: false }))) {
    console.error('--recipient 0x<Safe projekta> je obavezan');
    process.exit(2);
  }
  const vars = { ...loadEnv(a.env), ...(a.vars ? loadEnv(a.vars) : {}) };
  let r;
  if (a.setup) {
    if (!a.router || !isAddress(a.router, { strict: false })) { console.error('--setup traži --router 0x…'); process.exit(2); }
    r = await proposeRouterSetup({ env: a.env, recipients: rec, router: a.router, vars, dry: a.dry,
      jsonOut: a.out ?? resolve(`router-setup.${a.env}.json`) });
  } else {
    if (rec.length !== 1) { console.error('bez --setup ide jedan --recipient'); process.exit(2); }
    r = await addProjectToRouter({ env: a.env, recipient: rec[0], vars, dry: a.dry });
  }
  console.log(describeRouterResult(r, { env: a.env }));
  process.exit(['proposed', 'already_in_role', 'already_proposed', 'dry'].includes(r.status) ? 0 : 1);
}
