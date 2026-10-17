#!/usr/bin/env node
/**
 * Safe Transaction Builder batch — the ProjectRouter role (ADR 0026).
 *
 * WHY
 * ---
 * Revolut drops the payment reference, so Monerium mints into the MPT main
 * Safe and the payment becomes a D4 `direct_owed` debt. ProjectRouter lets
 * the rail settle that debt itself, but ONLY by `EURe.transfer` to a project
 * Safe the 2/3 owners approved. The restriction lives in the Roles modifier,
 * on-chain: a stolen router key or a compromised Worker can at most move EURe
 * into the wrong one of OUR OWN projects.
 *
 * WHAT (one Safe tx, 2/3 owners)
 * ------------------------------
 *   [enableModule(Roles)]                         only if not enabled yet
 *   [revokeTarget(EUReForwarder, t) …]            every target the retired role
 *                                                 still has (read from chain)
 *   scopeTarget(ProjectRouter, EURe)
 *   scopeFunction(ProjectRouter, EURe, transfer,
 *     to ∈ {chain set ∪ --recipient}, amount Pass, ExecutionOptions.None)
 *   [assignRoles(router, [ProjectRouter], [true])] only with --router
 *
 * Re-running with one more --recipient gives the "add a project" batch:
 * scopeFunction REPLACES the whole tree, so the set is always the full one
 * (current chain set + new). Steps that are already in place are skipped.
 *
 * Usage
 * -----
 *   node 009-project-router-role.mjs --env gnosis --router 0x… --recipient 0x…
 *   node 009-project-router-role.mjs --env chiado --roles 0x… --router 0x… \
 *        --recipient 0x… --recipient 0x…
 *   node 009-project-router-role.mjs --env gnosis --recipient 0xNEW   # add a project
 *
 * ⚠️ Fork-simulate before signing: 009-simulate-fork.mjs (see the README §009).
 */
import { createPublicClient, http, isAddress } from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { ENVS, ROLE, buildProjectRouterBatch, toTxBuilderJson } from './lib/project-router-batch.mjs';

export { ENVS, ROLE, buildProjectRouterBatch, toTxBuilderJson };

function usage() {
  return `009-project-router-role.mjs — ProjectRouter role on a main Safe (ADR 0026)

  --env        gnosis | chiado              (required)
  --recipient  0x…   project Safe to ADD (repeatable; the chain set is kept)
  --router     0x…   router EOA to make a member (first setup / key rotation)
  --revoke-router 0x…  remove a member (key rotation: old one)
  --roles      0x…   Roles modifier (required on chiado)
  --from-block N     first block to read permission events from
  --safe/--eure/--rpc/--out   overrides
  --no-legacy-cleanup         keep the retired role's targets`;
}

function parseArgs(argv) {
  const out = { recipients: [], legacyCleanup: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    if (a === '--no-legacy-cleanup') { out.legacyCleanup = false; continue; }
    if (!a.startsWith('--') || argv[i + 1] === undefined) fail(`bad argument ${a}`);
    const k = a.slice(2);
    const v = argv[++i];
    if (k === 'recipient') out.recipients.push(v);
    else out[k] = v;
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}\n\n${usage()}`);
  process.exit(2);
}

// ── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (!a.env) fail('--env is required');
  const env = ENVS[a.env];
  if (!env) fail(`unknown --env ${a.env}`);
  for (const r of a.recipients) if (!isAddress(r, { strict: false })) fail(`--recipient ${r} is not an address`);
  const client = createPublicClient({ chain: env.chain, transport: http(a.rpc ?? env.rpc) });
  let b;
  try {
    b = await buildProjectRouterBatch({
      env: a.env, safe: a.safe, roles: a.roles, eure: a.eure,
      fromBlock: a['from-block'] !== undefined ? BigInt(a['from-block']) : undefined,
      recipients: a.recipients, router: a.router, revokeRouter: a['revoke-router'],
      legacyCleanup: a.legacyCleanup,
    }, client);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
  if (b.txs.length === 0) {
    console.log('Nothing to do: the chain already matches.');
    process.exit(0);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = a.out ? resolve(a.out) : resolve(here, `009-project-router-role.${a.env}.json`);
  writeFileSync(outPath, JSON.stringify(toTxBuilderJson(b), null, 2) + '\n');
  console.log(`Wrote ${outPath} (${b.txs.length} calls)\n`);
  console.log(`Safe        : ${b.safe}`);
  console.log(`Roles       : ${b.roles}`);
  console.log(`Role        : ${ROLE} (${b.roleKey})`);
  console.log(`On chain    : ${b.before.length ? b.before.join(', ') : '(not scoped yet)'}`);
  console.log(`New set     : ${b.recipients.join('\n              ')}`);
  console.log(`Added       : ${b.added.join(', ') || '-'}`);
  console.log(`Calls       : ${b.txs.map((t) => t._label).join(' → ')}`);
  for (const n of b.notes) console.log(`note        : ${n}`);
  console.log('\n⚠️  Fork-simulate before signing: node 009-simulate-fork.mjs --env ' + a.env + ' --batch ' + outPath);
}
