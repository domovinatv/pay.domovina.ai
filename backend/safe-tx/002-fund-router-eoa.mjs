#!/usr/bin/env node
/**
 * Safe Transaction Builder batch generator — fund (or refuel) the MPT
 * backend forwarder EOA with native xDAI for gas.
 *
 * Background
 * ----------
 * The backend EOA pays the gas for each `Roles.execTransactionWithRole`
 * call. At ~80k gas / forward and ~2 gwei on Gnosis, 1 xDAI ≈ 6000 forwards
 * — comfortable runway for many months at expected MPT volume. When the
 * balance gets low, re-run this script to refill from the Safe's xDAI
 * balance (top up the Safe first via CowSwap EURe→xDAI as needed).
 *
 * The batch is a single transaction: a native xDAI transfer from the Safe
 * to the EOA. No contract call, no data — just `value` set, `data = "0x"`,
 * which Safe Transaction Builder accepts as a plain ETH/native transfer.
 *
 * Invocation
 * ----------
 *   # Default (send 1.0 xDAI to production forwarder EOA):
 *   node 002-fund-router-eoa.mjs
 *
 *   # Custom amount + custom EOA (e.g. a new forwarder during rotation):
 *   node 002-fund-router-eoa.mjs --amount 0.5 --eoa 0xNewEOA...
 *
 *   # Custom output filename (e.g. dated refuel log):
 *   node 002-fund-router-eoa.mjs --out 002-fund-router-eoa-2026-05-21.json
 */
import { isAddress, parseEther, getAddress } from 'viem';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DEFAULTS = {
  safe:    '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e',
  eoa:     '0xd61289c5035c6e5eaD6F100b6A8F90ac4ee054CB',
  amount:  '1.0',
  chainId: '100',
};

const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args };

if (!isAddress(cfg.safe)) fail(`--safe "${cfg.safe}" is not a valid address`);
if (!isAddress(cfg.eoa))  fail(`--eoa "${cfg.eoa}" is not a valid address`);

let valueWei;
try {
  valueWei = parseEther(cfg.amount);
} catch (e) {
  fail(`--amount "${cfg.amount}" must be a decimal xDAI value (e.g. "1.0", "0.5")`);
}
if (valueWei <= 0n) fail(`amount must be positive`);

const batch = {
  version: '1.0',
  chainId: cfg.chainId,
  createdAt: Date.now(),
  meta: {
    name: `MPT — Fund forwarder EOA with ${cfg.amount} xDAI`,
    description: [
      `Native xDAI transfer of ${cfg.amount} from MPT main-rail Safe`,
      `${cfg.safe} to backend forwarder EOA ${cfg.eoa}.`,
      `Refuel for Roles.execTransactionWithRole gas.`,
    ].join(' '),
    txBuilderVersion: '1.16.5',
    createdFromSafeAddress: getAddress(cfg.safe),
  },
  transactions: [
    {
      to: getAddress(cfg.eoa),
      value: valueWei.toString(),
      data: '0x',
      contractMethod: null,
      contractInputsValues: null,
    },
  ],
};

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = `002-fund-router-eoa.EXECUTED.json`;
const outPath = resolve(here, args.out ?? defaultOut);
writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');

console.log(`Wrote ${outPath}`);
console.log();
console.log('── Summary ──');
console.log(`From (Safe)   : ${cfg.safe}`);
console.log(`To   (EOA)    : ${cfg.eoa}`);
console.log(`Amount        : ${cfg.amount} xDAI (= ${valueWei.toString()} wei)`);
console.log();
console.log('Next: Safe → Apps → Transaction Builder → Load batch → upload this file → 2/3 sign → execute.');
console.log('After execute, record TX hash in 002-fund-router-eoa.EXECUTED.md (sibling file).');

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
  process.stderr.write(`Usage: node 002-fund-router-eoa.mjs [flags]

Flags:
  --amount <xdai>   How much native xDAI to send (default: ${DEFAULTS.amount})
  --eoa    <0x..>   Recipient EOA address (default: ${DEFAULTS.eoa})
  --safe   <0x..>   Source Safe address (default: ${DEFAULTS.safe})
  --out    <path>   Override output path
  -h, --help        Show this help
`);
}
