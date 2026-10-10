import type { Hono } from 'hono';

import type { Env } from '../types';
import { writeAudit } from './db';
import { actorOf } from '../admin/auth/mount';
import { isLegacyTenant, railFromStoredRow } from './rail';
import {
  createTenant,
  generateRouterKey,
  loadTenantAndRail,
  makeVerifyDeps,
  nextStatus,
  redactRail,
  registerTenantWebhook,
  runVerify,
  saveVerifyReport,
  setTenantStatus,
  upsertRail,
  validateCreateTenant,
  validateRailInput,
  type Transition,
} from './onboarding';
import { renderTenantsPage } from '../admin/views';

/// Admin surface for tenant onboarding (ADR 0017 §Admin). Mounted under
/// `/admin/*`, behind the same admin session as the rest of the dashboard.
///
/// The default tenant (ITalk) is deliberately out of reach here: its rail is
/// the Worker env, and a status flip from this API could park every live
/// ITalk forward with no rail row to resume from.

async function jsonBody(req: { json<T>(): Promise<T> }): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json<unknown>();
    return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function mountRailAdmin(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/tenants', (c) => c.html(renderTenantsPage()));

  app.post('/admin/api/tenants', async (c) => {
    const body = await jsonBody(c.req);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const v = validateCreateTenant(body);
    if (!v.ok) return c.json({ error: v.error }, 400);
    if (isLegacyTenant(c.env, v.value.id)) return c.json({ error: 'default_tenant_uses_env' }, 400);
    const r = await createTenant(c.env, v.value);
    if (r === 'exists') return c.json({ error: 'tenant_exists' }, 409);
    await writeAudit(c.env, {
      tenantId: v.value.id,
      action: 'tenant.create',
      actor: actorOf(c),
      detail: JSON.stringify({ name: v.value.name, iban: v.value.iban }),
    });
    return c.json({ ok: true, tenant_id: v.value.id, status: 'onboarding' });
  });

  app.get('/admin/api/tenants/:id/rail', async (c) => {
    const id = c.req.param('id');
    if (isLegacyTenant(c.env, id)) return c.json({ tenant_id: id, legacy: true, rail: null });
    const { tenant, row } = await loadTenantAndRail(c.env, id);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);
    return c.json({ tenant_id: id, status: tenant.status, legacy: false, rail: row ? redactRail(row) : null });
  });

  app.put('/admin/api/tenants/:id/rail', async (c) => {
    const id = c.req.param('id');
    if (isLegacyTenant(c.env, id)) return c.json({ error: 'default_tenant_uses_env' }, 400);
    const { tenant, row } = await loadTenantAndRail(c.env, id);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);
    // Changing credentials, profile or Safe under a live tenant would let
    // payments in flight meet a different config. Suspend, change, verify.
    if (tenant.status === 'active') return c.json({ error: 'suspend_first' }, 409);
    const body = await jsonBody(c.req);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const v = validateRailInput(body, row);
    if (!v.ok) return c.json({ error: v.error }, 400);
    await upsertRail(c.env, id, v.value, row);
    await writeAudit(c.env, {
      tenantId: id,
      action: 'rail.update',
      address: v.value.receivingSafe,
      actor: actorOf(c),
      detail: JSON.stringify({
        monerium_env: v.value.moneriumEnv,
        chain: v.value.chain,
        profile_id: v.value.profileId,
        roles_modifier: v.value.rolesModifier,
        client_secret_changed: Boolean(v.value.clientSecret),
        max_forward_cents: v.value.maxForwardCents,
      }),
    });
    const fresh = await loadTenantAndRail(c.env, id);
    return c.json({ ok: true, rail: fresh.row ? redactRail(fresh.row) : null });
  });

  app.post('/admin/api/tenants/:id/rail/router-key', async (c) => {
    const id = c.req.param('id');
    if (isLegacyTenant(c.env, id)) return c.json({ error: 'default_tenant_uses_env' }, 400);
    const { tenant, row } = await loadTenantAndRail(c.env, id);
    if (!tenant || !row) return c.json({ error: 'rail_not_found' }, 404);
    if (tenant.status === 'active') return c.json({ error: 'suspend_first' }, 409);
    // Rotating the key means a new batch 007 on the tenant's Safe — never by accident.
    if (row.router_key_enc && c.req.query('rotate') !== '1') {
      return c.json({ error: 'router_exists', router_address: row.router_address, hint: 'add ?rotate=1' }, 409);
    }
    const address = await generateRouterKey(c.env, id);
    await writeAudit(c.env, {
      tenantId: id,
      action: row.router_key_enc ? 'rail.router_rotate' : 'rail.router_create',
      address: address.toLowerCase(),
      actor: actorOf(c),
    });
    return c.json({ ok: true, router_address: address });
  });

  app.post('/admin/api/tenants/:id/rail/webhook', async (c) => {
    const id = c.req.param('id');
    if (isLegacyTenant(c.env, id)) return c.json({ error: 'default_tenant_uses_env' }, 400);
    const { tenant, row } = await loadTenantAndRail(c.env, id);
    if (!tenant || !row) return c.json({ error: 'rail_not_found' }, 404);
    if (tenant.status === 'active') return c.json({ error: 'suspend_first' }, 409);
    try {
      const r = await registerTenantWebhook(c.env, id, new URL(c.req.url).origin);
      await writeAudit(c.env, {
        tenantId: id,
        action: 'rail.webhook_register',
        actor: actorOf(c),
        detail: JSON.stringify(r),
      });
      return c.json({ ok: true, url: r.url, subscription_id: r.subscriptionId });
    } catch (e) {
      return c.json({ error: 'webhook_registration_failed', detail: (e as Error).message.slice(0, 300) }, 502);
    }
  });

  app.post('/admin/api/tenants/:id/rail/verify', async (c) => {
    const id = c.req.param('id');
    if (isLegacyTenant(c.env, id)) return c.json({ error: 'default_tenant_uses_env' }, 400);
    const { tenant, row } = await loadTenantAndRail(c.env, id);
    if (!tenant || !row) return c.json({ error: 'rail_not_found' }, 404);
    const rail = await railFromStoredRow(c.env, row);
    if (!rail) return c.json({ error: 'rail_unusable', hint: 'TENANT_SECRETS_KEK / monerium_env / chain' }, 409);
    const checks = await runVerify(makeVerifyDeps(c.env, id, rail), tenant, row, Boolean(rail.signer.privateKey));
    const ok = await saveVerifyReport(c.env, id, checks);
    await writeAudit(c.env, {
      tenantId: id,
      action: 'rail.verify',
      actor: actorOf(c),
      detail: JSON.stringify({ ok, failed: checks.filter((x) => !x.ok).map((x) => x.key) }),
    });
    return c.json({ ok, checks });
  });

  for (const transition of ['activate', 'suspend', 'resume'] as Transition[]) {
    app.post(`/admin/api/tenants/:id/${transition}`, async (c) => {
      const id = c.req.param('id');
      if (isLegacyTenant(c.env, id)) return c.json({ error: 'default_tenant_uses_env' }, 400);
      const { tenant, row } = await loadTenantAndRail(c.env, id);
      if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);
      const next = nextStatus(tenant.status, transition, Boolean(row?.verified_at));
      if (!next.ok) return c.json({ error: next.error }, 409);
      await setTenantStatus(c.env, id, next.status);
      await writeAudit(c.env, {
        tenantId: id,
        action: `tenant.${transition}`,
        actor: actorOf(c),
        detail: `${tenant.status} → ${next.status}`,
      });
      return c.json({ ok: true, tenant_id: id, status: next.status });
    });
  }
}
