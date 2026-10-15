#!/usr/bin/env node
// funding-init: sve što projekt treba za primanje uplata, jednom naredbom.
//
//   node funding-init.mjs --env sandbox --project domovinatv-karta-hrvatske --title "Karta Hrvatske"
//   node funding-init.mjs --env sandbox --tenant opensaas-sandbox --vars opensaas-sandbox --project opensaas-sandbox-demo
//
// Koraci (svaki je idempotentan, ponovno pokretanje samo provjeri stanje):
//   1. Safe projekta (salt "project:<id>", vlasnici i prag iz lib.mjs), rođen s
//      potpisanom Monerium porukom (--pre-sign-link put iz deploy-safe.mjs)
//   2. provjera vlasnika, praga i ERC-1271 potpisa na lancu
//   3. Monerium: POST /addresses (potpis "0x") → linked
//   4. upis u projects.<env>.json (registar projekata, javne adrese)
//   5. ispis dviju naredbi za konzolu preglednika, jer oba API-ja traže
//      web sesiju: ime adrese u Moneriumu i kampanja + whitelista na MPT railu
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_OWNERS, DEFAULT_THRESHOLD, clients, ensureSafe, isLinkSigned, loadEnv, verifySafe } from './lib.mjs';
import { MONERIUM_CHAIN, moneriumClient } from './monerium.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TENANT = { sandbox: 'italk-sandbox', prod: 'italk' };
const MONERIUM_UI = { sandbox: 'https://sandbox.monerium.dev', prod: 'https://monerium.app' };
const NAME_PREFIX = { sandbox: 'Projekt (sandbox) ', prod: 'Projekt ' };

const { values: a } = parseArgs({
  options: {
    env: { type: 'string', default: 'sandbox' },
    project: { type: 'string' },
    title: { type: 'string' },
    tenant: { type: 'string' },
    vars: { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
});

if (!a.project || !/^[A-Za-z0-9_-]{2,64}$/.test(a.project)) {
  console.error('--project <id> (slova, brojke, - i _, 2–64 znaka; isti je i campaign_id na railu)');
  process.exit(2);
}
const env = a.env;
const tenant = a.tenant ?? TENANT[env];
const title = a.title ?? a.project;
const saltLabel = `project:${a.project}`;
// --vars: Monerium vjerodajnice drugog profila (.env.<vars> ili putanja); deployer
// ključ i dalje dolazi iz .env.<env>. Jedan profil = jedan tenant, pa uz --vars ide i --tenant.
const vars = { ...loadEnv(env), ...(a.vars ? loadEnv(a.vars) : {}) };
const c = clients(env, vars.DEPLOYER_PRIVATE_KEY);
const step = (n, msg) => console.log(`[${n}] ${msg}`);

// 1–2. Safe
const safe = await ensureSafe(c, { owners: DEFAULT_OWNERS, threshold: DEFAULT_THRESHOLD, saltLabel, dryRun: a.dry, preSignLink: true });
step(1, `Safe ${safe.address} · ${safe.existed ? 'već deployan' : safe.txHash ? `deployan ${c.cfg.explorer}/tx/${safe.txHash}` : 'dry run'}`);
if (!safe.deployed) process.exit(0);
const v = await verifySafe(c.pub, safe.address, DEFAULT_OWNERS, DEFAULT_THRESHOLD);
const signed = await isLinkSigned(c.pub, safe.address);
step(2, `vlasnici ${v.threshold}/${v.owners.length} ${v.ok ? 'OK' : 'KRIVO'} · Monerium poruka potpisana: ${signed ? 'DA' : 'NE'}`);
if (!v.ok || !signed) process.exit(1);

// 3. Monerium link
const m = await moneriumClient(vars);
const chain = MONERIUM_CHAIN[env];
const linked = ((await m.addresses()).json?.addresses ?? []).find((x) => x.address.toLowerCase() === safe.address.toLowerCase());
if (linked) {
  step(3, `Monerium: već povezan (${linked.chains.join(',')})`);
} else {
  let profile = vars.MONERIUM_PROFILE_ID;
  if (!profile) {
    const p = (await m.profiles()).json?.profiles ?? [];
    if (p.length !== 1) throw new Error(`profil nije jednoznačan (${p.length}); postavi MONERIUM_PROFILE_ID u .env.${env}`);
    profile = p[0].id;
  }
  const r = await m.linkAddress(profile, safe.address, chain);
  step(3, `Monerium: POST /addresses → ${r.status} ${r.json?.state ?? JSON.stringify(r.json)}`);
  if (r.status >= 300) process.exit(1);
}

// 4. registar
const regFile = join(HERE, `projects.${env}.json`);
const reg = existsSync(regFile) ? JSON.parse(readFileSync(regFile, 'utf8')) : {};
reg[a.project] = {
  title,
  safe: safe.address,
  chain,
  chain_id: c.cfg.chain.id,
  salt: saltLabel,
  safe_version: c.cfg.safeVersion,
  owners: DEFAULT_OWNERS,
  threshold: DEFAULT_THRESHOLD,
  mpt_tenant: tenant,
  campaign_id: a.project,
  created_at: reg[a.project]?.created_at ?? new Date().toISOString(),
};
writeFileSync(regFile, JSON.stringify(Object.fromEntries(Object.entries(reg).sort()), null, 2) + '\n');
step(4, `upisano u ${regFile.split('/').slice(-1)[0]}`);

// 5. naredbe za preglednik
const name = `${NAME_PREFIX[env]}${title} · ${a.project}`;
console.log(`\n[5a] Ime u Moneriumu — konzola na ${MONERIUM_UI[env]} (prijavljen):`);
console.log(`console.log((await fetch('/api/addresses/${safe.address}/config', { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: ${JSON.stringify(name)} }) })).status)`);
console.log(`\n[5b] Kampanja + whitelista na MPT railu — konzola na https://mpt.domovina.ai/admin (prijavljen):`);
console.log(`console.log(await (await fetch('/admin/api/tenants/${tenant}/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaign_id: ${JSON.stringify(a.project)}, safe_address: '${safe.address}', label: ${JSON.stringify(title)} }) })).json())`);
