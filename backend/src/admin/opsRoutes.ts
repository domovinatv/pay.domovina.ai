import { Hono, type Context } from 'hono';

import type { Env } from '../types';
import { getProvider } from '../providers';
import { insertAuthorization, listAuthorizations } from '../db';
import { MoneriumClient } from '../monerium/client';
import { upsertMoneriumOrder } from '../monerium/db';
import { writeAudit } from '../tenants/db';
import { defaultTenantId } from '../tenants/whitelist';
import { getTenantRail } from '../tenants/rail';

/// Ops routes — HPB bank connect and the ITalk Monerium admin calls. Built
/// once, mounted twice (AD-02): under /admin/api/{hpb,monerium} behind the
/// admin session, and (one more deploy cycle) under the old bearer-token
/// URLs. Auth is the mount's job; every mutation here is audited.

interface OpsDeps {
  actor(c: Context<{ Bindings: Env }>): string;
}

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

/// The tenant's own Monerium account (`?tenant=`, default tenant otherwise).
async function clientFor(c: Context<{ Bindings: Env }>): Promise<MoneriumClient | null> {
  const rail = await getTenantRail(c.env, c.req.query('tenant') || defaultTenantId(c.env));
  return rail ? new MoneriumClient(c.env, rail.monerium) : null;
}

export function buildMoneriumOps(deps: OpsDeps): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  /// Pulls the last N orders from Monerium and upserts them. Useful as a
  /// one-shot backfill or whenever you suspect a webhook was missed.
  app.post('/sync', async (c) => {
    const tenantId = c.req.query('tenant') || defaultTenantId(c.env);
    const client = await clientFor(c);
    if (!client) return c.json({ error: 'rail_not_found' }, 404);
    const orders = await client.listOrders();
    for (const o of orders) await upsertMoneriumOrder(c.env, o, tenantId);
    await audit(c, deps, 'monerium.sync', { tenant: tenantId, synced: orders.length });
    return c.json({ synced: orders.length });
  });

  app.get('/profiles', async (c) => {
    const client = await clientFor(c);
    if (!client) return c.json({ error: 'rail_not_found' }, 404);
    return c.json({ profiles: await client.listProfiles() });
  });

  app.get('/auth-context', async (c) => {
    const client = await clientFor(c);
    if (!client) return c.json({ error: 'rail_not_found' }, 404);
    return c.json(await client.getAuthContext());
  });

  app.get('/webhooks', async (c) => {
    const client = await clientFor(c);
    if (!client) return c.json({ error: 'rail_not_found' }, 404);
    return c.json({ subscriptions: await client.listWebhookSubscriptions() });
  });

  return app;
}
