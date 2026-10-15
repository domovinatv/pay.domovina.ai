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
import { createPublicClient, encodeFunctionData, getAddress, http, isAddress } from 'viem';
import { gnosis, gnosisChiado } from 'viem/chains';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ExecutionOptions,
  ROLES_ABI,
  ROLES_MASTERCOPY,
  SAFE_ABI,
  SENTINEL,
  TRANSFER_SELECTOR,
  normaliseRecipients,
  readRecipientSet,
  readRoleTargets,
  roleKeyOf,
  transferRecipientConditions,
} from './lib/roles-v2.mjs';

export const ENVS = {
  gnosis: {
    chain: gnosis,
    chainId: '100',
    rpc: 'https://rpc.gnosischain.com',
    safe: '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
    roles: '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
    eure: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
    // Batch 001 set the modifier up in this block; nothing older matters.
    fromBlock: 46_280_000n,
    legacyRole: 'EUReForwarder',
  },
  chiado: {
    chain: gnosisChiado,
    chainId: '10200',
    rpc: 'https://rpc.chiadochain.net',
    safe: '0xe2e21755d3F576F090Ecda1D830F3fDA865f37fF', // italk-sandbox main Safe
    roles: null, // deployed per Safe — pass --roles
    eure: '0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71',
    fromBlock: null, // pass --from-block (the modifier's deploy block)
    legacyRole: null,
  },
};

export const ROLE = 'ProjectRouter';

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

export async function buildProjectRouterBatch(opts, client) {
  const env = ENVS[opts.env];
  if (!env) throw new Error(`--env must be gnosis or chiado`);
  const safe = getAddress(opts.safe ?? env.safe);
  const roles = opts.roles ?? env.roles;
  if (!roles || !isAddress(roles)) throw new Error('--roles is required (Roles modifier address)');
  const rolesAddr = getAddress(roles);
  const eure = getAddress(opts.eure ?? env.eure);
  const fromBlock = opts.fromBlock ?? env.fromBlock;
  if (fromBlock === null || fromBlock === undefined) throw new Error('--from-block is required on this env');
  const roleKey = roleKeyOf(ROLE);
  const notes = [];

  // ── Preflight: the modifier must be ours and run the audited mastercopy ──
  for (const f of ['owner', 'avatar', 'target']) {
    const v = await client.readContract({ address: rolesAddr, abi: ROLES_ABI, functionName: f });
    if (getAddress(v) !== safe) throw new Error(`Roles.${f}() = ${v}, expected the Safe ${safe}`);
  }
  const code = (await client.getCode({ address: rolesAddr })) ?? '0x';
  if (!code.toLowerCase().includes(ROLES_MASTERCOPY.slice(2).toLowerCase())) {
    throw new Error(`Roles ${rolesAddr} is not a minimal proxy of the verified mastercopy ${ROLES_MASTERCOPY}`);
  }

  const txs = [];
  const roleTx = (functionName, args) => ({
    to: rolesAddr, value: '0',
    data: encodeFunctionData({ abi: ROLES_ABI, functionName, args }),
    contractMethod: null, contractInputsValues: null,
    _label: `Roles.${functionName}`,
  });

  // 1. Module on the Safe.
  const [modules] = await client.readContract({
    address: safe, abi: SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 50n],
  });
  const foreign = modules.filter((m) => getAddress(m) !== rolesAddr);
  if (foreign.length) throw new Error(`Safe has unexpected modules: ${foreign.join(', ')} — investigate first`);
  if (modules.length === 0) {
    txs.push({
      to: safe, value: '0',
      data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'enableModule', args: [rolesAddr] }),
      contractMethod: null, contractInputsValues: null, _label: 'Safe.enableModule',
    });
  } else notes.push('Roles is already an enabled module');

  // 2. The retired role must not come back to life with the module.
  if (opts.legacyCleanup !== false && env.legacyRole) {
    const legacyKey = roleKeyOf(env.legacyRole);
    const live = await readRoleTargets(client, { roles: rolesAddr, roleKey: legacyKey, fromBlock });
    for (const t of live) txs.push(roleTx('revokeTarget', [legacyKey, t]));
    notes.push(`${env.legacyRole}: ${live.length ? `revoking ${live.join(', ')}` : 'no live targets'}`);
  }

  // 3–4. Scope EURe.transfer to the full project set.
  const current = await readRecipientSet(client, { roles: rolesAddr, roleKey, eure, fromBlock });
  if (current && current.options !== ExecutionOptions.None) {
    throw new Error(`current ProjectRouter options = ${current.options}, expected None — investigate first`);
  }
  const before = current?.recipients ?? [];
  const recipients = normaliseRecipients([...before, ...opts.recipients], { safe });
  const added = recipients.filter((r) => !before.includes(r));
  const targetLive = (await readRoleTargets(client, { roles: rolesAddr, roleKey, fromBlock })).includes(eure);
  if (!targetLive) txs.push(roleTx('scopeTarget', [roleKey, eure]));
  if (added.length || !current) {
    txs.push(roleTx('scopeFunction', [
      roleKey, eure, TRANSFER_SELECTOR, transferRecipientConditions(recipients), ExecutionOptions.None,
    ]));
  } else notes.push('recipient set unchanged — no scopeFunction');

  // 5. Members.
  if (opts.router) txs.push(roleTx('assignRoles', [getAddress(opts.router), [roleKey], [true]]));
  if (opts.revokeRouter) txs.push(roleTx('assignRoles', [getAddress(opts.revokeRouter), [roleKey], [false]]));

  return { safe, roles: rolesAddr, eure, roleKey, before, recipients, added, txs, notes, chainId: env.chainId };
}

export function toTxBuilderJson(b, { name } = {}) {
  return {
    version: '1.0',
    chainId: b.chainId,
    createdAt: Date.now(),
    meta: {
      name: name ?? `MPT — ${ROLE} (ADR 0026)`,
      description:
        `${ROLE} may call ONLY EURe.transfer from this Safe, and ONLY to: ${b.recipients.join(', ')}. ` +
        `No amount cap, no value, no delegatecall. Steps: ${b.txs.map((t) => t._label).join(', ')}. ` +
        `Check that every existing project is still in the list before signing.`,
      txBuilderVersion: '1.16.5',
      createdFromSafeAddress: b.safe,
    },
    transactions: b.txs.map(({ _label, ...t }) => t),
  };
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
