import type { Env } from '../types';
import { decryptSecret, importKek, type SecretField } from './secrets';
import { defaultTenantId } from './whitelist';

/// The ONE place that knows where a tenant's money infrastructure lives
/// (ADR 0017): Monerium credentials + profile, webhook secret, the Safe the
/// tenant's IBAN mints into, and the signer that may move EURe out of it.
///
/// - The default tenant (ITalk) is built from the Worker env, byte-for-byte
///   what the rail read before multi-tenancy. It has no `tenant_rail` row.
/// - Every other tenant comes from `tenant_rail`, secrets decrypted with the
///   KEK. No row, multi-tenancy switched off, or a secret that will not
///   decrypt → `null`. There is NO fallback to ITalk's config: a caller that
///   gets `null` must refuse (fail-closed).
///
/// Nothing outside this file may read env.MONERIUM_CLIENT_* / SAFE_ADDRESS /
/// ROLES_MODIFIER_ADDRESS / ROLE_KEY / ROUTER_PRIVATE_KEY for money decisions.

export const GNOSIS_RPC_DEFAULT = 'https://rpc.gnosischain.com';
export const CHIADO_RPC_DEFAULT = 'https://rpc.chiadochain.net';

export type RailChain = 'gnosis' | 'chiado';

/// Everything `forwardViaSafe` needs to sign one forward. Empty strings mean
/// "not configured" — forwardViaSafe refuses with `router_disabled: …`,
/// exactly as it did when these were env vars.
export interface RailSigner {
  chain: RailChain;
  rpcUrl: string;
  eureContract: string;
  safe: string;
  rolesModifier: string;
  roleKey: string;
  privateKey: string;
  /// PaymentRegistry MultiSend path. Only the legacy (ITalk) rail may use it:
  /// role conditions are not applied inside a multiSend blob without an
  /// unwrapper (safe-tx/006 §1), so tenants always use the direct transfer.
  paymentRegistry: string;
  multiSend: string;
}

export interface MoneriumCreds {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /// Profile to operate on. ITalk: env override or resolved from /auth/context
  /// (null). Tenants: always set — it is part of their identity.
  profileId: string | null;
  /// KV key for the cached access token. Per tenant, so two tenants can never
  /// share (or overwrite) each other's token.
  tokenCacheKey: string;
}

export interface TenantRail {
  tenantId: string;
  /// True for the env-backed default tenant (ITalk).
  legacy: boolean;
  monerium: MoneriumCreds;
  webhookSecret: string;
  /// Lowercase address the tenant's IBAN mints into. ITalk: env.SAFE_ADDRESS
  /// (may be empty → null, as before).
  receivingSafe: string | null;
  signer: RailSigner;
  /// Software cap per forward (cents); null = none.
  maxForwardCents: number | null;
}

export const LEGACY_TOKEN_KEY = 'monerium:access_token';

export function multiTenantEnabled(env: Env): boolean {
  return (env.MULTI_TENANT_RAIL ?? '').trim() === '1';
}

export function isLegacyTenant(env: Env, tenantId: string): boolean {
  return tenantId === defaultTenantId(env);
}

function lc(addr: string | null | undefined): string | null {
  const v = (addr ?? '').trim().toLowerCase();
  return v ? v : null;
}

/// The pre-ADR-0017 rail, read from env. Must stay byte-identical in effect.
export function legacyRail(env: Env): TenantRail {
  return {
    tenantId: defaultTenantId(env),
    legacy: true,
    monerium: {
      baseUrl: env.MONERIUM_BASE_URL,
      clientId: env.MONERIUM_CLIENT_ID ?? '',
      clientSecret: env.MONERIUM_CLIENT_SECRET ?? '',
      profileId: env.MONERIUM_PROFILE_ID || null,
      tokenCacheKey: LEGACY_TOKEN_KEY,
    },
    webhookSecret: env.MONERIUM_WEBHOOK_SECRET ?? '',
    receivingSafe: lc(env.SAFE_ADDRESS),
    signer: {
      chain: 'gnosis',
      rpcUrl: env.GNOSIS_RPC_URL || GNOSIS_RPC_DEFAULT,
      eureContract: env.EURE_CONTRACT ?? '',
      safe: env.SAFE_ADDRESS ?? '',
      rolesModifier: env.ROLES_MODIFIER_ADDRESS ?? '',
      roleKey: env.ROLE_KEY ?? '',
      privateKey: env.ROUTER_PRIVATE_KEY ?? '',
      paymentRegistry: env.PAYMENT_REGISTRY_ADDRESS ?? '',
      multiSend: env.MULTISEND_ADDRESS ?? '',
    },
    maxForwardCents: null,
  };
}

export interface TenantRailRow {
  tenant_id: string;
  monerium_env: string;
  chain: string;
  auth_kind: string;
  client_id: string;
  client_secret_enc: string;
  refresh_token_enc: string | null;
  profile_id: string;
  receiving_safe: string;
  roles_modifier: string | null;
  role_key: string | null;
  router_address: string | null;
  router_key_enc: string | null;
  eure_contract: string | null;
  rpc_url: string | null;
  webhook_secret_enc: string | null;
  webhook_subscription_id: string | null;
  outbound_webhook_url: string | null;
  outbound_webhook_secret_enc: string | null;
  max_forward_cents: number | null;
  verified_at: number | null;
  verify_report: string | null;
  created_at: number;
  updated_at: number;
}

export function moneriumBaseUrl(moneriumEnv: string): string | null {
  if (moneriumEnv === 'production') return 'https://api.monerium.app';
  if (moneriumEnv === 'sandbox') return 'https://api.monerium.dev';
  return null;
}

export function parseChain(chain: string): RailChain | null {
  return chain === 'gnosis' || chain === 'chiado' ? chain : null;
}

export type Decrypt = (field: SecretField, blob: string | null) => Promise<string>;

/// Pure mapping row → rail, with decryption injected (unit-testable).
/// Returns null on anything unrecognised — an unknown env/chain/auth kind is
/// a configuration we never validated, so it must not move money.
export async function railFromRow(
  env: Env,
  row: TenantRailRow,
  decrypt: Decrypt,
): Promise<TenantRail | null> {
  const baseUrl = moneriumBaseUrl(row.monerium_env);
  const chain = parseChain(row.chain);
  if (!baseUrl || !chain) return null;
  if (row.auth_kind !== 'client_credentials') {
    // 'oauth' is modelled (refresh_token_enc) but not built yet — see ADR
    // 0017 open question 1. Refuse rather than half-work.
    return null;
  }
  const eure = row.eure_contract ?? (chain === 'gnosis' ? env.EURE_CONTRACT : '');
  if (!eure) return null; // chiado has no default EURe address
  return {
    tenantId: row.tenant_id,
    legacy: false,
    monerium: {
      baseUrl,
      clientId: row.client_id,
      clientSecret: await decrypt('client_secret', row.client_secret_enc),
      profileId: row.profile_id,
      tokenCacheKey: `${LEGACY_TOKEN_KEY}:${row.tenant_id}`,
    },
    webhookSecret: row.webhook_secret_enc ? await decrypt('webhook_secret', row.webhook_secret_enc) : '',
    receivingSafe: lc(row.receiving_safe),
    signer: {
      chain,
      rpcUrl: row.rpc_url || (chain === 'gnosis' ? env.GNOSIS_RPC_URL || GNOSIS_RPC_DEFAULT : CHIADO_RPC_DEFAULT),
      eureContract: eure,
      safe: row.receiving_safe,
      rolesModifier: row.roles_modifier ?? '',
      roleKey: row.role_key ?? '',
      privateKey: row.router_key_enc ? await decrypt('router_key', row.router_key_enc) : '',
      paymentRegistry: '',
      multiSend: '',
    },
    maxForwardCents: row.max_forward_cents,
  };
}

export async function getTenantRailRow(env: Env, tenantId: string): Promise<TenantRailRow | null> {
  const row = await env.DB.prepare(`SELECT * FROM tenant_rail WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<TenantRailRow>();
  return row ?? null;
}

/// Resolve a tenant's rail. `null` = this tenant cannot receive webhooks or
/// move money right now; callers refuse, they never substitute ITalk.
export async function getTenantRail(env: Env, tenantId: string): Promise<TenantRail | null> {
  if (isLegacyTenant(env, tenantId)) return legacyRail(env);
  if (!multiTenantEnabled(env)) return null;
  const row = await getTenantRailRow(env, tenantId);
  if (!row) return null;
  try {
    const kek = await importKek(env.TENANT_SECRETS_KEK);
    return await railFromRow(env, row, async (field, blob) => {
      if (!blob) throw new Error(`missing ${field}`);
      return decryptSecret(kek, tenantId, field, blob);
    });
  } catch (e) {
    console.error(`tenant ${tenantId} rail unusable: ${(e as Error).message}`);
    return null;
  }
}

/// Tenant ids with a rail row — what the reconcile cron iterates besides ITalk.
export async function listRailTenantIds(env: Env): Promise<string[]> {
  if (!multiTenantEnabled(env)) return [];
  const res = await env.DB.prepare(
    `SELECT r.tenant_id FROM tenant_rail r
       JOIN tenants t ON t.id = r.tenant_id
      WHERE t.status IN ('active', 'suspended')
      ORDER BY r.tenant_id`,
  ).all<{ tenant_id: string }>();
  return res.results.map((r) => r.tenant_id);
}
