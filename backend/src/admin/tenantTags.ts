import type { Env } from '../types';
import { defaultTenantId } from '../tenants/whitelist';

/// Display-only tags for admin lists: which tenant a row belongs to and which
/// Monerium environment (production / sandbox) that tenant's rail talks to.
///
/// Never used for money decisions — that stays in tenants/rail.ts.
export interface TenantTag {
  tenant_id: string;
  tenant_name: string | null;
  monerium_env: 'production' | 'sandbox' | 'unknown';
  chain: string;
}

export interface TenantTags {
  defaultId: string;
  list: TenantTag[];
  resolve(tenantId: string | null | undefined): TenantTag;
}

function normEnv(v: string | null | undefined): TenantTag['monerium_env'] {
  return v === 'production' || v === 'sandbox' ? v : 'unknown';
}

export async function loadTenantTags(env: Env): Promise<TenantTags> {
  const defaultId = defaultTenantId(env);
  const res = await env.DB.prepare(
    `SELECT t.id AS id, t.name AS name, r.monerium_env AS monerium_env, r.chain AS chain
       FROM tenants t LEFT JOIN tenant_rail r ON r.tenant_id = t.id
     UNION
     SELECT r.tenant_id, NULL, r.monerium_env, r.chain
       FROM tenant_rail r WHERE r.tenant_id NOT IN (SELECT id FROM tenants)`,
  ).all<{ id: string; name: string | null; monerium_env: string | null; chain: string | null }>();

  const byId = new Map<string, TenantTag>();
  for (const r of res.results) {
    byId.set(r.id, {
      tenant_id: r.id,
      tenant_name: r.name,
      monerium_env: normEnv(r.monerium_env),
      chain: r.chain ?? 'gnosis',
    });
  }

  return {
    defaultId,
    list: [...byId.values()].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id)),
    resolve(tenantId) {
      const id = tenantId || defaultId;
      // A tenant with neither a tenants nor a tenant_rail row: its rail is
      // fail-closed anyway, so we don't know (or claim) an environment.
      return byId.get(id) ?? { tenant_id: id, tenant_name: null, monerium_env: 'unknown', chain: 'gnosis' };
    },
  };
}

/// SQL fragment for a tenant filter where NULL means the default tenant.
export function tenantWhere(tenantId: string, defaultId: string): { sql: string; args: unknown[] } {
  return tenantId === defaultId
    ? { sql: '(tenant_id = ? OR tenant_id IS NULL)', args: [tenantId] }
    : { sql: 'tenant_id = ?', args: [tenantId] };
}
