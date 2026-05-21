#!/usr/bin/env node
/**
 * Safe Transaction Builder batch generator — manual EURe forward from the
 * MPT main-rail Safe. Used to recover orphaned mints when the automatic
 * Phase 1 backend forward couldn't fire (race conditions, RPC errors,
 * role temporarily revoked, etc).
 *
 * Generic enough to forward any EURe amount to any address — same pattern
 * as the backend's `EURe.transfer(target, amount)` call, but routed
 * directly through the Safe owners' signatures instead of the Roles
 * Modifier. Bypasses any role-scoped limits (e.g. amount cap from a
 * future batch 004).
 *
 * Usage
 * -----
 *   # Recover 1.02 EURe orphan from 2026-05-21 (order 39e395a9-…):
 *   node 003-manual-forward.mjs --amount 1.02 --target 0x6693a7D19486Dc45e9F90Fd2D515d972bBA2d65e
 *
 *   # Custom output filename so multiple recoveries don't overwrite each other:
 *   node 003-manual-forward.mjs --amount 1.02 --target 0x... --out 003-recover-2026-05-21.json
 */
import { encodeFunctionData, getAddress, isAddress, parseUnits } from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  safe:     '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  eure:     '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
  decimals: '18',
  chainId:  '100',
};

const ERC20_ABI = [
  { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] },
];

const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args };

if (!cfg.target) fail('--target is required (recipient address)');
if (!isAddress(cfg.target)) fail(`--target "${cfg.target}" is not a valid EVM address`);
if (!cfg.amount) fail('--amount is required (decimal EURe value, e.g. "1.02")');

let amountWei;
try {
  amountWei = parseUnits(cfg.amount, Number(cfg.decimals));
} catch (e) {
  fail(`--amount "${cfg.amount}" must be a decimal value (e.g. "1.02")`);
}
if (amountWei <= 0n) fail('amount must be positive');

const transferCalldata = encodeFunctionData({
  abi: ERC20_ABI,
  functionName: 'transfer',
  args: [getAddress(cfg.target), amountWei],
});

const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: `MPT — Manual EURe forward (${cfg.amount} → ${cfg.target.slice(0, 10)}…)`,
    description: [
      `Direct Safe.transfer of ${cfg.amount} EURe from the MPT main-rail Safe`,
      `${cfg.safe} to ${cfg.target}.`,
      `Use case: orphan recovery when backend auto-forward did not fire,`,
      `or one-off settlement that bypasses the Roles Modifier scoping.`,
    ].join(' '),
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: getAddress(cfg.safe),
  },
  transactions: [
    {
      to: getAddress(cfg.eure),
      value: '0',
      data: transferCalldata,
      contractMethod: null,
      contractInputsValues: null,
    },
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = '003-manual-forward.EXECUTED.json';
const outPath = resolve(here, args.out ?? defaultOut);
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
console.log();
console.log('── Summary ──');
console.log(`Safe (sender) : ${cfg.safe}`);
console.log(`EURe token    : ${cfg.eure}`);
console.log(`Target        : ${cfg.target}`);
console.log(`Amount        : ${cfg.amount} EURe (${amountWei} wei)`);
console.log();
console.log('Next: Safe → Apps → Transaction Builder → Load batch → upload this file → 2/3 sign → execute.');

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
    } else fail(`unexpected positional argument: ${a}`);
  }
  return out;
}

function fail(msg) {
  process.stderr.write(`error: ${msg}\n\n`);
  printHelp();
  process.exit(2);
}

function printHelp() {
  process.stderr.write(`Usage: node 003-manual-forward.mjs --target <0x...> --amount <eure> [flags]

Required:
  --target <0x..>   Recipient address (where the EURe should land)
  --amount <eure>   Amount in EURe (decimal, e.g. "1.02")

Optional:
  --safe   <0x..>   Source Safe (default: ${DEFAULTS.safe})
  --eure   <0x..>   EURe contract (default: ${DEFAULTS.eure})
  --out    <path>   Override output filename
  -h, --help        Show this help
`);
}
