import { describe, expect, it } from 'vitest';

import {
  dedupKey,
  handleMoneriumWebhook,
  type WebhookDeps,
  type WebhookRecord,
} from '../src/monerium/webhookHandler';
import type { TenantRail } from '../src/tenants/rail';
import type { MoneriumOrder } from '../src/monerium/types';

const SECRET_ITALK = 'whsec_' + btoa('italk-webhook-secret-32-bytes-ok');
const SECRET_A = 'whsec_' + btoa('zupa-a-webhook-secret-32-bytes!!');
const SECRET_B = 'whsec_' + btoa('zupa-b-webhook-secret-32-bytes!!');

function rail(over: Partial<TenantRail> = {}): TenantRail {
  return {
    tenantId: 'zupa-a',
    legacy: false,
    monerium: {
      baseUrl: 'https://api.monerium.app',
      clientId: 'c',
      clientSecret: 's',
      profileId: 'prof-a',
      tokenCacheKey: 'monerium:access_token:zupa-a',
    },
    webhookSecret: SECRET_A,
    receivingSafe: '0x1111111111111111111111111111111111111111',
    signer: {
      chain: 'gnosis',
      rpcUrl: 'x',
      eureContract: '0xeure',
      safe: '0x1111111111111111111111111111111111111111',
      rolesModifier: '0xroles',
      roleKey: '0xkey',
      privateKey: '0xpk',
      paymentRegistry: '',
      multiSend: '',
    },
    maxForwardCents: null,
    ...over,
  };
}

const italk = rail({
  tenantId: 'italk',
  legacy: true,
  webhookSecret: SECRET_ITALK,
  monerium: { ...rail().monerium, profileId: null, tokenCacheKey: 'monerium:access_token' },
});

async function sign(secret: string, id: string, ts: string, body: string): Promise<string> {
  const raw = atob(secret.slice('whsec_'.length));
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(raw, (ch) => ch.charCodeAt(0)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  return `v1,${btoa(String.fromCharCode(...sig))}`;
}

async function delivery(secret: string, payload: unknown, id = 'msg_1'): Promise<{ body: string; headers: Headers }> {
  const body = JSON.stringify(payload);
  const ts = '1700000000';
  const headers = new Headers({
    'webhook-id': id,
    'webhook-timestamp': ts,
    'webhook-signature': await sign(secret, id, ts, body),
    'content-type': 'application/json',
  });
  return { body, headers };
}

function processedOrder(over: Partial<MoneriumOrder> = {}): MoneriumOrder {
  return {
    id: 'ord-1',
    profile: 'prof-a',
    kind: 'issue',
    state: 'processed',
    amount: '10.00',
    currency: 'eur',
    address: '0x1111111111111111111111111111111111111111',
    memo: 'mpt:0x2222222222222222222222222222222222222222?sid=abc123def456',
    ...over,
  } as MoneriumOrder;
}

interface Rec {
  records: WebhookRecord[];
  claims: string[];
  upserts: string[];
  lifecycle: number;
  forwards: number;
  alerts: string[];
}

function harness(): { deps: WebhookDeps; rec: Rec; settle(): Promise<void> } {
  const rec: Rec = { records: [], claims: [], upserts: [], lifecycle: 0, forwards: 0, alerts: [] };
  const pending: Promise<unknown>[] = [];
  const claimed = new Set<string>();
  const deps: WebhookDeps = {
    recordEvent: async (r) => { rec.records.push(r); },
    alreadyProcessed: async (key) => {
      rec.claims.push(key);
      if (claimed.has(key)) return true;
      claimed.add(key);
      return false;
    },
    releaseProcessed: async (key) => { claimed.delete(key); },
    upsertOrder: async (o) => { rec.upserts.push(o.id); return true; },
    notifyLifecycle: async () => { rec.lifecycle++; },
    forward: async () => { rec.forwards++; },
    alert: async (t) => { rec.alerts.push(t); },
    waitUntil: (p) => { pending.push(p); },
  };
  return { deps, rec, settle: async () => { await Promise.all(pending); } };
}

describe('per-tenant webhook — attribution', () => {
  it("rejects a delivery signed with ANOTHER tenant's secret: 401, nothing upserted", async () => {
    const { deps, rec } = harness();
    const d = await delivery(SECRET_B, { type: 'order.updated', data: processedOrder() });
    const res = await handleMoneriumWebhook(deps, rail(), d.body, d.headers);
    expect(res.status).toBe(401);
    expect(rec.upserts).toHaveLength(0);
    expect(rec.forwards).toBe(0);
    expect(rec.records[0]).toMatchObject({ signatureOk: false, tenantId: 'zupa-a' });
  });

  it("rejects ITalk's secret on a tenant URL", async () => {
    const { deps, rec } = harness();
    const d = await delivery(SECRET_ITALK, { type: 'order.updated', data: processedOrder() });
    expect((await handleMoneriumWebhook(deps, rail(), d.body, d.headers)).status).toBe(401);
    expect(rec.upserts).toHaveLength(0);
  });

  it('rejects everything while the tenant has no webhook secret yet', async () => {
    const { deps, rec } = harness();
    const d = await delivery(SECRET_A, { type: 'order.updated', data: processedOrder() });
    expect((await handleMoneriumWebhook(deps, rail({ webhookSecret: '' }), d.body, d.headers)).status).toBe(401);
    expect(rec.upserts).toHaveLength(0);
  });

  it('ignores a validly signed order from a different Monerium profile', async () => {
    const { deps, rec, settle } = harness();
    const d = await delivery(SECRET_A, { type: 'order.updated', data: processedOrder({ profile: 'prof-b' }) });
    const res = await handleMoneriumWebhook(deps, rail(), d.body, d.headers);
    await settle();
    expect(res).toEqual({ status: 200, body: { ok: true, ignored: 'profile_mismatch' } });
    expect(rec.upserts).toHaveLength(0);
    expect(rec.lifecycle).toBe(0);
    expect(rec.forwards).toBe(0);
    expect(rec.alerts).toHaveLength(1);
    expect(rec.records[0].processingNote).toBe('profile_mismatch');
  });

  it('treats an order without a profile as a mismatch (fail-closed)', async () => {
    const { deps, rec } = harness();
    const d = await delivery(SECRET_A, { type: 'order.updated', data: processedOrder({ profile: undefined }) });
    expect((await handleMoneriumWebhook(deps, rail(), d.body, d.headers)).body).toMatchObject({ ignored: 'profile_mismatch' });
    expect(rec.upserts).toHaveLength(0);
  });

  it('records and upserts a matching order, but does not forward before step 2', async () => {
    const { deps, rec, settle } = harness();
    const d = await delivery(SECRET_A, { type: 'order.updated', data: processedOrder() });
    const res = await handleMoneriumWebhook(deps, rail(), d.body, d.headers);
    await settle();
    expect(res.status).toBe(200);
    expect(rec.upserts).toEqual(['ord-1']);
    expect(rec.lifecycle).toBe(1);
    expect(rec.forwards).toBe(0);
    expect(rec.records[0]).toMatchObject({ signatureOk: true, tenantId: 'zupa-a', processingNote: null });
  });

  it('namespaces the idempotency key per tenant; ITalk keeps the bare id', async () => {
    expect(dedupKey(rail(), 'msg_1')).toBe('zupa-a:msg_1');
    expect(dedupKey(italk, 'msg_1')).toBe('msg_1');
    const { deps, rec } = harness();
    const d = await delivery(SECRET_A, { type: 'order.updated', data: processedOrder() });
    await handleMoneriumWebhook(deps, rail(), d.body, d.headers);
    const again = await handleMoneriumWebhook(deps, rail(), d.body, d.headers);
    expect(rec.claims).toEqual(['zupa-a:msg_1', 'zupa-a:msg_1']);
    expect(again.body).toMatchObject({ dedup: true });
    expect(rec.upserts).toHaveLength(1);
  });
});

describe('legacy (ITalk) webhook — behaviour unchanged', () => {
  it('forwards a processed issue order on order.updated', async () => {
    const { deps, rec, settle } = harness();
    const d = await delivery(SECRET_ITALK, { type: 'order.updated', data: processedOrder({ profile: 'anything' }) });
    const res = await handleMoneriumWebhook(deps, italk, d.body, d.headers);
    await settle();
    expect(res).toEqual({ status: 200, body: { ok: true } });
    expect(rec.claims).toEqual(['msg_1']);
    expect(rec.upserts).toEqual(['ord-1']);
    expect(rec.forwards).toBe(1);
  });

  it('never forwards on order.created', async () => {
    const { deps, rec, settle } = harness();
    const d = await delivery(SECRET_ITALK, { type: 'order.created', data: processedOrder({ state: 'placed' }) });
    await handleMoneriumWebhook(deps, italk, d.body, d.headers);
    await settle();
    expect(rec.forwards).toBe(0);
    expect(rec.lifecycle).toBe(1);
  });

  it('does not forward when no router key is configured', async () => {
    const { deps, rec, settle } = harness();
    const d = await delivery(SECRET_ITALK, { type: 'order.updated', data: processedOrder() });
    await handleMoneriumWebhook(deps, { ...italk, signer: { ...italk.signer, privateKey: '' } }, d.body, d.headers);
    await settle();
    expect(rec.forwards).toBe(0);
  });

  it('acks subscription.created without touching orders', async () => {
    const { deps, rec } = harness();
    const d = await delivery(SECRET_ITALK, { type: 'subscription.created' });
    expect((await handleMoneriumWebhook(deps, italk, d.body, d.headers)).body).toEqual({ ok: true });
    expect(rec.records[0].processingNote).toBe('subscription_ack');
    expect(rec.upserts).toHaveLength(0);
  });

  it('releases the idempotency claim when processing throws, so the retry is processed', async () => {
    const { deps, rec } = harness();
    let first = true;
    deps.upsertOrder = async (o) => {
      if (first) { first = false; throw new Error('d1 down'); }
      rec.upserts.push(o.id);
      return true;
    };
    const d = await delivery(SECRET_ITALK, { type: 'order.updated', data: processedOrder() });
    expect((await handleMoneriumWebhook(deps, italk, d.body, d.headers)).status).toBe(500);
    expect((await handleMoneriumWebhook(deps, italk, d.body, d.headers)).status).toBe(200);
    expect(rec.upserts).toEqual(['ord-1']);
  });
});
