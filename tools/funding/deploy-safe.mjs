#!/usr/bin/env node
// Deploy (ili samo provjera) Safea (1.3.0 Chiado, 1.5.0 Gnosis) s determinističkom adresom.
//
//   node deploy-safe.mjs --env sandbox --salt italk-sandbox:main --dry
//   node deploy-safe.mjs --env sandbox --salt italk-sandbox:main
//   node deploy-safe.mjs --env sandbox --new-deployer     # generira deployer EOA
//
// Vlasnici su zadano tri energy potpisnika, prag 2 (lib.mjs). Adresa ovisi o
// vlasnicima, pragu i saltu: ista oznaka uvijek daje istu adresu.
import { parseArgs } from 'node:util';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { formatEther } from 'viem';
import { DEFAULT_OWNERS, DEFAULT_THRESHOLD, clients, ensureSafe, loadEnv, setEnvVar, verifySafe } from './lib.mjs';

const { values: a } = parseArgs({
  options: {
    env: { type: 'string', default: 'sandbox' },
    salt: { type: 'string' },
    owners: { type: 'string' },
    threshold: { type: 'string' },
    dry: { type: 'boolean', default: false },
    'new-deployer': { type: 'boolean', default: false },
  },
});

const vars = loadEnv(a.env);

if (a['new-deployer']) {
  if (vars.DEPLOYER_PRIVATE_KEY) {
    console.log(`deployer već postoji: ${privateKeyToAccount(vars.DEPLOYER_PRIVATE_KEY).address}`);
  } else {
    const pk = generatePrivateKey();
    setEnvVar(a.env, 'DEPLOYER_PRIVATE_KEY', pk);
    console.log(`novi deployer: ${privateKeyToAccount(pk).address} (ključ u .env.${a.env})`);
  }
  process.exit(0);
}

if (!a.salt) {
  console.error('nedostaje --salt <oznaka>');
  process.exit(2);
}
const owners = a.owners ? a.owners.split(',') : DEFAULT_OWNERS;
const threshold = a.threshold ? Number(a.threshold) : DEFAULT_THRESHOLD;

const c = clients(a.env, vars.DEPLOYER_PRIVATE_KEY);
if (c.account) {
  const bal = await c.pub.getBalance({ address: c.account.address });
  console.log(`deployer ${c.account.address}, saldo ${formatEther(bal)} ${c.cfg.chain.nativeCurrency.symbol}`);
}

const r = await ensureSafe(c, { owners, threshold, saltLabel: a.salt, dryRun: a.dry });
console.log(`Safe ${r.address} (${c.cfg.chain.name}) · salt "${a.salt}" · ${threshold}/${owners.length}`);
if (r.existed) console.log('već deployan');
else if (r.txHash) console.log(`deployan: ${c.cfg.explorer}/tx/${r.txHash}`);
else console.log('dry run: nije deployan');

if (r.deployed) {
  const v = await verifySafe(c.pub, r.address, owners, threshold);
  console.log(v.ok ? 'provjera vlasnika i praga: OK' : `PROVJERA PALA: ${JSON.stringify(v)}`);
  if (!v.ok) process.exit(1);
  console.log(`${c.cfg.explorer}/address/${r.address}`);
}
