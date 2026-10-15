#!/usr/bin/env node
// Simulira SEPA uplatu na Monerium sandbox IBAN, bez preglednika.
//
//   node simulate-payment.mjs --env opensaas-sandbox --amount 12.34 --memo "MPT-abc123"
//   node simulate-payment.mjs --env opensaas-sandbox --amount 5 --to 0xSafe…   (memo "chiado:0xSafe…")
//   node simulate-payment.mjs --env opensaas-sandbox --amount 5 --dry-run
//
// Isti poziv koji radi "Simulate bank transfer" u sandbox.monerium.dev
// (POST /api/treasury/fund). To je endpoint web sučelja, ne javnog API-ja:
// api.monerium.dev ga nema (404), ali sandbox.monerium.dev/api ga prima i s
// Bearer tokenom Private appa, ne samo s kolačićem (provjereno 12. 10. 2026.).
// Sučelje šalje nasumičnu šalu kao memo; ovdje ga zadaješ sam.
//
// Usmjeravanje: mint ide na adresu na koju je IBAN vezan, osim ako memo nosi
// "chain:address" (tekst sa stranice Receive: "Move the IBAN OR add
// 'chain:address' in the memo"). Memo intenta s raila ("chiado:0x… sid:…")
// već ima taj oblik: s IBAN-om na glavnom Safeu mint je otišao na Safe
// projekta i intent je postao paid (12. 10. 2026.). --to složi samo rutu.
import { parseArgs } from 'node:util';
import { loadEnv } from './lib.mjs';
import { MONERIUM_CHAIN, moneriumClient } from './monerium.mjs';

const { values: a } = parseArgs({
  options: {
    env: { type: 'string', default: 'sandbox' },
    amount: { type: 'string' },
    memo: { type: 'string' },
    to: { type: 'string' },
    iban: { type: 'string' },
    'from-name': { type: 'string', default: 'Ivan Horvat' },
    'from-iban': { type: 'string', default: 'HR1210010051863000160' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!a.amount || !(Number(a.amount) > 0)) {
  console.error('nedostaje --amount (npr. 12.34)');
  process.exit(2);
}

const vars = loadEnv(a.env);
if (vars.MONERIUM_BASE_URL !== 'https://api.monerium.dev') {
  console.error(`--env ${a.env} nije sandbox (MONERIUM_BASE_URL=${vars.MONERIUM_BASE_URL ?? '–'}); simulacija postoji samo na sandboxu.`);
  process.exit(2);
}
const m = await moneriumClient(vars);

let iban = a.iban?.replace(/\s+/g, '');
if (!iban) {
  const list = (await m.ibans()).json?.ibans ?? [];
  if (list.length !== 1) throw new Error(`IBAN nije jednoznačan (${list.length}); zadaj --iban`);
  iban = list[0].iban.replace(/\s+/g, '');
  console.log(`IBAN ${list[0].iban} → ${list[0].address} (${list[0].chain})`);
}

const route = a.to ? `${MONERIUM_CHAIN.sandbox}:${a.to}` : null;
const memo = [route, a.memo].filter(Boolean).join(' ') || undefined;

const body = {
  currency: 'EUR',
  amount: a.amount,
  iban,
  ...(memo ? { memo } : {}),
  counterpart: { identifier: { standard: 'iban', iban: a['from-iban'] }, details: { name: a['from-name'] } },
};
console.log('POST https://sandbox.monerium.dev/api/treasury/fund', JSON.stringify(body));
if (a['dry-run']) process.exit(0);

const r = await fetch('https://sandbox.monerium.dev/api/treasury/fund', {
  method: 'POST',
  headers: { Authorization: `Bearer ${m.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const text = await r.text();
console.log(`→ ${r.status} ${text.slice(0, 500)}`);
if (r.status >= 300) process.exit(1);

// Order se pojavi s malim zakašnjenjem; pokaži najnoviji.
await new Promise((res) => setTimeout(res, 3000));
const o = (await m.call('GET', '/orders')).json?.orders ?? [];
const last = o.sort((x, y) => (y.meta?.placedAt ?? '').localeCompare(x.meta?.placedAt ?? ''))[0];
if (last) console.log(`zadnji order: ${last.id} · ${last.kind} · ${last.amount} ${last.currency} · ${last.address} · memo "${last.memo ?? ''}" · ${last.state ?? last.meta?.state}`);
