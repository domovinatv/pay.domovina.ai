#!/usr/bin/env node
/**
 * Fork simulation for batch 009 (ADR 0026). No signature, no real chain
 * state changes: starts `anvil --fork-url`, executes the batch AS the Safe
 * (impersonated), then proves the permission both ways:
 *
 *   ✓ router → transfer(allowed project, 1 wei)            passes, balance moves
 *   ✗ router → transfer(address outside the set)             reverts
 *   ✗ router → transfer(allowed) with xDAI value             reverts
 *   ✗ router → transfer(allowed) as DelegateCall             reverts
 *   ✗ router → EURe.approve(allowed, 1)                      reverts
 *   ✗ non-member → transfer(allowed)                         reverts
 *   ✗ old router (EUReForwarder) → transfer(anyone)          reverts (gnosis)
 *
 * Without the first ✓ there is no signature: a passing legitimate transfer is
 * the only proof the rail is not locked out.
 *
 *   node 009-simulate-fork.mjs --env gnosis --batch 009-project-router-role.gnosis.json
 *   node 009-simulate-fork.mjs --env chiado --batch … --roles 0x…
 *
 * Needs Foundry's anvil (~/.foundry/bin/anvil).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  createTestClient,
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  publicActions,
  walletActions,
} from 'viem';

import { ENVS, ROLE } from './009-project-router-role.mjs';
import { ROLES_ABI, roleKeyOf } from './lib/roles-v2.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const env = ENVS[args.env];
if (!env || !args.batch) {
  console.error('usage: node 009-simulate-fork.mjs --env gnosis|chiado --batch <json> [--rpc url] [--port 8545]');
  process.exit(2);
}
const batch = JSON.parse(readFileSync(args.batch, 'utf8'));
const safe = getAddress(batch.meta.createdFromSafeAddress);
const eure = getAddress(args.eure ?? env.eure);
const OLD_ROUTER = '0xd61289c5035c6e5eaD6F100b6A8F90ac4ee054CB';
const ERC20 = parseAbi([
  'function transfer(address,uint256) returns (bool)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

// Recipients + router straight from the batch calldata (what will be signed).
let rolesAddr = null;
let router = null;
let recipients = [];
for (const t of batch.transactions) {
  let d;
  try { d = decodeFunctionData({ abi: ROLES_ABI, data: t.data }); } catch { continue; }
  rolesAddr = getAddress(t.to);
  if (d.functionName === 'assignRoles' && d.args[2][0] === true) router = getAddress(d.args[0]);
  if (d.functionName === 'scopeFunction') {
    recipients = d.args[3].filter((c) => c.operator === 16).map((c) => getAddress(`0x${c.compValue.slice(-40)}`));
  }
}
rolesAddr = rolesAddr ?? getAddress(args.roles ?? env.roles);
router = router ?? (args.router ? getAddress(args.router) : null);
if (!router) throw new Error('batch has no assignRoles(…, true) — pass --router <member> to test an existing one');
if (!recipients.length) throw new Error('batch has no scopeFunction — nothing to prove');

const port = Number(args.port ?? 8545 + Math.floor(Math.random() * 1000));
const anvilBin = `${homedir()}/.foundry/bin/anvil`;
const anvil = spawn(anvilBin, ['--fork-url', args.rpc ?? env.rpc, '--port', String(port), '--silent', '--chain-id', env.chainId], { stdio: 'inherit' });
const url = `http://127.0.0.1:${port}`;
const client = createTestClient({ mode: 'anvil', chain: { ...env.chain, rpcUrls: { default: { http: [url] } } }, transport: http(url) })
  .extend(publicActions).extend(walletActions);

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { failures++; console.log(`  ✗ ${msg}`); };

try {
  for (let i = 0; i < 50; i++) {
    try { await client.getBlockNumber(); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }
  console.log(`fork of ${args.env} at block ${await client.getBlockNumber()} (anvil :${port})`);
  console.log(`Safe ${safe} · Roles ${rolesAddr} · router ${router}`);
  console.log(`recipients: ${recipients.join(', ')}\n`);

  // ── Execute the batch as the Safe ──
  await client.impersonateAccount({ address: safe });
  await client.setBalance({ address: safe, value: 10n ** 18n });
  for (const [i, t] of batch.transactions.entries()) {
    const hash = await client.sendTransaction({ account: safe, to: getAddress(t.to), data: t.data, value: BigInt(t.value) });
    const r = await client.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(`batch call ${i} reverted`);
  }
  ok(`batch executed (${batch.transactions.length} calls)`);
  await client.stopImpersonatingAccount({ address: safe });

  const roleKey = roleKeyOf(ROLE);
  const allowed = recipients[0];
  const outsider = '0x000000000000000000000000000000000000bEEF';
  const transfer = (to, amt = 1n) => encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amt] });
  const exec = (from, { to = eure, value = 0n, data, op = 0, key = roleKey }) =>
    client.simulateContract({
      account: from, address: rolesAddr, abi: ROLES_ABI, functionName: 'execTransactionWithRole',
      args: [to, value, data, op, key, true],
    });
  const expectRevert = async (label, p) => {
    try { await p; bad(`${label} PASSED but must revert`); } catch { ok(`${label} reverts`); }
  };

  for (const a of [router, OLD_ROUTER, '0x0000000000000000000000000000000000c0FFEE']) {
    await client.impersonateAccount({ address: a });
    await client.setBalance({ address: a, value: 10n ** 18n });
  }

  const bal = await client.readContract({ address: eure, abi: ERC20, functionName: 'balanceOf', args: [safe] });
  if (bal === 0n) bad('Safe holds 0 EURe on this fork — cannot prove a passing transfer');
  for (const r of recipients) {
    try {
      await exec(router, { data: transfer(r) });
      ok(`router → transfer(${r}, 1 wei) passes`);
    } catch (e) {
      bad(`router → transfer(${r}) REVERTED: ${e.shortMessage ?? e.message}`);
    }
  }
  // A real tx for the first one, with the balance check.
  const before = await client.readContract({ address: eure, abi: ERC20, functionName: 'balanceOf', args: [allowed] });
  const hash = await client.writeContract({
    account: router, address: rolesAddr, abi: ROLES_ABI, functionName: 'execTransactionWithRole',
    args: [eure, 0n, transfer(allowed), 0, roleKey, true],
  });
  const rcpt = await client.waitForTransactionReceipt({ hash });
  const after = await client.readContract({ address: eure, abi: ERC20, functionName: 'balanceOf', args: [allowed] });
  if (rcpt.status === 'success' && after - before === 1n) ok(`mined: ${allowed} +1 wei, gas ${rcpt.gasUsed}`);
  else bad(`mined transfer did not move exactly 1 wei (status ${rcpt.status}, Δ ${after - before})`);

  await expectRevert('router → transfer(outsider)', exec(router, { data: transfer(outsider) }));
  await expectRevert('router → transfer(main Safe itself)', exec(router, { data: transfer(safe) }));
  await expectRevert('router → transfer(allowed) with value', exec(router, { data: transfer(allowed), value: 1n }));
  await expectRevert('router → transfer(allowed) as DelegateCall', exec(router, { data: transfer(allowed), op: 1 }));
  await expectRevert('router → EURe.approve(allowed)', exec(router, {
    data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [allowed, 1n] }),
  }));
  await expectRevert('router → call to another contract', exec(router, { to: rolesAddr, data: '0x' }));
  await expectRevert('non-member → transfer(allowed)', exec('0x0000000000000000000000000000000000c0FFEE', { data: transfer(allowed) }));
  if (env.legacyRole) {
    await expectRevert('old router (EUReForwarder) → transfer(outsider)',
      exec(OLD_ROUTER, { data: transfer(outsider), key: roleKeyOf(env.legacyRole) }));
    await expectRevert('router via EUReForwarder key → transfer(outsider)',
      exec(router, { data: transfer(outsider), key: roleKeyOf(env.legacyRole) }));
  }
} catch (e) {
  bad(`simulation aborted: ${e.shortMessage ?? e.message}`);
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} FAILED — do not sign.` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
