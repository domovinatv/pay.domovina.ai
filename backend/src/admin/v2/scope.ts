// Admin v2 — opseg prikaza: Produkcija ili Sandbox (kao Stripeov test mode).
//
// Tenant je sandbox ako je self-serve sandbox (tenants.sandbox = 1, ADR 0024),
// ako mu rail govori s Monerium sandboxom, ili ako mu id počinje sa `sbx-`.
// Sve ostalo je produkcija, uključujući retke s tenant_id NULL (stari ITalk
// redovi = zadani tenant). Samo za prikaz; novac odlučuje tenants/rail.ts.

import type { Env } from '../../types';
import { defaultTenantId } from '../../tenants/whitelist';

export type Mode = 'production' | 'sandbox';

export interface ScopeTenant {
  id: string;
  name: string | null;
  status: string | null;
  sandbox: boolean;
  monerium_env: string | null;
  chain: string | null;
}

export interface Scope {
  mode: Mode;
  defaultId: string;
  /// Svi tenanti, oba okruženja (za pretragu i oznake).
  all: ScopeTenant[];
  /// Tenanti u trenutačnom okruženju.
  tenants: ScopeTenant[];
  byId(id: string | null | undefined): ScopeTenant | null;
  /// SQL uvjet za stupac tenanta u ovom okruženju (NULL = zadani tenant).
  where(col?: string): { sql: string; args: string[] };
  /// Isto, suženo na jednog tenanta (mora biti u okruženju).
  whereTenant(tenantId: string, col?: string): { sql: string; args: string[] };
}

export const MODE_COOKIE = 'mpt_v2_mode';

export function modeFromCookie(cookie: string | null | undefined): Mode {
  const m = /(?:^|;\s*)mpt_v2_mode=([a-z]+)/.exec(cookie ?? '');
  return m?.[1] === 'sandbox' ? 'sandbox' : 'production';
}

export function isSandboxTenant(t: { id: string; sandbox?: number | boolean | null; monerium_env?: string | null }): boolean {
  return Boolean(t.sandbox) || t.monerium_env === 'sandbox' || t.id.startsWith('sbx-');
}

export async function loadScope(env: Env, mode: Mode): Promise<Scope> {
  const defaultId = defaultTenantId(env);
  const res = await env.DB.prepare(
    `SELECT t.id AS id, t.name AS name, t.status AS status, t.sandbox AS sandbox,
            r.monerium_env AS monerium_env, r.chain AS chain
       FROM tenants t LEFT JOIN tenant_rail r ON r.tenant_id = t.id
     UNION
     SELECT r.tenant_id, NULL, NULL, 0, r.monerium_env, r.chain
       FROM tenant_rail r WHERE r.tenant_id NOT IN (SELECT id FROM tenants)`,
  ).all<{ id: string; name: string | null; status: string | null; sandbox: number | null; monerium_env: string | null; chain: string | null }>();

  const all: ScopeTenant[] = res.results
    .map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      sandbox: isSandboxTenant(r),
      monerium_env: r.monerium_env,
      chain: r.chain,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const tenants = all.filter((t) => t.sandbox === (mode === 'sandbox'));
  const ids = tenants.map((t) => t.id);
  const map = new Map(all.map((t) => [t.id, t]));
  const includesNull = mode === 'production';

  return {
    mode,
    defaultId,
    all,
    tenants,
    byId: (id) => map.get(id || defaultId) ?? null,
    where(col = 'tenant_id') {
      const parts: string[] = [];
      if (ids.length) parts.push(`${col} IN (${ids.map(() => '?').join(', ')})`);
      if (includesNull) parts.push(`${col} IS NULL`);
      return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', args: ids };
    },
    whereTenant(tenantId, col = 'tenant_id') {
      if (!ids.includes(tenantId)) return { sql: '0', args: [] };
      return tenantId === defaultId
        ? { sql: `(${col} = ? OR ${col} IS NULL)`, args: [tenantId] }
        : { sql: `${col} = ?`, args: [tenantId] };
    },
  };
}
