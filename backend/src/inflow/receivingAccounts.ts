import type { Env } from '../types';
import { decryptSecret, encryptSecret, importKek, importKeks } from '../tenants/secrets';

/// ADR 0032 §3: a tenant's account at a provider. Credentials are always the
/// tenant's (or the partner project's for a BaaS like Swan), encrypted like
/// the rail secrets (AES-GCM, KEK in TENANT_SECRETS_KEK).

export interface ReceivingAccountRow {
  id: number;
  tenant_id: string;
  provider: string;
  mode: 'onchain_mint' | 'fiat_notify';
  iban: string | null;
  environment: 'sandbox' | 'live';
  external_account_id: string | null;
  client_id: string | null;
  client_secret_enc: string | null;
  webhook_secret_enc: string | null;
  label: string | null;
  active: number;
  created_at: number;
}

export interface ReceivingAccount {
  id: number;
  tenantId: string;
  provider: string;
  mode: 'onchain_mint' | 'fiat_notify';
  iban: string | null;
  environment: 'sandbox' | 'live';
  externalAccountId: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
}

export async function listActiveReceivingAccounts(
  env: Env,
  tenantId: string,
  provider: string,
): Promise<ReceivingAccountRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM receiving_accounts WHERE tenant_id = ? AND provider = ? AND active = 1 ORDER BY id`,
  )
    .bind(tenantId, provider)
    .all<ReceivingAccountRow>();
  return res.results;
}

export async function decryptReceivingAccount(env: Env, row: ReceivingAccountRow): Promise<ReceivingAccount> {
  const keks = row.client_secret_enc || row.webhook_secret_enc ? await importKeks(env) : [];
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    mode: row.mode,
    iban: row.iban,
    environment: row.environment,
    externalAccountId: row.external_account_id,
    clientId: row.client_id,
    clientSecret: row.client_secret_enc
      ? await decryptSecret(keks, row.tenant_id, 'client_secret', row.client_secret_enc)
      : null,
    webhookSecret: row.webhook_secret_enc
      ? await decryptSecret(keks, row.tenant_id, 'webhook_secret', row.webhook_secret_enc)
      : null,
  };
}

export interface CreateReceivingAccountArgs {
  tenantId: string;
  provider: string;
  mode: 'onchain_mint' | 'fiat_notify';
  iban?: string | null;
  environment: 'sandbox' | 'live';
  externalAccountId: string;
  clientId?: string | null;
  clientSecret?: string | null;
  webhookSecret?: string | null;
  label?: string | null;
}

export async function createReceivingAccount(env: Env, args: CreateReceivingAccountArgs): Promise<number> {
  const kek = args.clientSecret || args.webhookSecret ? await importKek(env.TENANT_SECRETS_KEK) : null;
  const enc = async (field: 'client_secret' | 'webhook_secret', v: string | null | undefined) =>
    v && kek ? encryptSecret(kek, args.tenantId, field, v) : null;
  const res = await env.DB.prepare(
    `INSERT INTO receiving_accounts
       (tenant_id, provider, mode, iban, environment, external_account_id, client_id,
        client_secret_enc, webhook_secret_enc, label, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
  )
    .bind(
      args.tenantId,
      args.provider,
      args.mode,
      args.iban ? args.iban.replace(/\s+/g, '').toUpperCase() : null,
      args.environment,
      args.externalAccountId,
      args.clientId ?? null,
      await enc('client_secret', args.clientSecret),
      await enc('webhook_secret', args.webhookSecret),
      args.label ?? null,
      Math.floor(Date.now() / 1000),
    )
    .run();
  return Number(res.meta?.last_row_id ?? 0);
}

/// Constant-time string comparison (webhook shared secrets).
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
