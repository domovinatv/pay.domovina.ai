#!/usr/bin/env node
// EURe saldo Safeova iz registra projekata (+ glavni Safe) i zadnji Monerium orderi.
//   node check-balances.mjs --env sandbox [--orders 5] [--wait <adresa>]
import { parseArgs } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { formatUnits } from 'viem';
import { clients, loadEnv } from './lib.mjs';
import { moneriumClient } from './monerium.mjs';

const { values: a } = parseArgs({ options: { env: { type: 'string', default: 'sandbox' }, orders: { type: 'string', default: '5' }, wait: { type: 'string' }, main: { type: 'string' } } });
const EURE = { sandbox: '0x7a47605930002cc2cd2c3c408d1f33fc2a18ab71', prod: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430' }[a.env];
const abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const { pub } = clients(a.env);
const regFile = new URL(`./projects.${a.env}.json`, import.meta.url);
const reg = existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : {};
const rows = Object.entries(reg).map(([id, p]) => [id, p.safe]);
if (a.main) rows.unshift(['(glavni Safe)', a.main]);
const bal = async (addr) => formatUnits(await pub.readContract({ address: EURE, abi, functionName: 'balanceOf', args: [addr] }), 18);

if (a.wait) {
  const start = await bal(a.wait);
  for (let i = 0; i < 15; i++) {
    await new Promise((s) => setTimeout(s, 6000));
    const now = await bal(a.wait);
    if (now !== start) { console.log(`${a.wait}: ${start} → ${now} EURe`); break; }
    if (i === 14) console.log(`${a.wait}: bez promjene nakon 90 s (${start})`);
  }
}
for (const [id, addr] of rows) console.log(`${(await bal(addr)).padStart(10)} EURe  ${id}  ${addr}`);

const m = await moneriumClient(loadEnv(a.env));
const o = (await m.call('GET', '/orders')).json;
for (const x of (o.orders ?? o).slice(0, Number(a.orders))) {
  console.log(`order ${x.kind} ${x.state} ${x.amount} → ${x.address} · memo "${x.memo}"`);
}
