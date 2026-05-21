#!/usr/bin/env node
/**
 * Safe Transaction Builder batch generator — EUReForwarder role extension
 * for PaymentRegistry + MultiSendCallOnly.
 *
 * The original role (001-eure-forwarder-role-setup) only whitelists
 * `EURe.transfer(address,uint256)`. To emit a `Payment` event alongside
 * each forward in the SAME transaction hash, the role needs two more
 * permissions:
 *
 *   3. scopeTarget(EUReForwarder, PaymentRegistry)
 *   4. allowFunction(EUReForwarder, PaymentRegistry,
 *                    record(bytes32,bytes32,address,address,uint256,string),
 *                    options=None)
 *   5. scopeTarget(EUReForwarder, MultiSendCallOnly)
 *   6. allowFunction(EUReForwarder, MultiSendCallOnly,
 *                    multiSend(bytes),
 *                    options=DelegateCall)
 *
 * The MultiSendCallOnly target is whitelisted as DelegateCall so the
 * router EOA can batch `[registry.record(...), eure.transfer(...)]` into
 * one Safe execTransactionWithRole call. CallOnly variant is preferred
 * over plain MultiSend — it rejects nested DELEGATECALLs, blocking the
 * "delegatecall escape" exploit class even if our role logic ever
 * regresses.
 *
 * Output: `005-extend-role-payment-registry.{template,EXECUTED}.json`.
 * Upload to Safe → Apps → Transaction Builder, 2/3 sign, execute.
 *
 * Usage
 * -----
 *   # Template (placeholder for registry address):
 *   node 005-extend-role-payment-registry.mjs
 *
 *   # Ready-to-upload batch with concrete registry address:
 *   node 005-extend-role-payment-registry.mjs \
 *     --registry 0xYourPaymentRegistryAddress
 *
 *   # Override Safe / Roles / role / multisend (rarely needed):
 *   node 005-extend-role-payment-registry.mjs \
 *     --registry 0x... \
 *     --multisend 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D   # v1.3.0
 */
import {
  encodeFunctionData,
  isAddress,
  stringToHex,
  getAddress,
  toFunctionSelector,
} from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ── Defaults (production MPT main-rail on Gnosis) ──────────────────────────
const DEFAULTS = {
  safe:      '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  roles:     '0x330347d656b1a5DF972f758DE1E25E99ec36762c',
  role:      'EUReForwarder',
  // Safe MultiSendCallOnly v1.4.1 — canonical deterministic deploy. If the
  // Safe is on master copy v1.3.0 instead, override with
  // 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D.
  multisend: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  chainId:   '100',
};

// Zodiac Roles V2 ExecutionOptions enum.
const OPT_NONE = 0;
const OPT_SEND = 1;
const OPT_DELEGATECALL = 2;
const OPT_BOTH = 3;

const RECORD_SELECTOR = toFunctionSelector(
  'record(bytes32,bytes32,address,address,uint256,string)',
);
const MULTISEND_SELECTOR = toFunctionSelector('multiSend(bytes)');

const SENTINEL_REGISTRY = '0xcafe0000cafe0000cafe0000cafe0000cafe0000';
const SENTINEL_BARE = SENTINEL_REGISTRY.slice(2);
const PLACEHOLDER = 'REPLACE_WITH_REGISTRY_ADDRESS_HEX_LOWERCAS'; // 40 chars

// ── CLI ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args };
const registry = args.registry ?? null;

if (registry !== null && !isAddress(registry)) {
  fail(`--registry "${registry}" is not a valid EVM address`);
}
for (const [k, v] of Object.entries({
  safe: cfg.safe, roles: cfg.roles, multisend: cfg.multisend,
})) {
  if (!isAddress(v)) fail(`--${k} "${v}" is not a valid EVM address`);
}

// ── Encode the 4 calls ─────────────────────────────────────────────────────
const ROLES_ABI = [
  { type: 'function', name: 'scopeTarget', inputs: [
      { name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' },
  ] },
  { type: 'function', name: 'allowFunction', inputs: [
      { name: 'roleKey', type: 'bytes32' }, { name: 'targetAddress', type: 'address' },
      { name: 'selector', type: 'bytes4' }, { name: 'options', type: 'uint8' },
  ] },
];

const roleKey = stringToHex(cfg.role, { size: 32 });
const registryArg = registry ?? SENTINEL_REGISTRY;

const calls = [
  {
    label: 'scopeTarget(role, PaymentRegistry)',
    data: encodeFunctionData({
      abi: ROLES_ABI, functionName: 'scopeTarget',
      args: [roleKey, registryArg],
    }),
  },
  {
    label: `allowFunction(role, PaymentRegistry, ${RECORD_SELECTOR}, None)`,
    data: encodeFunctionData({
      abi: ROLES_ABI, functionName: 'allowFunction',
      args: [roleKey, registryArg, RECORD_SELECTOR, OPT_NONE],
    }),
  },
  {
    label: 'scopeTarget(role, MultiSendCallOnly)',
    data: encodeFunctionData({
      abi: ROLES_ABI, functionName: 'scopeTarget',
      args: [roleKey, cfg.multisend],
    }),
  },
  {
    label: `allowFunction(role, MultiSendCallOnly, ${MULTISEND_SELECTOR}, DelegateCall)`,
    data: encodeFunctionData({
      abi: ROLES_ABI, functionName: 'allowFunction',
      args: [roleKey, cfg.multisend, MULTISEND_SELECTOR, OPT_DELEGATECALL],
    }),
  },
];

// If no concrete registry was supplied, swap the sentinel for a recognizable
// placeholder string so a reviewer sees exactly where to substitute.
if (!registry) {
  for (const c of calls) {
    c.data = c.data.replace(SENTINEL_BARE, PLACEHOLDER);
  }
}

// ── Build Safe TX Builder batch ────────────────────────────────────────────
const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: `MPT — Extend ${cfg.role} for PaymentRegistry`,
    description: [
      `Add scoped permissions to the ${cfg.role} role on Roles Modifier ${cfg.roles}:`,
      `(a) PaymentRegistry.record(...) at ${registry ?? '<' + PLACEHOLDER + '>'},`,
      `(b) MultiSendCallOnly.multiSend(bytes) at ${cfg.multisend} via DelegateCall.`,
      `Enables atomic [registry.record + eure.transfer] forward batches under the existing role.`,
    ].join(' '),
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: getAddress(cfg.safe),
  },
  transactions: calls.map((c) => ({
    to: cfg.roles, value: '0', data: c.data,
    contractMethod: null, contractInputsValues: null,
  })),
};

// ── Write ──────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = registry
  ? '005-extend-role-payment-registry.EXECUTED.json'
  : '005-extend-role-payment-registry.template.json';
const outPath = resolve(here, args.out ?? defaultOut);
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
console.log();
console.log('── Summary ──');
console.log(`Safe              : ${cfg.safe}`);
console.log(`Roles Modifier    : ${cfg.roles}`);
console.log(`Role              : ${cfg.role} (key ${roleKey})`);
console.log(`PaymentRegistry   : ${registry ?? '(template — patch ' + PLACEHOLDER + ' before upload)'}`);
console.log(`MultiSendCallOnly : ${cfg.multisend}`);
console.log(`record selector   : ${RECORD_SELECTOR}`);
console.log(`multiSend selector: ${MULTISEND_SELECTOR}`);
console.log();
console.log('Calls in batch:');
for (const [i, c] of calls.entries()) console.log(`  ${i + 1}. ${c.label}`);
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
  process.stderr.write(`Usage: node 005-extend-role-payment-registry.mjs [flags]

Flags:
  --registry  <0x..>   PaymentRegistry contract address (from 004 deploy).
                       Omit to emit template with placeholder.
  --safe      <0x..>   Override Safe address       (default: ${DEFAULTS.safe})
  --roles     <0x..>   Override Roles Modifier     (default: ${DEFAULTS.roles})
  --role      <name>   Override role name          (default: ${DEFAULTS.role})
  --multisend <0x..>   Override MultiSendCallOnly  (default: ${DEFAULTS.multisend})
  --out       <path>   Override output path
  -h, --help           Show this help
`);
}
