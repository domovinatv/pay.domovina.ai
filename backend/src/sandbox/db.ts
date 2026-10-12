import type { Env } from '../types';
import { decryptSecret, encryptSecret, importKek, importKeks } from '../tenants/secrets';
import { generateApiKey } from '../tenants/auth';
import { hashApiKey, insertApiKey } from '../tenants/db';

/// Self-serve sandbox tenants (ADR 0024 D1/D3). A sandbox tenant is a
/// `tenants` row with sandbox = 1 and NO tenant_rail row, so it never reaches
/// Monerium, a chain or a signer: getTenantRail returns null for it and every
/// money path refuses. What it has instead lives in `sandbox_tenants`.

export const SANDBOX_TTL_S = 90 * 86_400;
/// Tenants one IP may create per 24 h.
export const SANDBOX_PER_IP_PER_DAY = 5;
/// Active sandbox tenants rail-wide, unless SANDBOX_MAX_TENANTS says otherwise.
export const SANDBOX_MAX_TENANTS_DEFAULT = 500;
/// Never shown anywhere (sandbox intents return iban: null); only satisfies
/// tenants.iban NOT NULL. Deliberately not a valid IBAN.
export const SANDBOX_IBAN_PLACEHOLDER = 'XX00SANDBOX0000000000';

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function newSandboxTenantId(): string {
  return `sbx-${randomHex(5)}`;
}

/// Same shape as the inbound Monerium secret (onboarding.ts newWebhookSecret).
export function newOutboundWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `whsec_${btoa(bin)}`;
}

export function sandboxEnabled(env: Env): boolean {
  return (env.SANDBOX_SELF_SERVE ?? '').trim() === '1';
}

export function maxSandboxTenants(env: Env): number {
  const n = Number(env.SANDBOX_MAX_TENANTS);
  return Number.isInteger(n) && n > 0 ? n : SANDBOX_MAX_TENANTS_DEFAULT;
}

/// HMAC of the caller IP: enough to count, never stored in clear.
export async function hashIp(env: Env, ip: string): Promise<string> {
  const pepper = env.SANDBOX_IP_PEPPER || env.PHONE_PEPPER || 'mpt-sandbox';
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`sandbox-ip:${ip}`));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function isSandboxTenant(env: Env, tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  const row = await env.DB.prepare(`SELECT sandbox FROM tenants WHERE id = ? AND sandbox = 1`)
    .bind(tenantId)
    .first<{ sandbox: number }>();
  return row?.sandbox === 1;
}

export async function countRecentByIp(env: Env, ipHash: string, since: number): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sandbox_tenants WHERE created_ip_hash = ? AND created_at > ?`,
  )
    .bind(ipHash, since)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function countActiveSandboxTenants(env: Env): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM sandbox_tenants WHERE expires_at > ?`)
    .bind(now())
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface CreatedSandbox {
  tenantId: string;
  secretKey: string;
  publicKey: string;
  webhookSecret: string;
  webhookUrl: string | null;
  expiresAt: number;
}

export async function createSandboxTenant(
  env: Env,
  args: { name: string; webhookUrl: string | null; ipHash: string },
): Promise<CreatedSandbox> {
  const t = now();
  const tenantId = newSandboxTenantId();
  const webhookSecret = newOutboundWebhookSecret();
  const secretEnc = await encryptSecret(
    await importKek(env.TENANT_SECRETS_KEK), tenantId, 'outbound_webhook_secret', webhookSecret,
  );
  const expiresAt = t + SANDBOX_TTL_S;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tenants
         (id, name, status, allow_sources, beneficiary_name, iban, bic, created_at, updated_at, sandbox)
       VALUES (?, ?, 'active', '[]', ?, ?, NULL, ?, ?, 1)`,
    ).bind(tenantId, args.name, args.name, SANDBOX_IBAN_PLACEHOLDER, t, t),
    env.DB.prepare(
      `INSERT INTO sandbox_tenants
         (tenant_id, outbound_webhook_url, outbound_webhook_secret_enc, created_ip_hash,
          created_at, last_active_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(tenantId, args.webhookUrl, secretEnc, args.ipHash, t, t, expiresAt),
  ]);
  const secretKey = generateApiKey('secret', { test: true });
  const publicKey = generateApiKey('public', { test: true });
  await insertApiKey(env, { tenantId, keyHash: await hashApiKey(secretKey), kind: 'secret', label: 'sandbox self-serve' });
  await insertApiKey(env, { tenantId, keyHash: await hashApiKey(publicKey), kind: 'public', label: 'sandbox self-serve' });
  return { tenantId, secretKey, publicKey, webhookSecret, webhookUrl: args.webhookUrl, expiresAt };
}

/// Replace the webhook URL, optionally rotating the secret. Returns the new
/// secret when rotated, null otherwise.
export async function updateSandboxWebhook(
  env: Env,
  tenantId: string,
  args: { webhookUrl: string | null; rotateSecret: boolean },
): Promise<string | null> {
  const t = now();
  let secret: string | null = null;
  if (args.rotateSecret) {
    secret = newOutboundWebhookSecret();
    const enc = await encryptSecret(await importKek(env.TENANT_SECRETS_KEK), tenantId, 'outbound_webhook_secret', secret);
    await env.DB.prepare(
      `UPDATE sandbox_tenants SET outbound_webhook_url = ?, outbound_webhook_secret_enc = ?,
              last_active_at = ?, expires_at = ? WHERE tenant_id = ?`,
    ).bind(args.webhookUrl, enc, t, t + SANDBOX_TTL_S, tenantId).run();
  } else {
    await env.DB.prepare(
      `UPDATE sandbox_tenants SET outbound_webhook_url = ?, last_active_at = ?, expires_at = ? WHERE tenant_id = ?`,
    ).bind(args.webhookUrl, t, t + SANDBOX_TTL_S, tenantId).run();
  }
  return secret;
}

/// Activity (intent created, payment simulated) pushes expiry out.
export async function touchSandboxTenant(env: Env, tenantId: string): Promise<void> {
  const t = now();
  await env.DB.prepare(`UPDATE sandbox_tenants SET last_active_at = ?, expires_at = ? WHERE tenant_id = ?`)
    .bind(t, t + SANDBOX_TTL_S, tenantId)
    .run();
}

/// The outbound endpoint of a sandbox tenant, or null (not a sandbox tenant,
/// no URL set, or a secret that will not decrypt).
export async function sandboxEndpoint(
  env: Env,
  tenantId: string,
): Promise<{ url: string; secret: string } | null> {
  const row = await env.DB.prepare(
    `SELECT s.tenant_id, s.outbound_webhook_url, s.outbound_webhook_secret_enc
       FROM sandbox_tenants s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.tenant_id = ? AND t.sandbox = 1`,
  )
    .bind(tenantId)
    .first<{ tenant_id: string; outbound_webhook_url: string | null; outbound_webhook_secret_enc: string }>();
  if (!row || row.tenant_id !== tenantId || !row.outbound_webhook_url) return null;
  try {
    const secret = await decryptSecret(await importKeks(env), tenantId, 'outbound_webhook_secret', row.outbound_webhook_secret_enc);
    return { url: row.outbound_webhook_url, secret };
  } catch (e) {
    console.error(`sandbox ${tenantId}: webhook secret unusable: ${(e as Error).message}`);
    return null;
  }
}

/// Simulations of one tenant in the last 24 h (forward rows it got).
export async function countRecentSimulations(env: Env, tenantId: string, since: number): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM monerium_orders WHERE tenant_id = ? AND id LIKE 'sim\\_%' ESCAPE '\\' AND updated_at > ?`,
  )
    .bind(tenantId, since)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/// Cron: delete expired sandbox tenants with everything they own. Sandbox rows
/// carry no money, so nothing here needs to be kept.
export async function sweepExpiredSandboxTenants(env: Env, limit = 50): Promise<number> {
  const res = await env.DB.prepare(
    `SELECT s.tenant_id FROM sandbox_tenants s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.expires_at <= ? AND t.sandbox = 1 LIMIT ?`,
  )
    .bind(now(), limit)
    .all<{ tenant_id: string }>();
  for (const { tenant_id: id } of res.results) {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM webhook_outbox WHERE tenant_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM monerium_forwards WHERE tenant_id = ? AND error = 'simulated'`).bind(id),
      env.DB.prepare(`DELETE FROM monerium_orders WHERE tenant_id = ? AND id LIKE 'sim\\_%' ESCAPE '\\'`).bind(id),
      env.DB.prepare(`DELETE FROM payment_intents WHERE tenant_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM tenant_api_keys WHERE tenant_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM sandbox_tenants WHERE tenant_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM tenants WHERE id = ? AND sandbox = 1`).bind(id),
    ]);
  }
  return res.results.length;
}
