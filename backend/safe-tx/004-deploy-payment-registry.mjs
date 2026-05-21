#!/usr/bin/env node
/**
 * Deploy PaymentRegistry to Gnosis Chain.
 *
 * Reads the compiled artifact at `../contracts/PaymentRegistry.json`
 * (produced by `node ../contracts/compile.mjs`) and broadcasts a contract
 * creation tx using the MPT backend forwarder EOA (same key that runs the
 * automated `EURe.transfer` forward — it's already funded with xDAI per
 * batch 002 and has nothing else to lose).
 *
 * Deploy is one-shot and idempotent — if a previous run wrote
 * `004-deploy-payment-registry.EXECUTED.json`, this script refuses to run
 * again unless `--force` is passed (defensive against accidental
 * re-deploys; the on-chain contract has no state to migrate).
 *
 * Usage
 * -----
 *   # Export the router EOA private key in a sub-shell (NEVER inline it):
 *   export ROUTER_PRIVATE_KEY=$(op read "op://Private/MPT backend EOA/private key")
 *
 *   # Dry-run (no broadcast — estimates gas + previews):
 *   node 004-deploy-payment-registry.mjs --dry-run
 *
 *   # For real:
 *   node 004-deploy-payment-registry.mjs
 *
 *   # Override RPC if the default is rate-limited:
 *   node 004-deploy-payment-registry.mjs --rpc https://rpc.ankr.com/gnosis
 *
 * After
 * -----
 *   - Address + tx hash written to `004-deploy-payment-registry.EXECUTED.json`
 *   - Verify command printed for Gnosisscan (manual upload of source +
 *     compiler settings) — verify is one-shot and not in this script.
 *   - Address feeds into the next batch (`005-extend-role-...`) which
 *     whitelists `record(...)` under the EUReForwarder role.
 */
import { createPublicClient, createWalletClient, http, parseGwei } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT = resolve(HERE, '..', 'contracts', 'PaymentRegistry.json');
const EXECUTED_PATH = resolve(HERE, '004-deploy-payment-registry.EXECUTED.json');

const DEFAULTS = {
  rpc: 'https://rpc.gnosischain.com',
  chainId: 100,
};

const args = parseArgs(process.argv.slice(2));
const cfg = { ...DEFAULTS, ...args };
const dryRun = Boolean(args['dry-run'] || args.dryRun);
const force = Boolean(args.force);

if (!process.env.ROUTER_PRIVATE_KEY) {
  fail('ROUTER_PRIVATE_KEY env var is required — export it from 1Password in a sub-shell.');
}
const pk = process.env.ROUTER_PRIVATE_KEY.trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  fail('ROUTER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string.');
}

if (existsSync(EXECUTED_PATH) && !force && !dryRun) {
  const prev = JSON.parse(readFileSync(EXECUTED_PATH, 'utf8'));
  fail(
    `previous deployment recorded at ${EXECUTED_PATH}\n` +
    `  contract: ${prev.contractAddress}\n` +
    `  tx:       ${prev.transactionHash}\n` +
    `pass --force to redeploy (you almost certainly do not want to).`,
  );
}

const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
if (artifact.contractName !== 'PaymentRegistry') {
  fail(`artifact name mismatch: ${artifact.contractName}`);
}
if (!/^0x[0-9a-fA-F]+$/.test(artifact.bytecode)) {
  fail('artifact.bytecode missing or malformed');
}

const account = privateKeyToAccount(pk);
const rpc = http(cfg.rpc);
const pub = createPublicClient({ chain: gnosis, transport: rpc });
const wallet = createWalletClient({ account, chain: gnosis, transport: rpc });

const [balance, nonce, gasPrice] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.getTransactionCount({ address: account.address }),
  pub.getGasPrice(),
]);

console.error('=== PaymentRegistry deploy preview ===');
console.error(`deployer:       ${account.address}`);
console.error(`balance:        ${formatXdai(balance)} xDAI`);
console.error(`nonce:          ${nonce}`);
console.error(`gas price:      ${(Number(gasPrice) / 1e9).toFixed(3)} gwei`);
console.error(`bytecode size:  ${(artifact.bytecode.length - 2) / 2} bytes`);
console.error(`compiler:       solc ${artifact.compiler.version}`);
console.error(`optimizer:      ${artifact.compiler.settings.optimizer.enabled ? `enabled (${artifact.compiler.settings.optimizer.runs} runs)` : 'disabled'}`);
console.error(`evmVersion:     ${artifact.compiler.settings.evmVersion}`);
console.error(`chainId:        ${cfg.chainId}`);
console.error(`rpc:            ${cfg.rpc}`);

const gasEstimate = await pub.estimateGas({
  account: account.address,
  data: artifact.bytecode,
});
const gasCost = gasEstimate * gasPrice;
console.error(`gas estimate:   ${gasEstimate} (~${formatXdai(gasCost)} xDAI)`);

if (balance < gasCost * 2n) {
  console.error(`\n⚠  deployer balance is < 2× estimated cost — fund the EOA with more xDAI first.`);
  if (!dryRun) fail('aborting: insufficient deployer balance.');
}

if (dryRun) {
  console.error('\n--dry-run: not broadcasting.');
  process.exit(0);
}

console.error('\nbroadcasting deployment tx…');
const txHash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
});
console.error(`tx hash:        ${txHash}`);
console.error('waiting for receipt…');
const receipt = await pub.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
if (receipt.status !== 'success') {
  fail(`deployment tx reverted (status=${receipt.status}). See ${txHash}.`);
}
console.error(`block:          ${receipt.blockNumber}`);
console.error(`contract:       ${receipt.contractAddress}`);
console.error(`gas used:       ${receipt.gasUsed} (${formatXdai(receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice))} xDAI)`);

const record = {
  contractName: 'PaymentRegistry',
  contractAddress: receipt.contractAddress,
  transactionHash: txHash,
  blockNumber: receipt.blockNumber.toString(),
  deployer: account.address,
  chainId: cfg.chainId,
  rpc: cfg.rpc,
  compiler: artifact.compiler,
  bytecodeSize: (artifact.bytecode.length - 2) / 2,
  gasUsed: receipt.gasUsed.toString(),
  effectiveGasPriceGwei: receipt.effectiveGasPrice ? (Number(receipt.effectiveGasPrice) / 1e9).toFixed(6) : null,
  costXdai: formatXdai(receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice)),
  deployedAt: new Date().toISOString(),
};
writeFileSync(EXECUTED_PATH, JSON.stringify(record, null, 2) + '\n', 'utf8');

console.error('\n=== verify on Gnosisscan ===');
console.error(`https://gnosisscan.io/address/${receipt.contractAddress}#code`);
console.error('Submit single-file source `backend/contracts/PaymentRegistry.sol` with:');
console.error(`  Compiler:    v${artifact.compiler.version}+commit (Solidity)`);
console.error(`  Optimizer:   Yes, ${artifact.compiler.settings.optimizer.runs} runs`);
console.error(`  EVM version: ${artifact.compiler.settings.evmVersion}`);
console.error(`  Constructor args: (none)`);
console.error('');
console.error(`saved deployment record → ${EXECUTED_PATH}`);

function formatXdai(wei) {
  const s = wei.toString().padStart(19, '0');
  return `${s.slice(0, -18) || '0'}.${s.slice(-18, -12)}`;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}
