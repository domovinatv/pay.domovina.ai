import { Hono, type Context } from 'hono';

import type { Env } from '../types';
import { getProvider } from '../providers';
import { insertAuthorization, listAuthorizations } from '../db';
import { MoneriumClient } from '../monerium/client';
import { upsertMoneriumOrder } from '../monerium/db';
import { verifyWebhookSignature } from '../monerium/webhook';
import { writeAudit } from '../tenants/db';
import { defaultTenantId } from '../tenants/whitelist';

/// Ops routes — HPB bank connect and the ITalk Monerium admin calls. Built
/// once, mounted twice (AD-02): under /admin/api/{hpb,monerium} behind the
/// admin session, and (one more deploy cycle) under the old bearer-token
/// URLs. Auth is the mount's job; every mutation here is audited.

interface OpsDeps {
  actor(c: Context<{ Bindings: Env }>): string;
}

/// The only URLs a Monerium subscription may point at: our own webhook
/// routes. A leaked token or session must not be able to point ITalk's order
/// stream (IBANs, names, amounts) at a third party.
export const OWN_WEBHOOK_URL_RE =
  /^https:\/\/(monerium|mpt)\.domovina\.ai\/api\/monerium\/webhook(\/t\/[A-Za-z0-9_-]{2,64})?$/;

async function audit(c: Context<{ Bindings: Env }>, deps: OpsDeps, action: string, detail: Record<string, unknown>) {
  await writeAudit(c.env, {
    tenantId: defaultTenantId(c.env),
    action,
    actor: deps.actor(c),
    detail: JSON.stringify(detail),
  }).catch((e) => console.error(`ops audit ${action}: ${(e as Error).message}`));
}

export function buildHpbOps(deps: OpsDeps & { refreshAllAccounts(env: Env): Promise<number> }): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/connect', async (c) => {
    const body = await c.req.json<{ institution_id: string; reference?: string }>();
    if (!body.institution_id) {
      return c.json({ error: 'institution_id required' }, 400);
    }
    const provider = getProvider(c.env);
    const reference = body.reference ?? `pdai-${Date.now()}`;
    const redirectUrl =
      provider.name === 'enable_banking'
        ? c.env.ENABLE_BANKING_REDIRECT_URL
        : c.env.GOCARDLESS_REDIRECT_URL;
    const r = await provider.createAuthorization({
      institutionId: body.institution_id,
      reference,
      redirectUrl,
    });
    await insertAuthorization(c.env, {
      id: r.id,
      provider: provider.name,
      institutionId: body.institution_id,
      reference,
      status: r.status,
      link: r.link,
    });
    await audit(c, deps, 'hpb.connect', { institution_id: body.institution_id, authorization_id: r.id });
    return c.json({ id: r.id, link: r.link, status: r.status });
  });

  app.post('/refresh', async (c) => {
    const inserted = await deps.refreshAllAccounts(c.env);
    await audit(c, deps, 'hpb.refresh', { inserted });
    return c.json({ inserted });
  });

  app.get('/authorizations', async (c) => {
    const authorizations = await listAuthorizations(c.env);
    return c.json({ authorizations });
  });

  return app;
}

export function buildMoneriumOps(deps: OpsDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /// Pulls the last N orders from Monerium and upserts them. Useful as a
  /// one-shot backfill or whenever you suspect a webhook was missed.
  app.post('/sync', async (c) => {
    const client = new MoneriumClient(c.env);
    const orders = await client.listOrders();
    for (const o of orders) await upsertMoneriumOrder(c.env, o);
    await audit(c, deps, 'monerium.sync', { synced: orders.length });
    return c.json({ synced: orders.length });
  });

  app.get('/profiles', async (c) => {
    const client = new MoneriumClient(c.env);
    const profiles = await client.listProfiles();
    return c.json({ profiles });
  });

  app.get('/auth-context', async (c) => {
    const client = new MoneriumClient(c.env);
    const ctx = await client.getAuthContext();
    return c.json(ctx);
  });

  app.get('/webhooks', async (c) => {
    const client = new MoneriumClient(c.env);
    const subs = await client.listWebhookSubscriptions();
    return c.json({ subscriptions: subs });
  });

  /// Replays the most recent stored webhook event through signature
  /// verification against the CURRENT MONERIUM_WEBHOOK_SECRET. Useful when the
  /// secret rotated after the original delivery.
  app.get('/replay-last', async (c) => {
    const row = await c.env.DB.prepare(
      `SELECT payload, headers_json FROM monerium_webhook_events
       WHERE headers_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
    ).first<{ payload: string; headers_json: string }>();
    if (!row) return c.json({ error: 'no events with headers stored' }, 404);
    const headers = new Headers();
    for (const [k, v] of Object.entries(JSON.parse(row.headers_json))) {
      if (typeof v === 'string') headers.set(k, v);
    }
    const verify = await verifyWebhookSignature(row.payload, headers, c.env.MONERIUM_WEBHOOK_SECRET);
    return c.json({ verify, body: row.payload, headers: JSON.parse(row.headers_json) });
  });

  /// One-time setup: registers our /api/monerium/webhook endpoint with
  /// Monerium. Body: { "url": "https://...", "types": [...] }. Only our own
  /// webhook URLs are accepted (AD-02).
  app.post('/webhooks', async (c) => {
    const body = await c.req.json<{ url: string; types?: string[] }>();
    if (!body.url) return c.json({ error: 'url required' }, 400);
    if (!OWN_WEBHOOK_URL_RE.test(body.url)) {
      await audit(c, deps, 'monerium.webhook_register_refused', { url: body.url.slice(0, 200) });
      return c.json({ error: 'url_not_ours' }, 400);
    }
    const client = new MoneriumClient(c.env);
    const sub = await client.createWebhookSubscription({
      url: body.url,
      types: body.types,
      secret: c.env.MONERIUM_WEBHOOK_SECRET || undefined,
    });
    await audit(c, deps, 'monerium.webhook_register', { url: body.url, types: body.types ?? null });
    return c.json({ subscription: sub });
  });

  return app;
}
