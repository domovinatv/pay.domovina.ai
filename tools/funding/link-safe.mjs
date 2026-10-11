#!/usr/bin/env node
// Poveže Safe s Monerium profilom (POST /addresses, ERC-1271 s potpisom "0x").
// Safe mora imati potpisanu Monerium poruku: deploy-safe.mjs --pre-sign-link,
// ili SignMessageLib transakciju vlasnika.
//
//   node link-safe.mjs --env sandbox --safe 0x…
//   node link-safe.mjs --env sandbox --list
import { parseArgs } from 'node:util';
import { clients, isLinkSigned, loadEnv } from './lib.mjs';
import { MONERIUM_CHAIN, moneriumClient } from './monerium.mjs';

const { values: a } = parseArgs({
  options: {
    env: { type: 'string', default: 'sandbox' },
    safe: { type: 'string' },
    profile: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
});

const vars = loadEnv(a.env);
const m = await moneriumClient(vars);

if (a.list) {
  console.log(JSON.stringify((await m.addresses()).json, null, 1));
  process.exit(0);
}
if (!a.safe) {
  console.error('nedostaje --safe 0x…');
  process.exit(2);
}

const chain = MONERIUM_CHAIN[a.env];
const { pub } = clients(a.env);
if (!(await isLinkSigned(pub, a.safe))) {
  console.error(`Safe ${a.safe} nema potpisanu Monerium poruku (ERC-1271 s "0x" ne prolazi). Prekid.`);
  process.exit(1);
}

let profile = a.profile ?? vars.MONERIUM_PROFILE_ID;
if (!profile) {
  const p = (await m.profiles()).json?.profiles ?? [];
  if (p.length !== 1) throw new Error(`profil nije jednoznačan (${p.length}); zadaj --profile`);
  profile = p[0].id;
}

const already = ((await m.addresses()).json?.addresses ?? []).find((x) => x.address.toLowerCase() === a.safe.toLowerCase());
if (already) {
  console.log(`već povezan: ${already.address} · ${already.chains.join(',')}`);
  process.exit(0);
}

const r = await m.linkAddress(profile, a.safe, chain);
console.log(`POST /addresses → ${r.status} ${JSON.stringify(r.json)}`);
if (r.status >= 300) process.exit(1);
