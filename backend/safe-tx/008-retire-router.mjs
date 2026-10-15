#!/usr/bin/env node
/**
 * Safe Transaction Builder batch — retire the MPT router (ADR 0025).
 *
 * WHY
 * ---
 * Since ADR 0025 every tenant runs in direct mode: the payer's reference
 * `gnosis:<project Safe> sid:<sid>` makes Monerium mint straight into the
 * project Safe, so nothing ever forwards EURe out of the MPT main Safe. The
 * EUReForwarder role (batch 001) is then pure attack surface: whoever holds
 * ROUTER_PRIVATE_KEY (a Workers secret) can `EURe.transfer` the whole Safe to
 * any address without the 2/3 owners. Postmortem 0002 showed how close an
 * admin compromise gets to that.
 *
 * WHAT (two calls, one 2/3 signature)
 * -----------------------------------
 *   1. Roles.assignRoles(router EOA, [EUReForwarder], [false])
 *        — the router key can no longer execute anything through Roles.
 *   2. Safe.disableModule(prevModule, Roles modifier)
 *        — the Safe has no module left; every outflow needs 2/3 owners.
 *   Step 1 alone is enough; step 2 removes the module so a future role
 *   mistake cannot reopen it. `prevModule` is read on-chain (Safe modules are
 *   a linked list), so the batch stays correct if another module was added.
 *
 * Usage
 * -----
 *   node 008-retire-router.mjs                 # reads modules from Gnosis RPC
 *   node 008-retire-router.mjs --keep-module   # only step 1
 *   node 008-retire-router.mjs --rpc https://…  --out ./x.json
 *
 * After execution: delete the Workers secret ROUTER_PRIVATE_KEY and write
 * 008-retire-router.EXECUTED.md with the Safe tx hash.
 */
import { createPublicClient, encodeFunctionData, getAddress, http, pad, stringToHex } from 'viem';
import { gnosis } from 'viem/chains';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  safe:    '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  roles:   '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
  router:  '0xd61289c5035c6e5eaD6F100b6A8F90ac4ee054CB',
  role:    'EUReForwarder',
  rpc:     'https://rpc.gnosischain.com',
  chainId: '100',
};
const SENTINEL = '0x0000000000000000000000000000000000000001';

const ROLES_ABI = [{
  type: 'function', name: 'assignRoles', stateMutability: 'nonpayable', outputs: [],
  inputs: [
    { name: 'module', type: 'address' },
    { name: 'roleKeys', type: 'bytes32[]' },
    { name: 'memberOf', type: 'bool[]' },
  ],
}];
const SAFE_ABI = [
  {
    type: 'function', name: 'disableModule', stateMutability: 'nonpayable', outputs: [],
    inputs: [{ name: 'prevModule', type: 'address' }, { name: 'module', type: 'address' }],
  },
  {
    type: 'function', name: 'getModulesPaginated', stateMutability: 'view',
    inputs: [{ name: 'start', type: 'address' }, { name: 'pageSize', type: 'uint256' }],
    outputs: [{ name: 'array', type: 'address[]' }, { name: 'next', type: 'address' }],
  },
];

function parseArgs(argv) {
  const cfg = { ...DEFAULTS, keepModule: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep-module') cfg.keepModule = true;
    else if (a === '--help' || a === '-h') { console.log(usage()); process.exit(0); }
    else if (a.startsWith('--') && a.slice(2) in cfg) cfg[a.slice(2)] = argv[++i];
    else { console.error(`unknown argument ${a}\n${usage()}`); process.exit(2); }
  }
  return cfg;
}

function usage() {
  return 'node 008-retire-router.mjs [--keep-module] [--safe|--roles|--router|--role|--rpc|--out <v>]';
}

const cfg = parseArgs(process.argv.slice(2));
const safe = getAddress(cfg.safe);
const roles = getAddress(cfg.roles);
const router = getAddress(cfg.router);
const roleKey = pad(stringToHex(cfg.role), { dir: 'right', size: 32 });

const transactions = [{
  to: roles,
  value: '0',
  data: encodeFunctionData({ abi: ROLES_ABI, functionName: 'assignRoles', args: [router, [roleKey], [false]] }),
  contractMethod: ROLES_ABI[0],
  contractInputsValues: { module: router, roleKeys: `[${roleKey}]`, memberOf: '[false]' },
}];

if (!cfg.keepModule) {
  const client = createPublicClient({ chain: gnosis, transport: http(cfg.rpc) });
  const [modules] = await client.readContract({
    address: safe, abi: SAFE_ABI, functionName: 'getModulesPaginated', args: [SENTINEL, 50n],
  });
  const idx = modules.findIndex((m) => getAddress(m) === roles);
  if (idx < 0) {
    console.error(`Roles ${roles} is not an enabled module of ${safe} (modules: ${modules.join(', ') || 'none'}).`);
    console.error('Nothing to disable — rerun with --keep-module if the role still needs revoking.');
    process.exit(1);
  }
  const prevModule = idx === 0 ? SENTINEL : getAddress(modules[idx - 1]);
  transactions.push({
    to: safe,
    value: '0',
    data: encodeFunctionData({ abi: SAFE_ABI, functionName: 'disableModule', args: [prevModule, roles] }),
    contractMethod: SAFE_ABI[0],
    contractInputsValues: { prevModule, module: roles },
  });
  console.log(`modules on ${safe}: ${modules.join(', ')} → prevModule ${prevModule}`);
}

const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: 'MPT — retire router (ADR 0025)',
    description:
      `Revoke ${cfg.role} from router EOA ${router}` +
      (cfg.keepModule ? '.' : ` and disable the Roles modifier ${roles} on the Safe.`) +
      ' After this every EURe outflow from the MPT Safe needs the 2/3 owners.',
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: safe,
  },
  transactions,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = cfg.out ? resolve(cfg.out) : resolve(here, '008-retire-router.template.json');
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');
console.log(`wrote ${outPath} (${transactions.length} tx)`);
