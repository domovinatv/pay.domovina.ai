import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { appServesShop, matchApp, sharedApp } from '../src/apps';

import {
  decryptSecret,
  deriveSid,
  encryptSecret,
  verifyMptWebhook,
  verifyShopifyQueryHmac,
  verifyShopifyWebhook,
} from '../src/crypto';
import { moneyToCents } from '../src/shopify';
import { classifyIntent, gatewayMatches, nextStatus } from '../src/sync';
import type { Env, MptIntent } from '../src/types';

const SECRET = 'shpss_test_secret';

describe('Shopify query HMAC', () => {
  const sign = (q: string) => createHmac('sha256', SECRET).update(q).digest('hex');

  it('accepts a correctly signed install query regardless of param order', async () => {
    const msg = 'host=YWRtaW4&shop=demo.myshopify.com&timestamp=1700000000';
    const p = new URLSearchParams(`timestamp=1700000000&shop=demo.myshopify.com&hmac=${sign(msg)}&host=YWRtaW4`);
    expect(await verifyShopifyQueryHmac(p, SECRET)).toBe(true);
  });

  it('rejects a tampered shop', async () => {
    const msg = 'shop=demo.myshopify.com&timestamp=1700000000';
    const p = new URLSearchParams(`shop=evil.myshopify.com&timestamp=1700000000&hmac=${sign(msg)}`);
    expect(await verifyShopifyQueryHmac(p, SECRET)).toBe(false);
  });

  it('rejects a missing hmac', async () => {
    expect(await verifyShopifyQueryHmac(new URLSearchParams('shop=demo.myshopify.com'), SECRET)).toBe(false);
  });
});

describe('Shopify webhook HMAC', () => {
  it('verifies base64 HMAC of the raw body', async () => {
    const body = '{"id":1,"total_price":"12.30"}';
    const h = createHmac('sha256', SECRET).update(body).digest('base64');
    expect(await verifyShopifyWebhook(body, h, SECRET)).toBe(true);
    expect(await verifyShopifyWebhook(body + ' ', h, SECRET)).toBe(false);
    expect(await verifyShopifyWebhook(body, null, SECRET)).toBe(false);
  });
});

describe('MPT (Standard Webhooks) signature', () => {
  const key = randomBytes(24);
  const secret = `whsec_${key.toString('base64')}`;
  const body = '{"type":"intent.paid","sid":"shp_x"}';
  const ts = 1_760_000_000;
  const sig = (k: Buffer, t: number) => createHmac('sha256', k).update(`int_shp_x.${t}.${body}`).digest('base64');

  it('accepts a valid signature, also among rotated ones', async () => {
    const other = sig(randomBytes(24), ts);
    for (const header of [`v1,${sig(key, ts)}`, `v1,${other} v1,${sig(key, ts)}`]) {
      expect(await verifyMptWebhook({ id: 'int_shp_x', timestamp: String(ts), signature: header, body, secret, nowUnix: ts + 5 })).toBe(true);
    }
  });

  it('rejects a stale timestamp (replay) and a wrong id', async () => {
    const header = `v1,${sig(key, ts)}`;
    expect(await verifyMptWebhook({ id: 'int_shp_x', timestamp: String(ts), signature: header, body, secret, nowUnix: ts + 301 })).toBe(false);
    expect(await verifyMptWebhook({ id: 'int_other', timestamp: String(ts), signature: header, body, secret, nowUnix: ts })).toBe(false);
  });
});

describe('deriveSid', () => {
  it('is deterministic, per shop, and fits the backend SID_RE', async () => {
    const a = await deriveSid('k', 'a.myshopify.com', 'gid://shopify/Order/1');
    expect(a).toBe(await deriveSid('k', 'a.myshopify.com', 'gid://shopify/Order/1'));
    expect(a).not.toBe(await deriveSid('k', 'b.myshopify.com', 'gid://shopify/Order/1'));
    expect(a).not.toBe(await deriveSid('k2', 'a.myshopify.com', 'gid://shopify/Order/1'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  });
});

describe('secret encryption', () => {
  it('round-trips and uses a fresh IV', async () => {
    const kek = randomBytes(32).toString('base64');
    const a = await encryptSecret(kek, 'shpat_123');
    expect(a).not.toBe(await encryptSecret(kek, 'shpat_123'));
    expect(await decryptSecret(kek, a)).toBe('shpat_123');
    await expect(decryptSecret(randomBytes(32).toString('base64'), a)).rejects.toThrow();
  });
});

describe('moneyToCents', () => {
  it('parses Shopify money strings exactly', () => {
    expect(moneyToCents('12.3')).toBe(1230);
    expect(moneyToCents('12.30')).toBe(1230);
    expect(moneyToCents('0.29')).toBe(29);
    expect(moneyToCents('100')).toBe(10000);
    expect(moneyToCents('-1.00')).toBeNull();
    expect(moneyToCents('1.234')).toBeNull();
  });
});

describe('gatewayMatches', () => {
  it('matches the manual method name case-insensitively', () => {
    expect(gatewayMatches(['Plaćanje QR kodom (MPT)'], 'mpt')).toBe(true);
    expect(gatewayMatches(['shopify_payments'], 'MPT')).toBe(false);
    expect(gatewayMatches(['MPT'], '  ')).toBe(false);
  });
});

function intent(p: Partial<MptIntent>): MptIntent {
  return {
    sid: 'shp_x', state: 'pending', amount_eur: '10.00', amount_cents: 1000, memo: '', iban: '', beneficiary_name: '',
    bic: null, epc_qr_data: '', checkout_url: '', expires_at: '2026-10-10T00:00:00Z', paid_at: null,
    forward_tx_hash: null, amount_received_cents: null, status: { stage: 'awaiting_payment' }, ...p,
  };
}

describe('classifyIntent', () => {
  it('maps the intent lifecycle to order statuses', () => {
    expect(classifyIntent(intent({}), 1000)).toBe('pending');
    expect(classifyIntent(intent({ status: { stage: 'received_processing' } }), 1000)).toBe('received');
    expect(classifyIntent(intent({ state: 'expired', status: { stage: 'expired' } }), 1000)).toBe('expired');
    expect(classifyIntent(intent({ status: { stage: 'rejected' } }), 1000)).toBe('rejected');
    expect(classifyIntent(intent({ state: 'paid', paid_at: '2026-10-09T10:00:00Z', amount_received_cents: 1000 }), 1000)).toBe('paid');
  });

  it('never calls an underpayment paid', () => {
    expect(classifyIntent(intent({ state: 'paid', paid_at: '2026-10-09T10:00:00Z', amount_received_cents: 999 }), 1000)).toBe('underpaid');
  });

  it('treats a late settlement on an expired intent as paid', () => {
    expect(classifyIntent(intent({ state: 'expired', paid_at: '2026-10-09T10:00:00Z', amount_received_cents: 1000 }), 1000)).toBe('paid');
  });

  it('money held by Monerium after expiry is received, not expired', () => {
    expect(classifyIntent(intent({ state: 'expired', status: { stage: 'received_processing' } }), 1000)).toBe('received');
  });
});

describe('nextStatus', () => {
  it('keeps terminal statuses and never regresses from received', () => {
    expect(nextStatus('paid', 'pending')).toBe('paid');
    expect(nextStatus('cancelled', 'paid')).toBe('cancelled');
    expect(nextStatus('received', 'pending')).toBe('received');
    expect(nextStatus('received', 'expired')).toBe('received');
    expect(nextStatus('expired', 'paid')).toBe('paid');
    expect(nextStatus('pending', 'received')).toBe('received');
  });
});

describe('multiple Shopify apps', () => {
  const custom = { clientId: 'a'.repeat(32), secret: 'shpss_custom', shop: 'a.myshopify.com' };
  const shared = { clientId: 'b'.repeat(32), secret: 'shpss_shared', shop: null };

  it('picks the app whose secret verifies the webhook', async () => {
    const body = '{"id":1}';
    const h = createHmac('sha256', 'shpss_shared').update(body).digest('base64');
    const check = (secret: string) => verifyShopifyWebhook(body, h, secret);
    expect((await matchApp([custom, shared], check))?.clientId).toBe(shared.clientId);
    expect(await matchApp([custom], check)).toBeNull();
  });

  it('a custom app only vouches for its own shop', () => {
    expect(appServesShop(custom, 'a.myshopify.com')).toBe(true);
    expect(appServesShop(custom, 'b.myshopify.com')).toBe(false);
    expect(appServesShop(shared, 'b.myshopify.com')).toBe(true);
  });

  it('ignores the wrangler.toml placeholder as a shared app', () => {
    const env = (key: string | undefined, secret: string | undefined) =>
      ({ SHOPIFY_API_KEY: key, SHOPIFY_API_SECRET: secret }) as unknown as Env;
    expect(sharedApp(env('REPLACE_WITH_CLIENT_ID', 's'))).toBeNull();
    expect(sharedApp(env('', 's'))).toBeNull();
    expect(sharedApp(env(shared.clientId, undefined))).toBeNull();
    expect(sharedApp(env(shared.clientId, 'shpss_shared'))?.clientId).toBe(shared.clientId);
  });
});
