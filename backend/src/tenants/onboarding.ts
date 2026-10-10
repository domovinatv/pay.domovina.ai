import { createPublicClient, getAddress, http, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { gnosis, gnosisChiado } from 'viem/chains';

import type { Env } from '../types';
import { MoneriumClient, type MoneriumIban } from '../monerium/client';
import { sendAlert } from '../alerts';
import { decryptSecret, encryptSecret, importKek, importKeks, type SecretField } from './secrets';
import { getTenant, type TenantRow } from './db';
import {
  getTenantRail,
  getTenantRailRow,
  legacyRail,
  listRailTenantIds,
  moneriumBaseUrl,
  parseChain,
  railFromStoredRow,
  type RailChain,
  type TenantRail,
  type TenantRailRow,
} from './rail';

/// Tenant onboarding for the multi-tenant rail (ADR 0017 §Admin). A tenant
/// is created `onboarding`, gets its Monerium credentials, a router EOA and a
/// webhook subscription, passes `verify`, and only then may be `activate`d.
/// Any change to the rail config resets verification.

export const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const IBAN_RE = /^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/;
const ROLE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
/// Same ceiling as the intent API (MAX_AMOUNT_CENTS in intents/api.ts).
const MAX_CAP_CENTS = 1_000_000;
/// Below this the router may not afford its next forwards: verify fails and
/// the 6-hourly cron alerts. Gnosis forwards cost ~0.0001 xDAI each.
export const MIN_ROUTER_GAS_WEI = 50_000_000_000_000_000n; // 0.05 xDAI

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

// ---- create ----------------------------------------------------------------

export interface CreateTenantInput {
  id: string;
  name: string;
  beneficiaryName: string;
  iban: string;
  bic: string | null;
}

export function validateCreateTenant(body: Record<string, unknown>): Validation<CreateTenantInput> {
  const id = str(body.id).toLowerCase();
  if (!TENANT_ID_RE.test(id)) return { ok: false, error: 'invalid_tenant_id' };
  const name = str(body.name);
  if (!name) return { ok: false, error: 'name_required' };
  const beneficiaryName = str(body.beneficiary_name) || name;
  const iban = normalizeIban(str(body.iban));
  if (!IBAN_RE.test(iban)) return { ok: false, error: 'invalid_iban' };
  const bic = str(body.bic).toUpperCase() || null;
  if (bic && !/^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(bic)) return { ok: false, error: 'invalid_bic' };
  return { ok: true, value: { id, name, beneficiaryName, iban, bic } };
}

export async function createTenant(env: Env, v: CreateTenantInput): Promise<'created' | 'exists'> {
  const t = now();
  const res = await env.DB.prepare(
    `INSERT INTO tenants
       (id, name, status, allow_sources, beneficiary_name, iban, bic, created_at, updated_at)
     VALUES (?, ?, 'onboarding', '[]', ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  )
    .bind(v.id, v.name, v.beneficiaryName, v.iban, v.bic, t, t)
    .run();
  return (res.meta?.changes ?? 0) > 0 ? 'created' : 'exists';
}

// ---- rail config -------------------------------------------------------------

export interface RailInput {
  moneriumEnv: 'production' | 'sandbox';
  chain: RailChain;
  clientId: string;
  /// null = keep the stored one.
  clientSecret: string | null;
  profileId: string;
  receivingSafe: string;
  rolesModifier: string | null;
  roleKey: string | null;
  eureContract: string | null;
  rpcUrl: string | null;
  outboundWebhookUrl: string | null;
  /// null = keep the stored one (only meaningful with a URL).
  outboundWebhookSecret: string | null;
  maxForwardCents: number | null;
}

function optAddress(v: unknown): string | null | 'invalid' {
  const s = str(v);
  if (!s) return null;
  return isAddress(s) ? s.toLowerCase() : 'invalid';
}

export function validateRailInput(
  body: Record<string, unknown>,
  existing: TenantRailRow | null,
): Validation<RailInput> {
  const moneriumEnv = str(body.monerium_env) || existing?.monerium_env || 'production';
  if (!moneriumBaseUrl(moneriumEnv)) return { ok: false, error: 'invalid_monerium_env' };
  const chain = parseChain(str(body.chain) || existing?.chain || 'gnosis');
  if (!chain) return { ok: false, error: 'invalid_chain' };
  const clientId = str(body.client_id);
  if (!clientId) return { ok: false, error: 'client_id_required' };
  const clientSecret = str(body.client_secret) || null;
  if (!clientSecret && !existing) return { ok: false, error: 'client_secret_required' };
  const profileId = str(body.profile_id);
  if (!profileId) return { ok: false, error: 'profile_id_required' };
  const receivingSafe = optAddress(body.receiving_safe);
  if (!receivingSafe || receivingSafe === 'invalid') return { ok: false, error: 'invalid_receiving_safe' };
  const rolesModifier = optAddress(body.roles_modifier);
  if (rolesModifier === 'invalid') return { ok: false, error: 'invalid_roles_modifier' };
  const roleKey = str(body.role_key) || null;
  if (roleKey && !ROLE_KEY_RE.test(roleKey)) return { ok: false, error: 'invalid_role_key' };
  const eureContract = optAddress(body.eure_contract);
  if (eureContract === 'invalid') return { ok: false, error: 'invalid_eure_contract' };
  if (chain === 'chiado' && !eureContract) return { ok: false, error: 'eure_contract_required_on_chiado' };
  const rpcUrl = str(body.rpc_url) || null;
  if (rpcUrl && !/^https:\/\//.test(rpcUrl)) return { ok: false, error: 'invalid_rpc_url' };
  const outboundWebhookUrl = str(body.outbound_webhook_url) || null;
  if (outboundWebhookUrl && !/^https:\/\//.test(outboundWebhookUrl)) {
    return { ok: false, error: 'invalid_outbound_webhook_url' };
  }
  const outboundWebhookSecret = str(body.outbound_webhook_secret) || null;
  if (outboundWebhookUrl && !outboundWebhookSecret && !existing?.outbound_webhook_secret_enc) {
    return { ok: false, error: 'outbound_webhook_secret_required' };
  }
  let maxForwardCents: number | null = null;
  if (body.max_forward_cents !== undefined && body.max_forward_cents !== null && body.max_forward_cents !== '') {
    const n = Number(body.max_forward_cents);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_CAP_CENTS) return { ok: false, error: 'invalid_max_forward_cents' };
    maxForwardCents = n;
  }
  return {
    ok: true,
    value: {
      moneriumEnv: moneriumEnv as 'production' | 'sandbox',
      chain,
      clientId,
      clientSecret,
      profileId,
      receivingSafe,
      rolesModifier,
      roleKey,
      eureContract,
      rpcUrl,
      outboundWebhookUrl,
      outboundWebhookSecret,
      maxForwardCents,
    },
  };
}

async function enc(env: Env, tenantId: string, field: SecretField, plaintext: string): Promise<string> {
  return encryptSecret(await importKek(env.TENANT_SECRETS_KEK), tenantId, field, plaintext);
}

const ENC_COLUMNS: Array<[column: string, field: SecretField]> = [
  ['client_secret_enc', 'client_secret'],
  ['refresh_token_enc', 'refresh_token'],
  ['router_key_enc', 'router_key'],
  ['webhook_secret_enc', 'webhook_secret'],
  ['outbound_webhook_secret_enc', 'outbound_webhook_secret'],
];

/// KEK rotation (MT-06): re-encrypt every stored secret of one tenant under
/// the CURRENT TENANT_SECRETS_KEK, reading with current-or-previous. Values
/// are unchanged, so the rail keeps working throughout. Returns how many
/// columns were rewritten.
export async function rewrapTenantSecrets(env: Env, tenantId: string): Promise<number> {
  const row = await getTenantRailRow(env, tenantId);
  if (!row) throw new Error('rail_not_found');
  const keks = await importKeks(env);
  const r = row as unknown as Record<string, string | null>;
  let n = 0;
  for (const [column, field] of ENC_COLUMNS) {
    const blob = r[column];
    if (!blob) continue;
    const plain = await decryptSecret(keks, tenantId, field, blob);
    const fresh = await encryptSecret(keks[0], tenantId, field, plain);
    await env.DB.prepare(`UPDATE tenant_rail SET ${column} = ?, updated_at = ? WHERE tenant_id = ?`)
      .bind(fresh, now(), tenantId)
      .run();
    n++;
  }
  return n;
}

/// Insert or update the tenant's rail. Secrets are encrypted here and never
/// stored or returned in clear. Any change clears the verification.
export async function upsertRail(env: Env, tenantId: string, v: RailInput, existing: TenantRailRow | null): Promise<void> {
  const t = now();
  const clientSecretEnc = v.clientSecret
    ? await enc(env, tenantId, 'client_secret', v.clientSecret)
    : existing!.client_secret_enc;
  const outboundSecretEnc = !v.outboundWebhookUrl
    ? null
    : v.outboundWebhookSecret
      ? await enc(env, tenantId, 'outbound_webhook_secret', v.outboundWebhookSecret)
      : existing?.outbound_webhook_secret_enc ?? null;
  await env.DB.prepare(
    `INSERT INTO tenant_rail
       (tenant_id, monerium_env, chain, auth_kind, client_id, client_secret_enc,
        profile_id, receiving_safe, roles_modifier, role_key, eure_contract, rpc_url,
        outbound_webhook_url, outbound_webhook_secret_enc, max_forward_cents,
        verified_at, verify_report, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'client_credentials', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, NULL, ?15, ?15)
     ON CONFLICT(tenant_id) DO UPDATE SET
       monerium_env = excluded.monerium_env,
       chain = excluded.chain,
       client_id = excluded.client_id,
       client_secret_enc = excluded.client_secret_enc,
       profile_id = excluded.profile_id,
       receiving_safe = excluded.receiving_safe,
       roles_modifier = excluded.roles_modifier,
       role_key = excluded.role_key,
       eure_contract = excluded.eure_contract,
       rpc_url = excluded.rpc_url,
       outbound_webhook_url = excluded.outbound_webhook_url,
       outbound_webhook_secret_enc = excluded.outbound_webhook_secret_enc,
       max_forward_cents = excluded.max_forward_cents,
       verified_at = NULL,
       verify_report = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(
      tenantId,
      v.moneriumEnv,
      v.chain,
      v.clientId,
      clientSecretEnc,
      v.profileId,
      v.receivingSafe,
      v.rolesModifier,
      v.roleKey,
      v.eureContract,
      v.rpcUrl,
      v.outboundWebhookUrl,
      outboundSecretEnc,
      v.maxForwardCents,
      t,
    )
    .run();
}

/// What the admin UI may see of a rail: never a secret, only whether it is set.
export function redactRail(row: TenantRailRow): Record<string, unknown> {
  return {
    tenant_id: row.tenant_id,
    monerium_env: row.monerium_env,
    chain: row.chain,
    auth_kind: row.auth_kind,
    client_id: row.client_id,
    has_client_secret: Boolean(row.client_secret_enc),
    profile_id: row.profile_id,
    receiving_safe: row.receiving_safe,
    roles_modifier: row.roles_modifier,
    role_key: row.role_key,
    router_address: row.router_address,
    has_router_key: Boolean(row.router_key_enc),
    eure_contract: row.eure_contract,
    rpc_url: row.rpc_url,
    has_webhook_secret: Boolean(row.webhook_secret_enc),
    webhook_subscription_id: row.webhook_subscription_id,
    outbound_webhook_url: row.outbound_webhook_url,
    has_outbound_webhook_secret: Boolean(row.outbound_webhook_secret_enc),
    max_forward_cents: row.max_forward_cents,
    verified_at: row.verified_at,
    verify_report: row.verify_report ? (JSON.parse(row.verify_report) as unknown) : null,
    updated_at: row.updated_at,
  };
}

// ---- router EOA ----------------------------------------------------------------

/// Generate the tenant's own router EOA. The key is encrypted at once and
/// never leaves the rail; only the address is returned (it goes into batch
/// safe-tx/007 and into the tenant's terms).
export async function generateRouterKey(env: Env, tenantId: string): Promise<string> {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  await env.DB.prepare(
    `UPDATE tenant_rail
        SET router_address = ?, router_key_enc = ?, verified_at = NULL, verify_report = NULL, updated_at = ?
      WHERE tenant_id = ?`,
  )
    .bind(address.toLowerCase(), await enc(env, tenantId, 'router_key', pk), now(), tenantId)
    .run();
  return address;
}

// ---- inbound Monerium webhook --------------------------------------------------

export function webhookUrlFor(origin: string, tenantId: string): string {
  return `${origin.replace(/\/+$/, '')}/api/monerium/webhook/t/${tenantId}`;
}

function newWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `whsec_${btoa(bin)}`;
}

/// Create the tenant's Monerium webhook subscription with the TENANT's own
/// credentials. The secret is stored before registering, because Monerium may
/// deliver `subscription.created` immediately and the route verifies with it.
export async function registerTenantWebhook(
  env: Env,
  tenantId: string,
  origin: string,
): Promise<{ url: string; subscriptionId: string; typesApplied: boolean; disabledPrevious: string | null }> {
  // MT-05: the previous subscription would keep delivering every event signed
  // with the OLD secret (→ 401 + 12 h of Monerium retries). Disable it first;
  // best effort — a failure is logged and reported, not fatal.
  let disabledPrevious: string | null = null;
  const before = await getTenantRailRow(env, tenantId);
  if (before?.webhook_subscription_id) {
    const prevRail = await railFromStoredRow(env, before);
    try {
      if (!prevRail) throw new Error('rail unusable');
      await new MoneriumClient(env, prevRail.monerium).disableWebhookSubscription(before.webhook_subscription_id);
      disabledPrevious = before.webhook_subscription_id;
    } catch (e) {
      console.error(`tenant ${tenantId}: disabling webhook ${before.webhook_subscription_id} failed: ${(e as Error).message}`);
    }
  }
  const secret = newWebhookSecret();
  await env.DB.prepare(
    `UPDATE tenant_rail
        SET webhook_secret_enc = ?, webhook_subscription_id = NULL,
            verified_at = NULL, verify_report = NULL, updated_at = ?
      WHERE tenant_id = ?`,
  )
    .bind(await enc(env, tenantId, 'webhook_secret', secret), now(), tenantId)
    .run();
  const row = await getTenantRailRow(env, tenantId);
  const rail = row ? await railFromStoredRow(env, row) : null;
  if (!rail) throw new Error('tenant rail unusable (check KEK / config)');
  const url = webhookUrlFor(origin, tenantId);
  const sub = await new MoneriumClient(env, rail.monerium).createWebhookSubscription({ url, secret });
  await env.DB.prepare(`UPDATE tenant_rail SET webhook_subscription_id = ?, updated_at = ? WHERE tenant_id = ?`)
    .bind(sub.id, now(), tenantId)
    .run();
  // typesApplied false: the subscription exists with Monerium's default
  // types; verify's webhook check shows it, re-register to fix.
  return { url, subscriptionId: sub.id, typesApplied: sub.typesApplied !== false, disabledPrevious };
}

// ---- verify ----------------------------------------------------------------------

export interface VerifyCheck {
  key: string;
  ok: boolean;
  detail: string;
}

/// Everything verify reads from the outside world, injected for tests.
export interface VerifyDeps {
  authProfiles(): Promise<string[]>;
  listIbans(profileId: string): Promise<MoneriumIban[]>;
  getCode(address: string): Promise<string | undefined>;
  isModuleEnabled(safe: string, module: string): Promise<boolean>;
  /// Every module enabled on the Safe (first page of 20 is plenty — more
  /// than one is already a finding).
  listModules(safe: string): Promise<string[]>;
  avatar(module: string): Promise<string>;
  target(module: string): Promise<string>;
  balanceWei(address: string): Promise<bigint>;
  activeWhitelistCount(): Promise<number>;
}

const SAFE_ABI = parseAbi([
  'function isModuleEnabled(address module) view returns (bool)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);
/// Safe's linked-list sentinel for getModulesPaginated.
const SENTINEL_MODULES = '0x0000000000000000000000000000000000000001';
const MODIFIER_ABI = parseAbi([
  'function avatar() view returns (address)',
  'function target() view returns (address)',
]);

export function makeVerifyDeps(env: Env, tenantId: string, rail: Pick<TenantRail, 'monerium' | 'signer'>): VerifyDeps {
  const client = new MoneriumClient(env, rail.monerium);
  const chain = createPublicClient({
    chain: rail.signer.chain === 'chiado' ? gnosisChiado : gnosis,
    transport: http(rail.signer.rpcUrl),
  });
  return {
    authProfiles: async () => {
      const ctx = await client.getAuthContext();
      const ids = new Set<string>();
      for (const p of ctx.profiles ?? []) if (p?.id) ids.add(p.id);
      if (typeof ctx.defaultProfile === 'string') ids.add(ctx.defaultProfile);
      if (typeof ctx.profile === 'string') ids.add(ctx.profile);
      if (ids.size === 0) for (const p of await client.listProfiles()) ids.add(p.id);
      return [...ids];
    },
    listIbans: (profileId) => client.listIbans(profileId),
    getCode: (address) => chain.getCode({ address: address as Address }),
    isModuleEnabled: (safe, module) =>
      chain.readContract({ address: safe as Address, abi: SAFE_ABI, functionName: 'isModuleEnabled', args: [module as Address] }),
    listModules: async (safe) => {
      const [modules] = await chain.readContract({
        address: safe as Address,
        abi: SAFE_ABI,
        functionName: 'getModulesPaginated',
        args: [SENTINEL_MODULES as Address, 20n],
      });
      return modules.map((m) => m.toLowerCase());
    },
    avatar: (module) => chain.readContract({ address: module as Address, abi: MODIFIER_ABI, functionName: 'avatar' }),
    target: (module) => chain.readContract({ address: module as Address, abi: MODIFIER_ABI, functionName: 'target' }),
    balanceWei: (address) => chain.getBalance({ address: address as Address }),
    activeWhitelistCount: async () => {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM tenant_payout_addresses WHERE tenant_id = ? AND revoked_at IS NULL`,
      )
        .bind(tenantId)
        .first<{ n: number }>();
      return r?.n ?? 0;
    },
  };
}

function sameAddr(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/// Read-only checks that must ALL pass before a tenant can be activated.
/// Each check is isolated: one failing (or throwing) never hides the others.
export async function runVerify(
  deps: VerifyDeps,
  tenant: Pick<TenantRow, 'iban'>,
  row: TenantRailRow,
  hasRouterKey: boolean,
): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  const check = async (key: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      checks.push({ key, ok, detail });
    } catch (e) {
      checks.push({ key, ok: false, detail: `error: ${(e as Error).message.slice(0, 200)}` });
    }
  };
  const safe = row.receiving_safe;

  await check('monerium_profile', async () => {
    const ids = await deps.authProfiles();
    return ids.includes(row.profile_id)
      ? [true, `token radi, profil ${row.profile_id} dostupan`]
      : [false, `token radi, ali profil ${row.profile_id} nije među: ${ids.join(', ') || '-'}`];
  });
  await check('iban_linked_to_safe', async () => {
    const ibans = await deps.listIbans(row.profile_id);
    const want = normalizeIban(tenant.iban);
    const hit = ibans.find((i) => normalizeIban(i.iban ?? '') === want);
    if (!hit) return [false, `IBAN ${want} nije na profilu (${ibans.map((i) => i.iban).join(', ') || 'nema IBAN-a'})`];
    if (!sameAddr(hit.address, safe)) return [false, `IBAN mint ide na ${hit.address ?? '-'}, ne na prihvatni Safe ${safe}`];
    if (hit.chain && hit.chain !== row.chain) return [false, `IBAN je na lancu ${hit.chain}, rail je ${row.chain}`];
    return [true, `IBAN ${want} → ${safe} (${hit.chain ?? row.chain})`];
  });
  await check('safe_deployed', async () => {
    const code = await deps.getCode(safe);
    return code && code !== '0x' ? [true, 'Safe ima kod na lancu'] : [false, 'na adresi nema ugovora (nedeployan Safe)'];
  });
  await check('roles_modifier', async () => {
    if (!row.roles_modifier) return [false, 'roles_modifier nije upisan'];
    const [enabled, av, tg] = await Promise.all([
      deps.isModuleEnabled(safe, row.roles_modifier),
      deps.avatar(row.roles_modifier),
      deps.target(row.roles_modifier),
    ]);
    if (!enabled) return [false, 'Modifier nije uključen kao modul na Safeu'];
    if (!sameAddr(av, safe) || !sameAddr(tg, safe)) return [false, `avatar ${av} / target ${tg} ≠ Safe ${safe}`];
    return [true, 'uključen modul, avatar = target = Safe'];
  });
  // TD-05: any other module can move EURe out of the Safe without the role
  // (the theft detector would at least shout 🚨 module_unknown, but only after).
  await check('only_module_is_roles', async () => {
    if (!row.roles_modifier) return [false, 'roles_modifier nije upisan'];
    const modules = await deps.listModules(safe);
    const others = modules.filter((m) => !sameAddr(m, row.roles_modifier));
    return others.length === 0
      ? [true, 'jedini modul na Safeu je Roles modifier']
      : [false, `Safe ima i druge module: ${others.join(', ')} — ukloniti (disableModule) prije aktivacije`];
  });
  await check('role_key', async () =>
    row.role_key ? [true, row.role_key] : [false, 'role_key nije upisan'],
  );
  await check('router_gas', async () => {
    if (!row.router_address || !hasRouterKey) return [false, 'router EOA nije generiran'];
    const bal = await deps.balanceWei(row.router_address);
    return bal >= MIN_ROUTER_GAS_WEI
      ? [true, `${row.router_address}: ${bal} wei`]
      : [false, `${row.router_address} ima ${bal} wei, treba ≥ ${MIN_ROUTER_GAS_WEI}`];
  });
  await check('webhook', async () =>
    row.webhook_secret_enc && row.webhook_subscription_id
      ? [true, `pretplata ${row.webhook_subscription_id}`]
      : [false, 'webhook nije registriran (POST …/rail/webhook)'],
  );
  await check('whitelist', async () => {
    const n = await deps.activeWhitelistCount();
    return n > 0 ? [true, `${n} aktivnih adresa`] : [false, 'whitelista tenanta je prazna'];
  });
  await check('forward_cap', async () =>
    row.max_forward_cents
      ? [true, `< ${(row.max_forward_cents / 100).toFixed(2)} EUR po forwardu`]
      : [false, 'max_forward_cents nije upisan (mora odgovarati on-chain kapici iz batcha 007)'],
  );
  return checks;
}

export async function saveVerifyReport(env: Env, tenantId: string, checks: VerifyCheck[]): Promise<boolean> {
  const allOk = checks.length > 0 && checks.every((c) => c.ok);
  await env.DB.prepare(
    `UPDATE tenant_rail SET verify_report = ?, verified_at = ?, updated_at = ? WHERE tenant_id = ?`,
  )
    .bind(
      JSON.stringify({
        checks,
        manual: 'Scope uloge (primatelji + kapica) provjerava se simulacijom na forku — safe-tx/007 §Verifikacija.',
      }),
      allOk ? now() : null,
      now(),
      tenantId,
    )
    .run();
  return allOk;
}

// ---- status transitions --------------------------------------------------------

export type Transition = 'activate' | 'suspend' | 'resume';

/// Pure transition table. Activation and resume both require a passed verify.
export function nextStatus(
  current: TenantRow['status'],
  transition: Transition,
  verified: boolean,
): { ok: true; status: TenantRow['status'] } | { ok: false; error: string } {
  if (transition === 'suspend') {
    return current === 'active' ? { ok: true, status: 'suspended' } : { ok: false, error: `cannot_suspend_${current}` };
  }
  if (!verified) return { ok: false, error: 'rail_not_verified' };
  if (transition === 'activate') {
    return current === 'onboarding' ? { ok: true, status: 'active' } : { ok: false, error: `cannot_activate_${current}` };
  }
  return current === 'suspended' ? { ok: true, status: 'active' } : { ok: false, error: `cannot_resume_${current}` };
}

export async function setTenantStatus(env: Env, tenantId: string, status: TenantRow['status']): Promise<void> {
  await env.DB.prepare(`UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?`)
    .bind(status, now(), tenantId)
    .run();
}

export async function loadTenantAndRail(
  env: Env,
  tenantId: string,
): Promise<{ tenant: TenantRow | null; row: TenantRailRow | null }> {
  const [tenant, row] = await Promise.all([getTenant(env, tenantId), getTenantRailRow(env, tenantId)]);
  return { tenant, row };
}

// ---- cron: router gas ------------------------------------------------------------

/// 6-hourly: alert when a tenant's router EOA runs low on xDAI. A router
/// without gas turns every forward into `failed` + a manual retry.
export async function checkRouterGas(env: Env): Promise<number> {
  let low = 0;
  // MT-07: ITalk's router too — it carries all live traffic today.
  for (const tenantId of [null, ...(await listRailTenantIds(env))]) {
    try {
      const rail = tenantId === null ? legacyRail(env) : await getTenantRail(env, tenantId);
      if (!rail?.signer.privateKey) continue;
      const address = privateKeyToAccount(rail.signer.privateKey as Hex).address;
      const chain = createPublicClient({
        chain: rail.signer.chain === 'chiado' ? gnosisChiado : gnosis,
        transport: http(rail.signer.rpcUrl),
      });
      const bal = await chain.getBalance({ address });
      if (bal < MIN_ROUTER_GAS_WEI) {
        low++;
        await sendAlert(
          env,
          `⛽ <b>Router tenanta ostaje bez gasa</b>\n` +
            `tenant: <code>${rail.tenantId}</code> · router: <code>${getAddress(address)}</code>\n` +
            `saldo: <code>${bal}</code> wei (prag ${MIN_ROUTER_GAS_WEI}). Dopuniti xDAI.`,
        );
      }
    } catch (e) {
      console.error(`router gas check ${tenantId ?? 'legacy'}: ${(e as Error).message}`);
    }
  }
  return low;
}
