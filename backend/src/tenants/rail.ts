import type { Env } from '../types';
import { decryptSecret, importKeks, type SecretField } from './secrets';
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

/// How the rail settles an intent (migration 0026):
/// - 'forward': mint into receiving_safe, then a Roles-signed forward (ADR 0017).
/// - 'direct': the payer's reference makes Monerium mint straight into the
///   intent's target (a project Safe registered as a campaign). The rail only
///   matches order → intent and never signs.
export type RailMode = 'forward' | 'direct';

export function parseRailMode(mode: string | null | undefined): RailMode | null {
  if (mode === undefined || mode === null || mode === '' || mode === 'forward') return 'forward';
  return mode === 'direct' ? 'direct' : null;
}

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
  /// Absent = 'forward' (the legacy rail and every pre-0026 row).
  mode?: RailMode;
  monerium: MoneriumCreds;
  webhookSecret: string;
  /// Lowercase address the tenant's IBAN mints into. ITalk: env.SAFE_ADDRESS
  /// (may be empty → null, as before).
  receivingSafe: string | null;
  signer: RailSigner;
  /// ADR 0026: direct-mode rails only. Signs `EURe.transfer` from the main Safe
  /// through the ProjectRouter role, which the Roles modifier restricts
  /// on-chain to the project Safes the owners approved. Used for exactly one
  /// thing: settling D4 owed transfers. Absent = D4 stays a manual 2/3 transfer.
  projectRouter?: RailSigner;
  /// Software cap per forward (cents); null = none.
  maxForwardCents: number | null;
  /// Where this tenant's outbound merchant webhooks go. null = nowhere. A
  /// tenant's events never fall back to another tenant's endpoint — that
  /// would hand its payers' IBANs and names to someone else's receiver.
  outboundWebhook: { url: string; secret: string } | null;
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

/// How the default tenant settles (ADR 0025). Unset/'forward' = the
/// pre-ADR-0017 router path, byte-identical. 'direct' = the payer's reference
/// makes Monerium mint straight into the project Safe and the env router key is
/// never loaded. Any other value is a typo we never validated → 'direct', the
/// mode that cannot sign (fail-closed).
export function legacyRailMode(env: Env): RailMode {
  return parseRailMode(env.LEGACY_RAIL_MODE?.trim()) ?? 'direct';
}

/// A ProjectRouter signer only when every piece is there; anything missing
/// means "no router" (D4 stays manual), never a half-configured signer. No
/// PaymentRegistry/MultiSend: the role allows neither (ADR 0026).
function projectRouterSigner(s: Omit<RailSigner, 'paymentRegistry' | 'multiSend'>): RailSigner | null {
  const v = (x: string) => x.trim();
  if (!v(s.safe) || !v(s.rolesModifier) || !v(s.roleKey) || !v(s.privateKey) || !v(s.eureContract)) return null;
  return { ...s, paymentRegistry: '', multiSend: '' };
}

/// The pre-ADR-0017 rail, read from env. Must stay byte-identical in effect
/// while LEGACY_RAIL_MODE is unset.
export function legacyRail(env: Env): TenantRail {
  const mode = legacyRailMode(env);
  const projectRouter = mode === 'direct'
    ? projectRouterSigner({
        chain: 'gnosis',
        rpcUrl: env.GNOSIS_RPC_URL || GNOSIS_RPC_DEFAULT,
        eureContract: env.EURE_CONTRACT ?? '',
        safe: env.SAFE_ADDRESS ?? '',
        rolesModifier: env.ROLES_MODIFIER_ADDRESS ?? '',
        roleKey: env.PROJECT_ROUTER_ROLE_KEY ?? '',
        privateKey: env.PROJECT_ROUTER_PRIVATE_KEY ?? '',
      })
    : null;
  return {
    tenantId: defaultTenantId(env),
    legacy: true,
    ...(mode === 'direct' ? { mode } : {}),
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
      // Direct mode never signs, so the router key is never even read.
      privateKey: mode === 'direct' ? '' : env.ROUTER_PRIVATE_KEY ?? '',
      paymentRegistry: mode === 'direct' ? '' : env.PAYMENT_REGISTRY_ADDRESS ?? '',
      multiSend: mode === 'direct' ? '' : env.MULTISEND_ADDRESS ?? '',
    },
    ...(projectRouter ? { projectRouter } : {}),
    maxForwardCents: null,
    outboundWebhook:
      env.INTENT_WEBHOOK_URL?.trim() && env.INTENT_WEBHOOK_SECRET?.trim()
        ? { url: env.INTENT_WEBHOOK_URL.trim(), secret: env.INTENT_WEBHOOK_SECRET.trim() }
        : null,
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
  /// Migration 0026; absent in fixtures written before it = 'forward'.
  mode?: string;
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
  const mode = parseRailMode(row.mode);
  if (!baseUrl || !chain || !mode) return null;
  if (row.auth_kind !== 'client_credentials') {
    // 'oauth' is modelled (refresh_token_enc) but not built yet — see ADR
    // 0017 open question 1. Refuse rather than half-work.
    return null;
  }
  const eure = row.eure_contract ?? (chain === 'gnosis' ? env.EURE_CONTRACT : '');
  if (!eure) return null; // chiado has no default EURe address
  const rpcUrl = row.rpc_url || (chain === 'gnosis' ? env.GNOSIS_RPC_URL || GNOSIS_RPC_DEFAULT : CHIADO_RPC_DEFAULT);
  // ADR 0026: in direct mode the row's role is ProjectRouter, and its router
  // key is loaded only when the role is configured too.
  const projectRouter = mode === 'direct' && row.roles_modifier && row.role_key && row.router_key_enc
    ? projectRouterSigner({
        chain,
        rpcUrl,
        eureContract: eure,
        safe: row.receiving_safe,
        rolesModifier: row.roles_modifier,
        roleKey: row.role_key,
        privateKey: await decrypt('router_key', row.router_key_enc),
      })
    : null;
  return {
    tenantId: row.tenant_id,
    legacy: false,
    mode,
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
      rpcUrl,
      eureContract: eure,
      safe: row.receiving_safe,
      rolesModifier: row.roles_modifier ?? '',
      roleKey: row.role_key ?? '',
      // A direct-mode rail never signs, so its router key is never even loaded.
      privateKey: mode === 'forward' && row.router_key_enc ? await decrypt('router_key', row.router_key_enc) : '',
      paymentRegistry: '',
      multiSend: '',
    },
    ...(projectRouter ? { projectRouter } : {}),
    maxForwardCents: row.max_forward_cents,
    outboundWebhook:
      row.outbound_webhook_url && row.outbound_webhook_secret_enc
        ? {
            url: row.outbound_webhook_url,
            secret: await decrypt('outbound_webhook_secret', row.outbound_webhook_secret_enc),
          }
        : null,
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
  return railFromStoredRow(env, row);
}

/// Decrypt a stored row into a rail, ignoring MULTI_TENANT_RAIL. Only the
/// admin onboarding flow uses this directly (it must register webhooks and
/// verify a tenant BEFORE the rail is switched on for it); everything on the
/// money path goes through `getTenantRail`.
export async function railFromStoredRow(env: Env, row: TenantRailRow): Promise<TenantRail | null> {
  try {
    const keks = await importKeks(env);
    return await railFromRow(env, row, async (field, blob) => {
      if (!blob) throw new Error(`missing ${field}`);
      return decryptSecret(keks, row.tenant_id, field, blob);
    });
  } catch (e) {
    console.error(`tenant ${row.tenant_id} rail unusable: ${(e as Error).message}`);
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

/// Payment reference for a direct-mode intent. Monerium mints to the address
/// when the description STARTS with `<chain>:<address>` followed by a space
/// (monerium-private.md „Usmjeravanje po memu"); the rail reads the sid from
/// the same text (monerium/sid.ts).
export function directReference(chain: RailChain, target: string, sid: string): string {
  return `${chain}:${target.toLowerCase()} sid:${sid}`;
}

/// What an intent's payment reference looks like, without decrypting any
/// secret (read on every status poll). Default tenant in forward mode and
/// tenants without a rail row: the `mpt:` reference, as before.
export interface ReferenceStyle {
  mode: RailMode;
  chain: RailChain;
}

export async function getReferenceStyle(env: Env, tenantId: string | null): Promise<ReferenceStyle | null> {
  if (!tenantId || isLegacyTenant(env, tenantId)) {
    return legacyRailMode(env) === 'direct' ? { mode: 'direct', chain: 'gnosis' } : null;
  }
  const row = await env.DB.prepare(`SELECT mode, chain FROM tenant_rail WHERE tenant_id = ?`)
    .bind(tenantId)
    .first<{ mode: string | null; chain: string }>();
  if (!row) return null;
  const mode = parseRailMode(row.mode);
  const chain = parseChain(row.chain);
  return mode && chain ? { mode, chain } : null;
}

export function intentReference(
  style: ReferenceStyle | null,
  intent: { target_address: string; sid: string },
): string {
  return style?.mode === 'direct'
    ? directReference(style.chain, intent.target_address, intent.sid)
    : `mpt:${intent.target_address}?sid=${intent.sid}`;
}
