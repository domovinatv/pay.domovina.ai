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
  /// `sandbox` is set only when a key was presented (ADR 0024): true for a
  /// `*_test_` key of a sandbox tenant.
  | { ok: true; tenantId: string; keyKind: 'public' | 'secret' | null; sandbox?: boolean }
  | { ok: false; error: 'missing_tenant_key' | 'invalid_tenant_key' | 'tenant_suspended' };

/// Accepted transports, in order: `x-mpt-key: <key>` header, then
/// `authorization: Bearer <key>` (what browsers can send — the rail's CORS
/// allows `Authorization`, not `x-mpt-key`).
///
/// null means "the caller sent no key at all". ANY key header that is present
/// returns a string — even an empty or malformed one — so it is looked up and
/// rejected as `invalid_tenant_key`. A caller that tried to name a tenant must
/// never silently land on the default tenant (ADR 0017).
export function readTenantKey(headers: Headers): string | null {
  const direct = headers.get('x-mpt-key');
  if (direct !== null) return direct.trim();
  const auth = headers.get('authorization');
  if (auth !== null) {
    const m = auth.match(/^Bearer\s+(\S+)\s*$/i);
    return m ? m[1] : auth.trim();
  }
  return null;
}

export async function resolveRequestTenant(
  env: Env,
  headers: Headers,
): Promise<TenantResolution> {
  const raw = readTenantKey(headers);
  const strict = (env.INTENT_REQUIRE_TENANT_KEY ?? '').trim() === '1';

  if (raw === null) {
    if (strict) return { ok: false, error: 'missing_tenant_key' };
    return { ok: true, tenantId: defaultTenantId(env), keyKind: null };
  }

  const m = raw.match(/^(pk|sk)_(test_)?[0-9a-f]{16,}$/);
  if (!m) return { ok: false, error: 'invalid_tenant_key' };
  const found = await getTenantByKeyHash(env, await hashApiKey(raw));
  if (!found) return { ok: false, error: 'invalid_tenant_key' };
  // ADR 0024 D2: a test key only ever names a sandbox tenant and a live key
  // only a real one, so swapping the key is what switches the environment.
  const sandbox = (found.tenant as { sandbox?: number }).sandbox === 1;
  if (Boolean(m[2]) !== sandbox) return { ok: false, error: 'invalid_tenant_key' };
  if (found.tenant.status !== 'active') return { ok: false, error: 'tenant_suspended' };
  return { ok: true, tenantId: found.tenant.id, keyKind: found.key.kind, sandbox };
}

/// Generate a fresh API key. Returned raw exactly once by the admin endpoint;
/// only its sha256 is persisted.
/// `test` (ADR 0024): a sandbox tenant's key, `pk_test_…` / `sk_test_…`.
export function generateApiKey(kind: 'public' | 'secret', opts: { test?: boolean } = {}): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const body = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${kind === 'public' ? 'pk' : 'sk'}_${opts.test ? 'test_' : ''}${body}`;
}
