/// Browser side of ADR 0022 receipts. Bundled by scripts/build-receipt-client.mjs
/// into ../client.generated.ts and served at /potvrda/client.js.
///
/// The owner key and salt are created HERE and never leave the device except
/// in the payer's own backup file / printed part B. The server only ever sees
/// the sid (a commitment), the owner address and the salt, and a signature.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, type Hex } from 'viem';
import qrcode from 'qrcode-generator';

import { deriveReceiptSid } from '../sid';

interface StoredKey {
  v: 1;
  sid: string;
  owner: string;
  salt: Hex;
  pk: Hex;
  created_at: number;
}

interface Proof {
  anchor_id: number; seq: number; root: string; proof: string[]; prev_chain_head: string; chain_head: string;
  leaf_count: number; total_leaves: number; total_cents: number; lazy_count: number; ots_available: boolean; anchored_at: number;
}
interface Payment {
  kind: 'direct' | 'lazy';
  order_id: string;
  tx_hash: string | null;
  amount_cents: number;
  placed_at: string | null;
  leaf_hash: string;
  anchor: Proof | null;
}
interface Receipt {
  version: string;
  sid: string;
  chain_id: number;
  status: string;
  intent: { amount_cents: number; currency: string; label: string | null; target_address: string; tenant_id: string | null; created_at: number; paid_at: number | null };
  forward_tx_hash: string | null;
  payment_registry: string | null;
  payments: Payment[];
  lazy_included: boolean;
  owner?: string;
  salt?: string;
}

interface PageConfig { mode: 'new' | 'view'; sid: string }

const STORE_PREFIX = 'mpt-receipt:';
const CFG = JSON.parse(document.getElementById('receipt-config')!.textContent!) as PageConfig;
const root = document.getElementById('app')!;

// ---------- small DOM helpers (never innerHTML with data) ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string> = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) if (c) n.append(c);
  return n;
}

function qrSvg(text: string): HTMLElement {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const box = el('div', { class: 'qr' });
  box.innerHTML = qr.createSvgTag({ scalable: true, margin: 2 }); // library output, no user data as markup
  return box;
}

function eur(cents: number): string {
  return (cents / 100).toLocaleString('hr-HR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' EUR';
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('hr-HR');
}

function download(name: string, data: BlobPart, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/// RFC 8785-style canonical JSON for our shapes (strings, integers, arrays,
/// objects, null): keys sorted at every level, no whitespace.
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

// ---------- key storage ----------

function loadKey(sid: string): StoredKey | null {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + sid);
    return raw ? (JSON.parse(raw) as StoredKey) : null;
  } catch {
    return null;
  }
}

function saveKey(k: StoredKey): boolean {
  try {
    localStorage.setItem(STORE_PREFIX + k.sid, JSON.stringify(k));
    return true;
  } catch {
    return false;
  }
}

function validKeyFor(sid: string, k: Partial<StoredKey> | null): k is StoredKey {
  if (!k || typeof k.pk !== 'string' || typeof k.salt !== 'string') return false;
  try {
    const owner = privateKeyToAccount(k.pk as Hex).address;
    return deriveReceiptSid(owner, k.salt as Hex) === sid;
  } catch {
    return false;
  }
}

// ---------- optional password encryption of part B (PBKDF2 + AES-GCM) ----------

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const PBKDF2_ITER = 310_000;

async function aesKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function encryptKey(k: StoredKey, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, await aesKey(password, salt), new TextEncoder().encode(JSON.stringify(k)),
  ));
  return JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', iter: PBKDF2_ITER, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

async function decryptKey(blob: string, password: string): Promise<StoredKey> {
  const e = JSON.parse(blob) as { salt: string; iv: string; ct: string };
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(e.iv) }, await aesKey(password, unb64(e.salt)), unb64(e.ct),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as StoredKey;
}

// ---------- mode "new": re-issue the intent under a key-bound sid ----------

function renderNew(): void {
  const btn = el('button', { class: 'primary', type: 'button' }, 'Napravi nalog s potvrdom');
  const msg = el('p', { class: 'msg' });
  root.replaceChildren(
    el('h1', {}, 'Potvrda o uplati'),
    el('p', {}, 'Ovaj preglednik napravit će tajni ključ i iz njega novu referencu plaćanja. ' +
      'Kad uplata stigne, ključem dokazujete da ste baš vi platili, i to bez računa i bez prijave.'),
    el('ul', {},
      el('li', {}, 'Ključ ostaje samo na ovom uređaju i u rezervnoj kopiji koju preuzmete.'),
      el('li', {}, 'Tko ima ključ, ima i pravo iz potvrde. Ne dijelite ga.'),
      el('li', {}, 'Ranije uplate s istog IBAN-a, koje nisu imale potvrdu, pokrit će ova potvrda naknadno.')),
    btn, msg,
  );
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', '');
    msg.textContent = 'Stvaram ključ…';
    const pk = generatePrivateKey();
    const owner = privateKeyToAccount(pk).address;
    const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    const sid = deriveReceiptSid(owner, salt);
    const key: StoredKey = { v: 1, sid, owner, salt, pk, created_at: Math.floor(Date.now() / 1000) };
    // Saved BEFORE the intent exists: a payment must never outlive its key.
    if (!saveKey(key)) {
      msg.textContent = 'Preglednik ne dopušta spremanje (privatni način?). Preuzmite ključ prije plaćanja.';
    }
    const res = await fetch(`/api/intents/${encodeURIComponent(CFG.sid)}/receipt-intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid }),
    });
    if (res.status !== 201) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      msg.textContent = `Nalog nije napravljen (${err.error ?? res.status}).`;
      btn.removeAttribute('disabled');
      return;
    }
    const backup = el('button', { type: 'button' }, 'Preuzmi rezervnu kopiju ključa');
    backup.addEventListener('click', () => download(`mpt-kljuc-${sid}.json`, JSON.stringify(key, null, 2)));
    root.replaceChildren(
      el('h1', {}, 'Ključ je spreman'),
      el('p', {}, 'Nova referenca: ', el('code', {}, sid)),
      el('p', {}, 'Preporuka: preuzmite rezervnu kopiju prije plaćanja. Bez ključa potvrdu nije moguće preuzeti.'),
      backup,
      el('p', {}, el('a', { class: 'primary-link', href: `/checkout/${sid}` }, 'Nastavi na plaćanje →')),
    );
  });
}

// ---------- mode "view": fetch, verify and print the receipt ----------

async function fetchReceipt(sid: string, key: StoredKey | null): Promise<Receipt> {
  if (!key) {
    const r = await fetch(`/api/intents/${sid}/receipt`);
    if (!r.ok) throw new Error(`receipt ${r.status}`);
    return r.json();
  }
  const account = privateKeyToAccount(key.pk);
  const ts = Math.floor(Date.now() / 1000);
  const signature = await account.signMessage({ message: `MPT potvrda o uplati\nsid: ${sid}\nvrijeme: ${ts}` });
  const r = await fetch(`/api/intents/${sid}/receipt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner: account.address, salt: key.salt, ts, signature }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({})) as { error?: string };
    throw new Error(e.error ?? `receipt ${r.status}`);
  }
  return r.json();
}

const STATUS_TEXT: Record<string, string> = {
  awaiting_payment: 'Uplata još nije stigla. Potvrda nastaje kad uplata stigne do primatelja.',
  settling: 'Uplata je stigla i upravo se prosljeđuje. Osvježite za minutu.',
  unbound_stray: 'Uplata je stigla bez reference u opisu naloga, pa nije izravno vezana uz ključ. ' +
    'Pokrit će je sljedeća uplata s potvrdom s istog IBAN-a.',
};

function renderImport(sid: string, onKey: (k: StoredKey) => void): HTMLElement {
  const file = el('input', { type: 'file', accept: '.json,application/json' });
  const pw = el('input', { type: 'password', placeholder: 'Lozinka (ako je ključ zaključan)' });
  const msg = el('p', { class: 'msg' });
  file.addEventListener('change', async () => {
    try {
      const text = await file.files![0].text();
      let k = JSON.parse(text) as Partial<StoredKey> & { encrypted_key?: string; ct?: string };
      if (k.encrypted_key || k.ct) k = await decryptKey(k.encrypted_key ?? text, (pw as HTMLInputElement).value);
      if (!validKeyFor(sid, k)) throw new Error('ključ ne pripada ovoj potvrdi');
      saveKey(k);
      onKey(k);
    } catch (e) {
      msg.textContent = `Ključ nije učitan: ${(e as Error).message}`;
    }
  });
  return el('div', { class: 'card no-print' },
    el('h2', {}, 'Ključ nije u ovom pregledniku'),
    el('p', {}, 'Učitajte rezervnu kopiju ključa da biste vidjeli i naknadno pokrivene uplate i ispisali puni dokaz.'),
    pw, file, msg);
}

function renderReceipt(rc: Receipt, key: StoredKey | null): void {
  const total = rc.payments.reduce((s, p) => s + p.amount_cents, 0);
  const publicPart = {
    version: rc.version, sid: rc.sid, chain_id: rc.chain_id,
    owner: rc.owner ?? key?.owner ?? null, salt: rc.salt ?? key?.salt ?? null,
    intent: rc.intent, payment_registry: rc.payment_registry,
    payments: rc.payments,
  };
  const json = canonical(publicPart);

  const rows = rc.payments.map((p) => el('tr', {},
    el('td', {}, fmtDate(p.placed_at)),
    el('td', { class: 'num' }, eur(p.amount_cents)),
    el('td', {}, p.kind === 'direct' ? 'Izravna (ključ u referenci)' : 'Naknadna (isti IBAN uplatitelja)'),
    el('td', {}, p.tx_hash
      ? el('a', { href: `https://gnosisscan.io/tx/${p.tx_hash}`, target: '_blank', rel: 'noopener' }, p.tx_hash.slice(0, 12) + '…')
      : '—'),
    el('td', {}, p.anchor ? `#${p.anchor.anchor_id}` : 'čeka sidrenje'),
  ));

  const anchors = [...new Map(rc.payments.filter((p) => p.anchor).map((p) => [p.anchor!.anchor_id, p.anchor!])).values()];
  const otsLinks = anchors.filter((a) => a.ots_available).map((a) =>
    el('li', {}, el('a', { href: `/api/receipts/anchors/${a.seq}.ots` }, `Sidro #${a.seq} (.ots)`),
      ' chain_head ', el('code', {}, a.chain_head)));

  const actions = el('div', { class: 'actions no-print' });
  const printBtn = el('button', { class: 'primary', type: 'button' }, 'Spremi kao PDF');
  printBtn.addEventListener('click', () => window.print());
  const jsonBtn = el('button', { type: 'button' }, 'Preuzmi potvrdu (JSON)');
  jsonBtn.addEventListener('click', () => download(`mpt-potvrda-${rc.sid}.json`, json));
  actions.append(printBtn, jsonBtn);

  const doc = el('article', { class: 'receipt' },
    el('header', {}, el('h1', {}, 'Potvrda o uplati'), el('p', { class: 'muted' }, `MPT · ${rc.version}`)),
    el('dl', {},
      el('dt', {}, 'Referenca (sid)'), el('dd', {}, el('code', {}, rc.sid)),
      el('dt', {}, 'Namjena'), el('dd', {}, rc.intent.label ?? '—'),
      el('dt', {}, 'Primatelj (Gnosis)'), el('dd', {}, el('code', {}, rc.intent.target_address)),
      el('dt', {}, 'Ukupno potvrđeno'), el('dd', {}, el('strong', {}, eur(total))),
      el('dt', {}, 'Vlasnik potvrde'), el('dd', {}, el('code', {}, publicPart.owner ?? '— (učitajte ključ)')),
    ),
    rc.payments.length === 0
      ? el('p', { class: 'warn' }, STATUS_TEXT[rc.status] ?? `Stanje: ${rc.status}`)
      : el('table', {},
          el('thead', {}, el('tr', {}, ...['Datum', 'Iznos', 'Vrsta', 'Gnosis tx', 'Sidro'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...rows)),
    !rc.lazy_included ? el('p', { class: 'muted' }, 'Naknadno pokrivene uplate vidi samo vlasnik ključa.') : null,
    el('section', {},
      el('h2', {}, 'Kako provjeriti bez MPT-a'),
      el('ol', {},
        el('li', {}, 'keccak256("MPT-RECEIPT-v1" ‖ vlasnik ‖ salt), prvih 120 bitova u base32 (abeceda abcdefghijkmnpqrstuvwxyz23456789) s prefiksom "r1", mora dati referencu.'),
        el('li', {}, 'Za izravnu uplatu: Gnosis transakcija prenosi iznos primatelju; s uključenim PaymentRegistryjem nosi i Payment event s ovom referencom i kind = rcpt1.'),
        el('li', {}, 'Svaki redak je list Merkle stabla; dokaz i korijen su u JSON-u ispod. Sidro veže korijen uz sva prethodna sidra (chain_head), a sha256(chain_head) je vremenski žigosan na Bitcoinu (OpenTimestamps).'),
        el('li', {}, 'Sve to provjerava skripta scripts/mpt_receipt_verify.py iz repozitorija pay.domovina.ai, bez MPT-a; javna kopija sidara je u repozitoriju mpt-receipts-checkpoints.'),
        el('li', {}, 'Vlasnik dokazuje da je on uplatitelj potpisom nasumične poruke ključem iz dijela B.')),
      otsLinks.length ? el('ul', {}, ...otsLinks) : null,
      el('p', {}, el('code', {}, `salt: ${publicPart.salt ?? '—'}`))),
    el('section', { class: 'qr-row' },
      qrSvg(canonical({ v: 1, sid: rc.sid, owner: publicPart.owner, salt: publicPart.salt })),
      el('p', { class: 'muted' }, 'QR: referenca, vlasnik i salt.')),
    el('section', {}, el('h2', {}, 'Potvrda (kanonski JSON)'), el('pre', { class: 'json' }, json)),
  );

  const partB = key ? renderPartB(key) : null;
  root.replaceChildren(actions, doc, ...(partB ? [partB] : []), ...(key ? [] : [renderImport(rc.sid, (k) => void load(k))]));
}

function renderPartB(key: StoredKey): HTMLElement {
  const pw = el('input', { type: 'password', placeholder: 'Lozinka za zaključavanje (preporuka)' });
  const body = el('div', {});
  const show = (secret: string, locked: boolean) => body.replaceChildren(
    qrSvg(secret),
    el('pre', { class: 'json' }, secret),
    el('p', { class: 'muted' }, locked ? 'Ključ je zaključan lozinkom (PBKDF2-SHA256 + AES-GCM).' : 'Ključ NIJE zaključan.'),
  );
  show(JSON.stringify(key), false);
  const lock = el('button', { type: 'button' }, 'Zaključaj lozinkom');
  lock.addEventListener('click', async () => {
    const p = (pw as HTMLInputElement).value;
    if (p.length < 8) { alertBox(body, 'Lozinka mora imati barem 8 znakova.'); return; }
    show(JSON.stringify({ encrypted_key: await encryptKey(key, p) }), true);
  });
  const keyBtn = el('button', { type: 'button' }, 'Preuzmi ključ (JSON)');
  keyBtn.addEventListener('click', () => download(`mpt-kljuc-${key.sid}.json`, JSON.stringify(key, null, 2)));
  return el('article', { class: 'receipt part-b' },
    el('h1', {}, 'Dio B: ključ za preuzimanje prava'),
    el('p', { class: 'warn' }, 'Tko ima ovu stranicu, može preuzeti vaše pravo iz potvrde. Ne šaljite je nikome.'),
    el('div', { class: 'no-print' }, pw, lock, keyBtn),
    body);
}

function alertBox(parent: HTMLElement, text: string): void {
  parent.prepend(el('p', { class: 'warn' }, text));
}

async function load(key: StoredKey | null): Promise<void> {
  root.replaceChildren(el('p', {}, 'Učitavam potvrdu…'));
  try {
    renderReceipt(await fetchReceipt(CFG.sid, key), key);
  } catch (e) {
    root.replaceChildren(el('p', { class: 'warn' }, `Potvrda nije dohvaćena: ${(e as Error).message}`));
  }
}

if (CFG.mode === 'new') {
  renderNew();
} else {
  const k = loadKey(CFG.sid);
  void load(validKeyFor(CFG.sid, k) ? k : null);
}
