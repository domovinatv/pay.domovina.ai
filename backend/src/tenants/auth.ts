import type { Env } from '../types';
import { getTenantByKeyHash, hashApiKey } from './db';
import { defaultTenantId } from './whitelist';

/// Tenant identification for the public intent API.
///
/// Deliberately weak by design, and that is fine: the two shipped clients are
/// a browser bundle (wallet.domovina.ai) and a Flutter app, so any key they
/// carry is public. A key therefore IDENTIFIES a tenant, it does not
/// authenticate one. The security boundary is downstream — the payout
/// whitelist decides where money may go, and knowing a tenant id buys an
/// attacker nothing that the whitelist doesn't already constrain.
///
/// Soft mode (default): no key → DEFAULT_TENANT_ID. Set
/// INTENT_REQUIRE_TENANT_KEY=1 once every client ships a key, and unknown /
/// revoked / absent keys start being rejected.

export type TenantResolution =
  | { ok: true; tenantId: string; keyKind: 'public' | 'secret' | null }
  | { ok: false; error: 'missing_tenant_key' | 'invalid_tenant_key' | 'tenant_suspended' };

/// Accepted transports, in order: `x-mpt-key: <key>` header (preferred — does
/// not collide with the admin bearer scheme), then `authorization: Bearer <key>`
/// but ONLY for values that look like our keys (`pk_` / `sk_` prefix).
export function readTenantKey(headers: Headers): string | null {
  const direct = headers.get('x-mpt-key');
  if (direct && direct.trim()) return direct.trim();
  const auth = headers.get('authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (m && /^(pk|sk)_/.test(m[1])) return m[1];
  }
  return null;
}

export async function resolveRequestTenant(
  env: Env,
  headers: Headers,
): Promise<TenantResolution> {
  const raw = readTenantKey(headers);
  const strict = (env.INTENT_REQUIRE_TENANT_KEY ?? '').trim() === '1';

  if (!raw) {
    if (strict) return { ok: false, error: 'missing_tenant_key' };
    return { ok: true, tenantId: defaultTenantId(env), keyKind: null };
  }

  const found = await getTenantByKeyHash(env, await hashApiKey(raw));
  if (!found) return { ok: false, error: 'invalid_tenant_key' };
  if (found.tenant.status !== 'active') return { ok: false, error: 'tenant_suspended' };
  return { ok: true, tenantId: found.tenant.id, keyKind: found.key.kind };
}

/// Generate a fresh API key. Returned raw exactly once by the admin endpoint;
/// only its sha256 is persisted.
export function generateApiKey(kind: 'public' | 'secret'): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${kind === 'public' ? 'pk' : 'sk'}_${body}`;
}
