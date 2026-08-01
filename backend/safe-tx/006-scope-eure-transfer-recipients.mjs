#!/usr/bin/env node
/**
 * Safe Transaction Builder batch generator — narrow the EUReForwarder role
 * from `EURe.transfer(ANY, ANY)` down to `EURe.transfer(<allowed set>, <= cap)`.
 *
 * WHY
 * ---
 * Batch 001 whitelisted the ERC-20 `transfer` SELECTOR but left both of its
 * parameters unconstrained. The software payout whitelist (ADR 0016) closes
 * the "SEPA payer names an arbitrary address" hole, but it lives in the
 * Worker: a stolen ROUTER_PRIVATE_KEY still drains the Safe to any address.
 * This batch moves part of that guarantee on-chain, where a compromised
 * backend key cannot reach it.
 *
 * ⚠️ NOT EXECUTED. This script only WRITES a template. Read
 * `006-scope-eure-transfer-recipients.md` before signing anything — it lists
 * the verification steps and the two ways this scoping can be silently
 * bypassed (MultiSend path, and the recipient set going stale).
 *
 * Usage
 * -----
 *   # Cap only — allow any recipient but at most N EURe per transfer:
 *   node 006-scope-eure-transfer-recipients.mjs --max-eur 250
 *
 *   # Recipient set (repeat --recipient), optionally with a cap:
 *   node 006-scope-eure-transfer-recipients.mjs \
 *     --recipient 0xCampaignSafe1 --recipient 0xCampaignSafe2 --max-eur 250
 *
 *   # Override Safe / Roles / role / EURe (rarely needed):
 *   node 006-scope-eure-transfer-recipients.mjs --max-eur 250 --role EUReForwarder
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

// ── Defaults (production MPT main-rail on Gnosis) ──────────────────────────
const DEFAULTS = {
  safe:    '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  roles:   '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
  role:    'EUReForwarder',
  eure:    '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
  chainId: '100',
};

const TRANSFER_SELECTOR = toFunctionSelector('transfer(address,uint256)');

// ── Zodiac Roles v2 enums (packages/evm/contracts/Types.sol) ───────────────
// ⚠️ These integer values MUST be re-verified against the deployed Modifier
// before signing — see the "Verification" section of the companion .md. A
// wrong enum value does not fail loudly; it produces a DIFFERENT permission.
const ParameterType = { None: 0, Static: 1, Dynamic: 2, Tuple: 3, Array: 4, Calldata: 5, AbiEncoded: 6 };
const Operator = { Pass: 0, And: 1, Or: 2, Nor: 3, Matches: 5, EqualTo: 16, GreaterThan: 17, LessThan: 18 };
const ExecutionOptions = { None: 0, Send: 1, DelegateCall: 2, Both: 3 };

const ROLES_ABI = [
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
];

// ── CLI ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args.flags };
const recipients = args.recipients.map((r) => {
  if (!isAddress(r)) fail(`--recipient "${r}" is not a valid EVM address`);
  return getAddress(r);
});
const maxEur = cfg['max-eur'] ? Number(cfg['max-eur']) : null;
if (cfg['max-eur'] && !(Number.isFinite(maxEur) && maxEur > 0)) {
  fail(`--max-eur "${cfg['max-eur']}" must be a positive number`);
}
if (recipients.length === 0 && maxEur === null) {
  fail('nothing to scope: pass --recipient (repeatable) and/or --max-eur');
}
for (const [k, v] of Object.entries({ safe: cfg.safe, roles: cfg.roles, eure: cfg.eure })) {
  if (!isAddress(v)) fail(`--${k} "${v}" is not a valid EVM address`);
}

// ── Build the flattened condition tree ─────────────────────────────────────
// Roles v2 takes the condition tree FLATTENED in breadth-first order, each
// node naming its parent by index. Node 0 is the root and must be
// Calldata/Matches; its children are the function parameters, in order.
//
//   [0] root      Calldata  Matches
//   [1] param `to`     Static  Or | EqualTo | Pass
//   [2] param `amount` Static  LessThan | Pass
//   [3..] EqualTo leaves, children of [1], one per allowed recipient
//
// `compValue` for a Static node is the 32-byte ABI word, i.e. the address
// left-padded to 32 bytes / the uint256 amount.
const conditions = [
  { parent: 0, paramType: ParameterType.Calldata, operator: Operator.Matches, compValue: '0x' },
];

if (recipients.length === 0) {
  conditions.push({ parent: 0, paramType: ParameterType.Static, operator: Operator.Pass, compValue: '0x' });
} else if (recipients.length === 1) {
  // `Or` requires ≥2 children — a single allowed recipient is a plain EqualTo.
  conditions.push({
    parent: 0,
    paramType: ParameterType.Static,
    operator: Operator.EqualTo,
    compValue: pad(recipients[0].toLowerCase(), { size: 32 }),
  });
} else {
  conditions.push({ parent: 0, paramType: ParameterType.Static, operator: Operator.Or, compValue: '0x' });
}

const amountNodeIndex = conditions.length;
if (maxEur === null) {
  conditions.push({ parent: 0, paramType: ParameterType.Static, operator: Operator.Pass, compValue: '0x' });
} else {
  // EURe has 18 decimals. LessThan is STRICT, so the cap is "< maxEur".
  conditions.push({
    parent: 0,
    paramType: ParameterType.Static,
    operator: Operator.LessThan,
    compValue: pad(numberToHex(parseUnits(String(maxEur), 18)), { size: 32 }),
  });
}

if (recipients.length > 1) {
  for (const r of recipients) {
    conditions.push({
      parent: 1, // the `to` parameter node
      paramType: ParameterType.Static,
      operator: Operator.EqualTo,
      compValue: pad(r.toLowerCase(), { size: 32 }),
    });
  }
}

const roleKey = stringToHex(cfg.role, { size: 32 });
const data = encodeFunctionData({
  abi: ROLES_ABI,
  functionName: 'scopeFunction',
  args: [roleKey, cfg.eure, TRANSFER_SELECTOR, conditions, ExecutionOptions.None],
});

// ── Build Safe TX Builder batch ────────────────────────────────────────────
const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: `MPT — Scope ${cfg.role} EURe.transfer`,
    description: [
      `Replace the unconditional allowFunction on EURe.transfer(address,uint256)`,
      `with a scoped condition:`,
      recipients.length
        ? `recipient ∈ {${recipients.join(', ')}}`
        : 'recipient: unconstrained',
      maxEur !== null ? `· amount < ${maxEur} EURe` : '· amount: unconstrained',
      `. Defence-in-depth for the software payout whitelist (ADR 0016): a stolen`,
      `ROUTER_PRIVATE_KEY can no longer move EURe outside these bounds.`,
    ].join(' '),
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: getAddress(cfg.safe),
  },
  transactions: [
    { to: cfg.roles, value: '0', data, contractMethod: null, contractInputsValues: null },
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, cfg.out ?? '006-scope-eure-transfer-recipients.template.json');
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
console.log();
console.log('── Summary ──');
console.log(`Safe            : ${cfg.safe}`);
console.log(`Roles Modifier  : ${cfg.roles}`);
console.log(`Role            : ${cfg.role} (key ${roleKey})`);
console.log(`EURe            : ${cfg.eure}`);
console.log(`transfer sel.   : ${TRANSFER_SELECTOR}`);
console.log(`Recipients      : ${recipients.length ? recipients.join('\n                  ') : '(unconstrained)'}`);
console.log(`Amount cap      : ${maxEur !== null ? `< ${maxEur} EURe` : '(unconstrained)'}`);
console.log(`Condition nodes : ${conditions.length} (amount node at index ${amountNodeIndex})`);
console.log();
console.log('⚠️  DO NOT SIGN before working through the Verification checklist in');
console.log('    006-scope-eure-transfer-recipients.md — the Roles v2 enum values');
console.log('    and the MultiSend bypass both need confirming against the');
console.log('    deployed Modifier.');

// ── Helpers ────────────────────────────────────────────────────────────────
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
006-scope-eure-transfer-recipients.mjs — narrow EUReForwarder's transfer scope

  --recipient 0x…   allowed payout address (repeat for a set; omit = any)
  --max-eur   250   per-transfer cap in EURe (strict <; omit = uncapped)
  --role      NAME  role name (default EUReForwarder)
  --safe/--roles/--eure/--chainId/--out   overrides

At least one of --recipient / --max-eur is required.
`);
}
