// Minimalni Monerium v2 klijent za funding-init (client credentials, Private app).
// Token se nikad ne ispisuje.
import { MONERIUM_LINK_MESSAGE } from './lib.mjs';

const ACCEPT = 'application/vnd.monerium.api-v2+json';

export async function moneriumClient(vars) {
  const base = vars.MONERIUM_BASE_URL;
  if (!base || !vars.MONERIUM_CLIENT_ID || !vars.MONERIUM_CLIENT_SECRET) throw new Error('nedostaju MONERIUM_* u .env');
  const res = await fetch(`${base}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: vars.MONERIUM_CLIENT_ID, client_secret: vars.MONERIUM_CLIENT_SECRET }),
  });
  const tok = await res.json();
  if (!tok.access_token) throw new Error(`Monerium token: ${res.status} ${JSON.stringify(tok).slice(0, 200)}`);
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok.access_token}`, Accept: ACCEPT, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: r.status, json };
  };
  return {
    call,
    /// Za pozive izvan javnog API-ja (sandbox.monerium.dev/api/treasury/fund). Ne ispisivati.
    accessToken: tok.access_token,
    profiles: () => call('GET', '/profiles'),
    addresses: () => call('GET', '/addresses'),
    ibans: () => call('GET', '/ibans'),
    /// Safe koji je poruku već potpisao on-chain (SignMessageLib) šalje signature "0x".
    linkAddress: (profile, address, chain, signature = '0x') =>
      call('POST', '/addresses', { profile, address, chain, message: MONERIUM_LINK_MESSAGE, signature }),
    moveIban: (iban, address, chain) => call('PATCH', `/ibans/${iban.replace(/\s+/g, '')}`, { address, chain }),
  };
}

export const MONERIUM_CHAIN = { sandbox: 'chiado', prod: 'gnosis' };
