import type { Env } from '../types';

/// D1 access for the tenant registry + payout whitelist (migration 0013).
/// Everything that decides "may EURe leave the Safe for this address" reads
/// through here — see ../tenants/whitelist.ts for the single enforcement point.

export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  /// JSON array of dynamic whitelist sources, e.g. ["wallet_registry"].
  allow_sources: string;
  /// SEPA collection leg — the Monerium-onboarded account this tenant's QRs
  /// collect on. Per tenant, not global: tenant #2 collects on ITS OWN IBAN
  /// after its own Monerium KYC/KYB.
  beneficiary_name: string;
  iban: string;   // canonical, no spaces
  bic: string | null;
  created_at: number;
  updated_at: number;
}

/// The beneficiary block baked into a tenant's EPC/QR payload.
export interface SepaDetails {
  beneficiaryName: string;
  iban: string;
  bic: string;
}

/// ITalk d.o.o. — the first tenant, holder of the Monerium KYB relationship.
/// Duplicated from migration 0014 ONLY as a last-resort fallback for read
/// paths (checkout page, status endpoint) so a missing tenant row can never
/// 500 a page. It is never used to decide where money goes.
export const FALLBACK_SEPA: SepaDetails = {
  beneficiaryName: 'ITalk d.o.o.',
  iban: 'EE707777000162921128',
  bic: 'LHVBEE22',
};

export async function getSepaDetails(env: Env, tenantId: string): Promise<SepaDetails> {
  const t = await getTenant(env, tenantId);
  if (!t) {
    console.error(`tenant ${tenantId} has no row — falling back to hardcoded SEPA details`);
    return FALLBACK_SEPA;
  }
  return {
    beneficiaryName: t.beneficiary_name,
    iban: t.iban,
    bic: t.bic ?? '',
  };
}

/// IBAN in human 4-char groups for display. Storage stays canonical.
export function formatIban(iban: string): string {
  return iban.replace(/\s+/g, '').replace(/(.{4})/g, '$1 ').trim();
}

export interface PayoutAddressRow {
  tenant_id: string;
  address: string;
  label: string | null;
  source: string;
  created_at: number;
  created_by: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface TenantCampaignRow {
  campaign_id: string;
  tenant_id: string;
  safe_address: string;
  label: string | null;
  created_at: number;
  created_by: string | null;
  revoked_at: number | null;
}

export interface TenantApiKeyRow {
  key_hash: string;
  tenant_id: string;
  kind: 'public' | 'secret';
  label: string | null;
  created_at: number;
  revoked_at: number | null;
}

/// Dynamic whitelist sources understood by `isAddressWhitelisted`. A source
/// name in `tenants.allow_sources` that isn't listed here is IGNORED — an
/// unknown value can never widen the allowed set (fail-closed by default).
export const KNOWN_ALLOW_SOURCES = ['wallet_registry'] as const;
export type AllowSource = (typeof KNOWN_ALLOW_SOURCES)[number];

export function parseAllowSources(json: string | null | undefined): AllowSource[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is AllowSource =>
      typeof s === 'string' && (KNOWN_ALLOW_SOURCES as readonly string[]).includes(s),
    );
  } catch {
    return [];
  }
}

export async function getTenant(env: Env, tenantId: string): Promise<TenantRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM tenants WHERE id = ?`)
    .bind(tenantId)
    .first<TenantRow>();
  return row ?? null;
}

export async function listTenants(env: Env): Promise<TenantRow[]> {
  const res = await env.DB.prepare(`SELECT * FROM tenants ORDER BY id`).all<TenantRow>();
  return res.results;
}

/// Case-insensitive whitelist check. Both sides are lowercased, so an EIP-55
/// checksummed input and a lowercased stored row compare equal.
///
/// Order: static table first (cheap, one indexed lookup), then any dynamic
/// source the tenant has enabled. Revoked rows never count.
export async function isAddressWhitelisted(
  env: Env,
  tenantId: string,
  address: string,
): Promise<boolean> {
  const addr = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return false;

  const stat = await env.DB.prepare(
    `SELECT 1 AS ok FROM tenant_payout_addresses
      WHERE tenant_id = ? AND lower(address) = ? AND revoked_at IS NULL`,
  )
    .bind(tenantId, addr)
    .first<{ ok: number }>();
  if (stat) return true;

  const tenant = await getTenant(env, tenantId);
  if (!tenant || tenant.status !== 'active') return false;
  const sources = parseAllowSources(tenant.allow_sources);

  if (sources.includes('wallet_registry')) {
    // A Safe the user self-registered through /api/wallets — either the
    // primary passkey wallet or one of its derived accounts. This is what
    // keeps DOMOVINA Wallet self-serve onboarding working without an admin
    // adding every new user by hand. See ADR 0016.
    const dyn = await env.DB.prepare(
      `SELECT 1 AS ok WHERE EXISTS (
         SELECT 1 FROM wallet_registry WHERE lower(safe_address) = ?1
       ) OR EXISTS (
         SELECT 1 FROM wallet_accounts WHERE lower(safe_address) = ?1
       )`,
    )
      .bind(addr)
      .first<{ ok: number }>();
    if (dyn) return true;
  }

  return false;
}

/// Which source allowed the address — for audit logging / admin UI. Returns
/// null when the address is NOT allowed. Slightly more expensive than
/// `isAddressWhitelisted`; used off the hot path.
export async function whitelistSource(
  env: Env,
  tenantId: string,
  address: string,
): Promise<'static' | AllowSource | null> {
  const addr = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) return null;
  const stat = await env.DB.prepare(
    `SELECT 1 AS ok FROM tenant_payout_addresses
      WHERE tenant_id = ? AND lower(address) = ? AND revoked_at IS NULL`,
  )
    .bind(tenantId, addr)
    .first<{ ok: number }>();
  if (stat) return 'static';
  return (await isAddressWhitelisted(env, tenantId, addr)) ? 'wallet_registry' : null;
}

export async function listPayoutAddresses(
  env: Env,
  tenantId: string,
  opts: { includeRevoked?: boolean } = {},
): Promise<PayoutAddressRow[]> {
  const where = opts.includeRevoked ? '' : 'AND revoked_at IS NULL';
  const res = await env.DB.prepare(
    `SELECT * FROM tenant_payout_addresses
      WHERE tenant_id = ? ${where}
      ORDER BY created_at DESC`,
  )
    .bind(tenantId)
    .all<PayoutAddressRow>();
  return res.results;
}

/// Add (or un-revoke) a payout address. Idempotent: re-adding an existing row
/// clears `revoked_at` and refreshes the label, so the admin flow "remove then
/// add back" works without a unique-constraint error.
export async function addPayoutAddress(
  env: Env,
  args: { tenantId: string; address: string; label: string | null; actor: string },
): Promise<void> {
  const addr = args.address.trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO tenant_payout_addresses
       (tenant_id, address, label, source, created_at, created_by)
     VALUES (?, ?, ?, 'admin', ?, ?)
     ON CONFLICT(tenant_id, address) DO UPDATE SET
       label = excluded.label,
       revoked_at = NULL,
       revoked_by = NULL`,
  )
    .bind(args.tenantId, addr, args.label, now, args.actor)
    .run();
}

/// Soft-revoke. Returns true when a live row was actually revoked.
export async function revokePayoutAddress(
  env: Env,
  args: { tenantId: string; address: string; actor: string },
): Promise<boolean> {
  const addr = args.address.trim().toLowerCase();
  const res = await env.DB.prepare(
    `UPDATE tenant_payout_addresses
        SET revoked_at = ?, revoked_by = ?
      WHERE tenant_id = ? AND lower(address) = ? AND revoked_at IS NULL`,
  )
    .bind(Math.floor(Date.now() / 1000), args.actor, args.tenantId, addr)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export async function getCampaign(
  env: Env,
  campaignId: string,
): Promise<TenantCampaignRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM tenant_campaigns WHERE campaign_id = ? AND revoked_at IS NULL`,
  )
    .bind(campaignId)
    .first<TenantCampaignRow>();
  return row ?? null;
}

export async function listCampaigns(
  env: Env,
  tenantId: string,
): Promise<TenantCampaignRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM tenant_campaigns WHERE tenant_id = ? ORDER BY created_at DESC`,
  )
    .bind(tenantId)
    .all<TenantCampaignRow>();
  return res.results;
}

export async function addCampaign(
  env: Env,
  args: {
    tenantId: string;
    campaignId: string;
    safeAddress: string;
    label: string | null;
    actor: string;
  },
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO tenant_campaigns
       (campaign_id, tenant_id, safe_address, label, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(campaign_id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       safe_address = excluded.safe_address,
       label = excluded.label,
       revoked_at = NULL`,
  )
    .bind(
      args.campaignId,
      args.tenantId,
      args.safeAddress.trim().toLowerCase(),
      args.label,
      now,
      args.actor,
    )
    .run();
}

export async function revokeCampaign(
  env: Env,
  args: { campaignId: string; actor: string },
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE tenant_campaigns SET revoked_at = ?
      WHERE campaign_id = ? AND revoked_at IS NULL`,
  )
    .bind(Math.floor(Date.now() / 1000), args.campaignId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/// Resolve the tenant behind an API key. `keyHash` is the sha256 hex of the
/// raw key — the raw key itself is never stored or logged.
export async function getTenantByKeyHash(
  env: Env,
  keyHash: string,
): Promise<{ tenant: TenantRow; key: TenantApiKeyRow } | null> {
  const key = await env.DB.prepare(
    `SELECT * FROM tenant_api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
  )
    .bind(keyHash)
    .first<TenantApiKeyRow>();
  if (!key) return null;
  const tenant = await getTenant(env, key.tenant_id);
  if (!tenant) return null;
  return { tenant, key };
}

export async function insertApiKey(
  env: Env,
  args: {
    tenantId: string;
    keyHash: string;
    kind: 'public' | 'secret';
    label: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_api_keys (key_hash, tenant_id, kind, label, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(args.keyHash, args.tenantId, args.kind, args.label, Math.floor(Date.now() / 1000))
    .run();
}

export async function listApiKeys(env: Env, tenantId: string): Promise<TenantApiKeyRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM tenant_api_keys WHERE tenant_id = ? ORDER BY created_at DESC`,
  )
    .bind(tenantId)
    .all<TenantApiKeyRow>();
  return res.results;
}

export async function revokeApiKey(
  env: Env,
  keyHash: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE tenant_api_keys SET revoked_at = ? WHERE key_hash = ? AND revoked_at IS NULL`,
  )
    .bind(Math.floor(Date.now() / 1000), keyHash)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

export interface AuditEntry {
  tenantId: string | null;
  action: string;
  address?: string | null;
  actor: string;
  detail?: string | null;
}

export async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO tenant_audit_log (at, tenant_id, action, address, actor, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      Math.floor(Date.now() / 1000),
      entry.tenantId,
      entry.action,
      entry.address ?? null,
      entry.actor,
      entry.detail ?? null,
    )
    .run();
}

export interface AuditRow {
  id: number;
  at: number;
  tenant_id: string | null;
  action: string;
  address: string | null;
  actor: string;
  detail: string | null;
}

export async function listAudit(
  env: Env,
  filter: { tenantId?: string; limit?: number } = {},
): Promise<AuditRow[]> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  if (filter.tenantId) {
    const res = await env.DB.prepare(
      `SELECT * FROM tenant_audit_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?`,
    )
      .bind(filter.tenantId, limit)
      .all<AuditRow>();
    return res.results;
  }
  const res = await env.DB.prepare(
    `SELECT * FROM tenant_audit_log ORDER BY id DESC LIMIT ?`,
  )
    .bind(limit)
    .all<AuditRow>();
  return res.results;
}

/// sha256 hex of a raw API key. Also used by the admin key-issue endpoint.
export async function hashApiKey(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw.trim()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
