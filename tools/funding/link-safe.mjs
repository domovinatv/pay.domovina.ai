#!/usr/bin/env node
// Poveže Safe s Monerium profilom (POST /addresses, ERC-1271 s potpisom "0x").
// Safe mora imati potpisanu Monerium poruku: deploy-safe.mjs --pre-sign-link,
// ili SignMessageLib transakciju vlasnika.
//
//   node link-safe.mjs --env sandbox --safe 0x…
//   node link-safe.mjs --env sandbox --safe 0x… --name "Projekt kviz-app"
//   node link-safe.mjs --env sandbox --list
//
// Ime adrese: javni Monerium API ga ne podržava (v2 nema polje, a
// PATCH /addresses/:a/config postoji samo u web sučelju pod sesijom kolačića;
// token Private appa dobiva 401, provjereno 11. 10. 2026.). Zato --name ispiše
// naredbu za konzolu preglednika na monerium.app / sandbox.monerium.dev.
import { parseArgs } from 'node:util';
import { clients, isLinkSigned, loadEnv } from './lib.mjs';
import { MONERIUM_CHAIN, moneriumClient } from './monerium.mjs';

const { values: a } = parseArgs({
  options: {
    env: { type: 'string', default: 'sandbox' },
    safe: { type: 'string' },
    profile: { type: 'string' },
    list: { type: 'boolean', default: false },
    name: { type: 'string' },
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
} else {
  const r = await m.linkAddress(profile, a.safe, chain);
  console.log(`POST /addresses → ${r.status} ${JSON.stringify(r.json)}`);
  if (r.status >= 300) process.exit(1);
}

if (a.name) {
  const ui = a.env === 'sandbox' ? 'https://sandbox.monerium.dev' : 'https://monerium.app';
  console.log(`\nIme adrese (zalijepi u konzolu preglednika na ${ui}, prijavljen):`);
  console.log(nameSnippet([{ address: a.safe, name: a.name }]));
}

/// Naredba za konzolu web sučelja Moneriuma: isti poziv koji radi "Save changes"
/// u Wallets (PATCH /api/addresses/:a/config {name}), s kolačićem sesije.
export function nameSnippet(items) {
  return `for (const [a, name] of ${JSON.stringify(items.map((i) => [i.address, i.name]))}) console.log(a, (await fetch(\`/api/addresses/\${a}/config\`, { method: 'PATCH', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })).status);`;
}
