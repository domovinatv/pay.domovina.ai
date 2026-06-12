#!/usr/bin/env node
/**
 * GP account inspektor — dohvati i analiziraj CIJELO stanje postojećeg Gnosis
 * Pay accounta, pa po potrebi poveži DOMOVINA Safe kao dodatnu sign-in adresu.
 *
 * VAŽNO: GP API nema lookup po emailu (SIWE-scoped, permissionless). Da bismo
 * vidjeli tvoj postojeći account, treba JWT TVOJE GP sesije:
 *
 *   1. Otvori https://app.gnosispay.com i prijavi se walletom kojim si koristio GP.
 *   2. DevTools (⌥⌘I) → Network → bilo koji request na api.gnosispay.com →
 *      Request Headers → kopiraj vrijednost iza "Authorization: Bearer ".
 *      (Alternativa: Application → Local Storage → potraži token/jwt polje.)
 *   3. node scripts/gp-account.mjs dump '<JWT>'
 *
 * Naredbe:
 *   dump <jwt>                 povuci sve + analiza
 *   link <jwt> <safeAddress>   dodaj DOMOVINA Safe kao sign-in adresu (POST /eoa-accounts)
 *   siwe-dump <privateKey>     ako kontroliraš wallet KLJUČEM (MetaMask export): SIWE → dump
 *
 * WAF: GP 403-a Node/undici fingerprint → svi pozivi idu kroz curl s browser
 * headerima (isto kao gp-spike.mjs).
 */
import { execFileSync } from 'node:child_process';

const GP_API = 'https://api.gnosispay.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function gp(method, path, jwt, body) {
  const argv = [
    '-s',
    '-w',
    '\n%{http_code}',
    '-X',
    method,
    `${GP_API}${path}`,
    '-H',
    'Content-Type: application/json',
    '-H',
    'Origin: http://localhost:5173',
    '-H',
    'Referer: http://localhost:5173/',
    '-H',
    `User-Agent: ${UA}`,
  ];
  if (jwt) argv.push('-H', `Authorization: Bearer ${jwt}`);
  if (body) argv.push('--data-binary', body);
  const out = execFileSync('curl', argv, { encoding: 'utf8' });
  const i = out.lastIndexOf('\n');
  const status = Number(out.slice(i + 1));
  const text = out.slice(0, i);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status, body: parsed };
}

function decodeJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
}

// Endpointi koje vrijedi povući za potpunu sliku (tolerantno na 404/403).
const DUMP_ENDPOINTS = [
  ['Profil', '/api/v1/user'],
  ['Sign-in adrese (eoa-accounts)', '/api/v1/eoa-accounts'],
  ['Uvjeti (ToS)', '/api/v1/user/terms'],
  ['Safe konfiguracija', '/api/v1/safe/config'],
  ['Safe deploy status', '/api/v1/safe/deploy'],
  ['Safe migracija', '/api/v1/safe/migration'],
  ['Kartice', '/api/v1/cards'],
  ['Balansi', '/api/v1/account-balances'],
  ['Dnevni limit', '/api/v1/accounts/daily-limit'],
  ['Cashback', '/api/v1/cashback'],
  ['IBAN dostupnost', '/api/v1/ibans/available'],
  ['IBAN detalji', '/api/v1/ibans'],
];

function dump(jwt) {
  const claims = decodeJwt(jwt);
  console.log('\n══════════ JWT CLAIMS ══════════');
  console.log(JSON.stringify(claims, null, 2));
  if (claims?.exp && claims.exp * 1000 < Date.now()) {
    console.log('\n⚠️  JWT JE ISTEKAO — zgrabi svježi iz app.gnosispay.com i pokušaj ponovno.');
  }

  const results = {};
  for (const [label, path] of DUMP_ENDPOINTS) {
    const r = gp('GET', path, jwt);
    results[path] = r;
    console.log(`\n══════════ ${label} ══════════  (${path} → ${r.status})`);
    console.log(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
  }

  analyze(claims, results);
}

function analyze(claims, r) {
  const user = r['/api/v1/user']?.body;
  const eoa = r['/api/v1/eoa-accounts']?.body?.data?.eoaAccounts;
  const cards = r['/api/v1/cards']?.body;
  const safeCfg = r['/api/v1/safe/config']?.body;
  const deploy = r['/api/v1/safe/deploy']?.body;

  console.log('\n\n████████████ ANALIZA ████████████');

  if (!user || r['/api/v1/user'].status !== 200) {
    console.log(
      '• /user nije vratio 200 → JWT vjerojatno bez userId (nije signup-an) ili istekao.\n' +
        '  Ovo NIJE tvoj postojeći account — provjeri da je JWT iz app.gnosispay.com sesije.',
    );
    return;
  }

  console.log(`• userId: ${user.id}`);
  console.log(`• email: ${user.email ?? '—'}`);
  console.log(`• status: ${user.status} · kycStatus: ${user.kycStatus}`);
  console.log(
    `• isSourceOfFundsAnswered: ${user.isSourceOfFundsAnswered} · isPhoneValidated: ${user.isPhoneValidated}`,
  );

  const wallets = Array.isArray(eoa) ? eoa.map((e) => e.address) : user.signInWallets?.map((w) => w.address);
  console.log(`\n• SIGN-IN ADRESE (kontroliraju account): ${wallets?.length ?? 0}`);
  (wallets ?? []).forEach((a) => console.log(`    - ${a}`));

  const safeWallets = user.safeWallets ?? [];
  console.log(`\n• GP SAFE-OVI (safeWallets): ${safeWallets.length}`);
  safeWallets.forEach((s) => console.log(`    - ${s.address}`));
  console.log(`• safe/config.accountStatus: ${safeCfg?.accountStatus ?? 'null'}`);
  console.log(`• safe/deploy.status: ${deploy?.status ?? '—'}`);

  console.log(`\n• KARTICE: ${Array.isArray(cards) ? cards.length : r['/api/v1/cards']?.status === 404 ? 0 : '?'}`);
  if (Array.isArray(cards)) cards.forEach((c) => console.log(`    - •••• ${c.lastFourDigits} (${c.statusName ?? c.statusCode})`));

  console.log(`\n• IBAN feature (availableFeatures.moneriumIban): ${user.availableFeatures?.moneriumIban}`);

  // Zaključak + preporuka
  console.log('\n──────── ZAKLJUČAK ────────');
  const hasSafe = safeWallets.length > 0;
  const kycDone = user.kycStatus === 'approved';
  if (!hasSafe && !kycDone) {
    console.log(
      'Account je INICIJALIZIRAN ali PRAZAN (nema GP Safe, KYC nije approved) — poklapa se s\n' +
        'tvojim sjećanjem (GP app je blokirao izradu kartice prije nego se išta postavilo).\n' +
        '→ Najčišće: poveži DOMOVINA Safe kao sign-in adresu pa nastavi onboarding iz walleta:\n' +
        `     node scripts/gp-account.mjs link '<ISTI JWT>' <TVOJ_DOMOVINA_SAFE>\n` +
        '   Nakon toga se iz DOMOVINA Walleta prijaviš passkeyem i nastavljaš KYC u istom accountu.',
    );
  } else if (kycDone) {
    console.log(
      'Account je KYC-approved' +
        (Array.isArray(cards) && cards.length ? ' i IMA karticu' : '') +
        '. NE radi novi KYC — samo poveži DOMOVINA Safe da ga vidiš u walletu:\n' +
        `     node scripts/gp-account.mjs link '<ISTI JWT>' <TVOJ_DOMOVINA_SAFE>`,
    );
  } else {
    console.log(
      'Account ima GP Safe ali KYC nije gotov — poveži DOMOVINA Safe i dovrši onboarding iz walleta.',
    );
  }
  console.log(
    '\nℹ️  link traži SAMO adresu (bez potpisa), ali zahtijeva OVAJ isti JWT (autenticiran kao\n' +
      '   tvoj postojeći account). Safe pri prijavi dokazuje vlasništvo passkey ERC-1271 potpisom.',
  );
}

function link(jwt, safeAddress) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(safeAddress ?? '')) {
    console.log('Daj valjanu Safe adresu: node scripts/gp-account.mjs link <jwt> 0x…');
    process.exit(1);
  }
  console.log(`Dodajem ${safeAddress} kao sign-in adresu postojećeg accounta…`);
  const r = gp('POST', '/api/v1/eoa-accounts', jwt, JSON.stringify({ address: safeAddress }));
  console.log(`POST /eoa-accounts → ${r.status}`);
  console.log(typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2));
  if (r.status === 201) {
    console.log('\n✅ Povezano. Sada se iz DOMOVINA Walleta (/kartica) prijavi passkeyem —');
    console.log('   slijećeš u svoj postojeći GP account. Provjera:');
    console.log(`   node scripts/gp-account.mjs dump '${jwt.slice(0, 12)}…'`);
  }
}

async function siweDump(privateKey) {
  const { privateKeyToAccount } = await import('viem/accounts');
  const { createSiweMessage } = await import('viem/siwe');
  const acct = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
  console.log('SIWE login s adresom:', acct.address);
  const nonce = String(gp('GET', '/api/v1/auth/nonce').body).trim();
  const message = createSiweMessage({
    domain: 'gnosispay-api-siwe-demo.vercel.app',
    address: acct.address,
    uri: 'https://gnosispay-api-siwe-demo.vercel.app',
    version: '1',
    chainId: 100,
    nonce,
    issuedAt: new Date(),
  });
  const signature = await acct.signMessage({ message });
  const ch = gp('POST', '/api/v1/auth/challenge', null, JSON.stringify({ message, signature, ttlInSeconds: 86400 }));
  if (ch.status !== 200 || !ch.body?.token) {
    console.log('Challenge nije uspio:', ch.status, JSON.stringify(ch.body));
    return;
  }
  console.log('JWT dobiven, dohvaćam stanje…');
  dump(ch.body.token);
}

const [cmd, a, b] = process.argv.slice(2);
switch (cmd) {
  case 'dump':
    if (!a) console.log("Daj JWT: node scripts/gp-account.mjs dump '<jwt>'");
    else dump(a);
    break;
  case 'link':
    if (!a) console.log("Daj JWT i Safe: node scripts/gp-account.mjs link '<jwt>' 0x…");
    else link(a, b);
    break;
  case 'siwe-dump':
    if (!a) console.log('Daj privatni ključ: node scripts/gp-account.mjs siwe-dump <0x…>');
    else await siweDump(a);
    break;
  default:
    console.log('Naredbe: dump <jwt> | link <jwt> <safeAddress> | siwe-dump <privateKey>');
    console.log('JWT zgrabi iz app.gnosispay.com sesije (vidi header komentar skripte).');
}
