#!/usr/bin/env node
/**
 * Safe Transaction Builder batch — give a TENANT's rail router the right to
 * forward EURe from the tenant's main Safe, and nothing else (ADR 0017).
 *
 * Signed by the TENANT's Safe owners (e.g. the parish's 2/3), not by ITalk.
 * One Safe transaction, three calls on the tenant's Zodiac Roles Modifier:
 *
 *   1. scopeTarget(role, EURe)
 *   2. scopeFunction(role, EURe, transfer, [to ∈ recipients, amount < cap])
 *   3. assignRoles(router, [role], [true])
 *
 * Unlike ITalk's role (batch 001 + the unexecuted 006), the recipient set is
 * MANDATORY here: a tenant's purpose Safes are few and stable, so the chain
 * itself can enforce "only to this tenant's own Safes". A stolen router key or
 * a compromised Worker can then at most move the tenant's EURe between the
 * tenant's own Safes, under the cap.
 *
 * Prerequisite (once per tenant Safe, from the Safe UI): Apps → Zodiac →
 * Roles Modifier v2 → add. That deploys the Modifier proxy with
 * owner = avatar = target = the tenant Safe and enables it as a module.
 *
 * ⚠️ Read 007-tenant-rail-setup.md before signing — the Roles v2 enum values
 * and the fork simulation are the same mandatory checklist as batch 006.
 *
 * Usage
 * -----
 *   node 007-tenant-rail-setup.mjs \
 *     --tenant zupa-sv-marko \
 *     --safe   0xTenantMainSafe \
 *     --roles  0xTenantRolesModifier \
 *     --router 0xRouterEoaFromAdmin \
 *     --recipient 0xSafeElektrana --recipient 0xSafeKrov \
 *     --max-eur 5000
 */
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  pad,
  parseUnits,
  stringToHex,
  toFunctionSelector,
  numberToHex,
} from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  role: 'EUReForwarder',
  eure: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430', // EURe V2 on Gnosis
  chainId: '100',
};

const TRANSFER_SELECTOR = toFunctionSelector('transfer(address,uint256)');

// Zodiac Roles v2 enums — same values as batch 006, same caveat: re-verify
// against the deployed Modifier's Types.sol before signing.
const ParameterType = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 };
const Operator = { Pass: 0, And: 1, Or: 2, Nor: 3, Matches: 5, EqualTo: 16, GreaterThan: 17, LessThan: 18 };
const ExecutionOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 };

const ROLES_ABI = [
  { type: 'function', name: 'scopeTarget', inputs: [{ name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' }] },
  {
    type: 'function',
    name: 'scopeFunction',
    inputs: [
      { name: 'roleKey', type: 'bytes32' },
      { name: 'targetAddress', type: 'address' },
      { name: 'selector', type: 'bytes4' },
      {
        name: 'conditions',
        type: 'tuple[]',
        components: [
          { name: 'parent', type: 'uint8' },
          { name: 'paramType', type: 'uint8' },
          { name: 'operator', type: 'uint8' },
          { name: 'compValue', type: 'bytes' },
        ],
      },
      { name: 'options', type: 'uint8' },
    ],
  },
  { type: 'function', name: 'assignRoles', inputs: [{ name: 'module', type: 'address' }, { name: 'roleKeys', type: 'bytes32[]' }, { name: 'memberOf', type: 'bool[]' }] },
];

// ── CLI ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args.flags };
for (const k of ['tenant', 'safe', 'roles', 'router', 'max-eur']) {
  if (!cfg[k]) fail(`--${k} is required`);
}
for (const k of ['safe', 'roles', 'router', 'eure']) {
  if (!isAddress(cfg[k])) fail(`--${k} "${cfg[k]}" is not a valid EVM address`);
}
if (args.recipients.length === 0) fail('at least one --recipient is required for a tenant rail');
const recipients = args.recipients.map((r) => {
  if (!isAddress(r)) fail(`--recipient "${r}" is not a valid EVM address`);
  return getAddress(r);
});
if (recipients.some((r) => r.toLowerCase() === cfg.safe.toLowerCase())) {
  fail('the main Safe itself must not be a recipient (a memo to it is the no-op branch)');
}
const maxEur = Number(cfg['max-eur']);
if (!(Number.isFinite(maxEur) && maxEur > 0)) fail(`--max-eur "${cfg['max-eur']}" must be a positive number`);

// ── Condition tree (BFS-flattened; identical layout to batch 006) ──────────
//   [0] root Calldata Matches
//   [1] `to`     EqualTo (1 recipient) | Or (≥2)
//   [2] `amount` LessThan cap (strict)
//   [3..] EqualTo leaves under [1] when Or
const conditions = [
  { parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: '0x' },
];
if (recipients.length === 1) {
  conditions.push({ parent: 0, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: pad(recipients[0].toLowerCase(), { size: 32 }) });
} else {
  conditions.push({ parent: 0, paramType: ParameterType.Static, operator: Operator.Or, compValue: '0x' });
}
conditions.push({
  parent: 0,
  paramType: ParameterType.Static,
  operator: Operator.LessThan,
  compValue: pad(numberToHex(parseUnits(String(maxEur), 18)), { size: 32 }),
});
if (recipients.length > 1) {
  for (const r of recipients) {
    conditions.push({ parent: 1, paramType: ParameterType.Static, operator: Operator.EqualTo, compValue: pad(r.toLowerCase(), { size: 32 }) });
  }
}

const roleKey = stringToHex(cfg.role, { size: 32 });
const eure = getAddress(cfg.eure);
const txs = [
  encodeFunctionData({ abi: ROLES_ABI, functionName: 'scopeTarget', args: [roleKey, eure] }),
  encodeFunctionData({ abi: ROLES_ABI, functionName: 'scopeFunction', args: [roleKey, eure, TRANSFER_SELECTOR, conditions, ExecutionOptions.None] }),
  encodeFunctionData({ abi: ROLES_ABI, functionName: 'assignRoles', args: [getAddress(cfg.router), [roleKey], [true]] }),
].map((data) => ({ to: getAddress(cfg.roles), value: '0', data, contractMethod: null, contractInputsValues: null }));

const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: `MPT rail — ${cfg.tenant}: ${cfg.role}`,
    description:
      `Allow the MPT rail router ${getAddress(cfg.router)} to call EURe.transfer from this Safe ` +
      `ONLY to {${recipients.join(', ')}} and ONLY below ${maxEur} EURe per transfer. ` +
      `Revoke any time with assignRoles(router, [role], [false]) or disableModule. ADR 0017.`,
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: getAddress(cfg.safe),
  },
  transactions: txs,
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, cfg.out ?? `007-tenant-rail-setup.${cfg.tenant}.json`);
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');

console.log(`Wrote ${outPath}\n`);
console.log(`Tenant          : ${cfg.tenant}`);
console.log(`Safe (avatar)   : ${getAddress(cfg.safe)}`);
console.log(`Roles Modifier  : ${getAddress(cfg.roles)}`);
console.log(`Router EOA      : ${getAddress(cfg.router)}`);
console.log(`Role            : ${cfg.role} (key ${roleKey})`);
console.log(`Recipients      : ${recipients.join('\n                  ')}`);
console.log(`Cap             : < ${maxEur} EURe per transfer`);
console.log('\n⚠️  Fork-simulate before signing — see 007-tenant-rail-setup.md.');

function parseArgs(argv) {
  const flags = {};
  const recipientList = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    if (!a.startsWith('--')) fail(`unexpected positional argument: ${a}`);
    const key = a.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${key} requires a value`);
    if (key === 'recipient') recipientList.push(value);
    else flags[key] = value;
    i++;
  }
  return { flags, recipients: recipientList };
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stdout.write(`
007-tenant-rail-setup.mjs — tenant Safe: scoped EUReForwarder role for the MPT rail router

  --tenant    ID     tenant id (file name + description)
  --safe      0x…    tenant main Safe (IBAN-linked, Roles avatar)
  --roles     0x…    tenant's Zodiac Roles Modifier v2
  --router    0x…    router EOA from POST /admin/api/tenants/:id/rail/router-key
  --recipient 0x…    allowed purpose Safe (repeat; at least one)
  --max-eur   N      per-transfer cap in EURe (strict <)
  --role/--eure/--chainId/--out   overrides
`);
}
