#!/usr/bin/env node
/**
 * Safe Transaction Builder batch generator — MPT EUReForwarder role setup.
 *
 * Outputs a JSON file you can upload to Safe → Apps → Transaction Builder.
 * The batch contains 3 calls against the MPT Zodiac Roles Modifier:
 *
 *   1. scopeTarget(EUReForwarder, EURe)
 *        Registers the EURe ERC-20 contract as a *scoped* target on the role,
 *        meaning function-level permissions apply (vs `allowTarget` = wildcard).
 *   2. allowFunction(EUReForwarder, EURe, transfer(address,uint256), 0)
 *        Whitelists ONLY the `transfer(...)` selector under the role; any other
 *        call to EURe via this role reverts at the Modifier layer. `options=0`
 *        means no native value send and no DelegateCall — pure Call.
 *   3. assignRoles(BACKEND_EOA, [EUReForwarder], [true])
 *        Grants the role to the backend EOA so it can submit
 *        `execTransactionWithRole(...)` calls scoped to EURe.transfer.
 *
 * Invocations
 * -----------
 *   # Generate canonical template (with sentinel placeholder for EOA):
 *   node 001-eure-forwarder-role-setup.mjs
 *
 *   # Generate ready-to-upload patched batch:
 *   node 001-eure-forwarder-role-setup.mjs --eoa 0xYourBackendEOAAddress
 *
 *   # Override Safe / Modifier / role name (e.g. for a future fresh setup):
 *   node 001-eure-forwarder-role-setup.mjs \
 *     --safe   0x... \
 *     --roles  0x... \
 *     --eure   0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430 \
 *     --role   EUReForwarder \
 *     --eoa    0x...
 *
 * Output goes to ./001-eure-forwarder-role-setup.template.json when no --eoa,
 * or ./001-eure-forwarder-role-setup.EXECUTED.json when --eoa is supplied.
 * Override with --out path.
 */
import {
  encodeFunctionData,
  isAddress,
  stringToHex,
  getAddress,
} from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Defaults (production MPT main-rail on Gnosis chain) ────────────────────
const DEFAULTS = {
  safe:   '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  roles:  '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
  eure:   '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
  role:   'EUReForwarder',
  chainId: '100',
};

const TRANSFER_SELECTOR = '0xa9059cbb';
// Sentinel address (all-lowercase, passes viem's no-checksum-claim path) that
// we substitute out for the real backend EOA in the assignRoles calldata.
const SENTINEL = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const SENTINEL_BARE = SENTINEL.slice(2);
const PLACEHOLDER = 'REPLACE_WITH_BACKEND_EOA_HEX_LOWERCASE_X'; // exactly 40 chars

// ── CLI ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args };
const eoa = args.eoa ?? null; // null = emit template with placeholder

if (eoa !== null) {
  if (!isAddress(eoa)) {
    fail(`--eoa "${eoa}" is not a valid EVM address`);
  }
}
for (const [k, v] of Object.entries({ safe: cfg.safe, roles: cfg.roles, eure: cfg.eure })) {
  if (!isAddress(v)) fail(`--${k} "${v}" is not a valid EVM address`);
}

// ── Encode the 3 calls ─────────────────────────────────────────────────────
const ROLES_ABI = [
  { type: 'function', name: 'scopeTarget',  inputs: [{ name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' }] },
  { type: 'function', name: 'allowFunction', inputs: [{ name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' }, { name: 'selector', type: 'bytes4' }, { name: 'options', type: 'uint8' }] },
  { type: 'function', name: 'assignRoles',   inputs: [{ name: 'module', type: 'address' }, { name: 'roleKeys', type: 'bytes32[]' }, { name: 'memberOf', type: 'bool[]' }] },
];

const roleKey = stringToHex(cfg.role, { size: 32 });

const scopeTargetData = encodeFunctionData({
  abi: ROLES_ABI, functionName: 'scopeTarget',
  args: [roleKey, cfg.eure],
});

const allowFunctionData = encodeFunctionData({
  abi: ROLES_ABI, functionName: 'allowFunction',
  args: [roleKey, cfg.eure, TRANSFER_SELECTOR, 0],
});

// Encode with the sentinel; if --eoa is given, substitute. Otherwise leave the
// recognizable placeholder string so reviewers see exactly where the address
// goes and an operator can sed-substitute manually if needed.
let assignRolesData = encodeFunctionData({
  abi: ROLES_ABI, functionName: 'assignRoles',
  args: [SENTINEL, [roleKey], [true]],
});
if (eoa) {
  const eoaBare = eoa.toLowerCase().replace(/^0x/, '');
  assignRolesData = assignRolesData.replace(SENTINEL_BARE, eoaBare);
} else {
  assignRolesData = assignRolesData.replace(SENTINEL_BARE, PLACEHOLDER);
}

// ── Build Safe TX Builder batch ────────────────────────────────────────────
const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: `MPT — Configure ${cfg.role} role`,
    description: [
      `Scope ${TRANSFER_SELECTOR} (EURe.transfer) + grant ${cfg.role} role to`,
      eoa ? `EOA ${eoa}` : `<EOA — see ${PLACEHOLDER} sentinel>`,
      `on Roles Modifier ${cfg.roles} attached to Safe ${cfg.safe}.`,
    ].join(' '),
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: getAddress(cfg.safe),
  },
  transactions: [
    { to: cfg.roles, value: '0', data: scopeTargetData,  contractMethod: null, contractInputsValues: null },
    { to: cfg.roles, value: '0', data: allowFunctionData, contractMethod: null, contractInputsValues: null },
    { to: cfg.roles, value: '0', data: assignRolesData,   contractMethod: null, contractInputsValues: null },
  ],
};

// ── Write ──────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = eoa
  ? '001-eure-forwarder-role-setup.EXECUTED.json'
  : '001-eure-forwarder-role-setup.template.json';
const outPath = resolve(here, args.out ?? defaultOut);
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
console.log();
console.log('── Summary ──');
console.log(`Safe          : ${cfg.safe}`);
console.log(`Roles Modifier: ${cfg.roles}`);
console.log(`EURe contract : ${cfg.eure}`);
console.log(`Role name     : ${cfg.role}`);
console.log(`Role key      : ${roleKey}`);
console.log(`Backend EOA   : ${eoa ?? '(template — patch ' + PLACEHOLDER + ' before upload)'}`);
console.log();
console.log('Next: Safe → Apps → Transaction Builder → Load batch → upload this file → 2/3 sign → execute.');

// ── Helpers ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`--${key} requires a value`);
      out[key] = value;
      i++;
    } else {
      fail(`unexpected positional argument: ${a}`);
    }
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(`Usage: node 001-eure-forwarder-role-setup.mjs [flags]

Flags:
  --eoa    <0x..>   Backend EOA to grant the role. Omit to emit template.
  --safe   <0x..>   Override Safe address (default: ${DEFAULTS.safe})
  --roles  <0x..>   Override Roles Modifier (default: ${DEFAULTS.roles})
  --eure   <0x..>   Override EURe contract (default: ${DEFAULTS.eure})
  --role   <name>   Override role name (default: ${DEFAULTS.role})
  --out    <path>   Override output path
  -h, --help        Show this help
`);
}
