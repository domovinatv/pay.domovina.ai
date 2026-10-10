import { decryptSecret, encryptSecret, secretAad } from './crypto';
import { now } from './db';
import type { Env } from './types';

/// Shopify app credentials. One worker serves many apps: a custom-distribution
/// app can be installed on exactly one store, so each merchant gets its own
/// app (own client id + secret, registered via /admin/apps). An optional shared
/// app from env (SHOPIFY_API_KEY / SHOPIFY_API_SECRET) covers an unlisted
/// public app installable on any store.
export interface AppCreds {
  clientId: string;
  secret: string;
  /// The only shop this app may act for; null for the shared app.
  shop: string | null;
}

export interface AppRow {
  client_id: string;
  shop: string;
  client_secret_enc: string;
  label: string | null;
  created_at: number;
  updated_at: number;
}

export const CLIENT_ID_RE = /^[A-Za-z0-9]{16,64}$/;

/// The shared app, when env holds a real client id + secret (not the
/// placeholder from wrangler.toml).
export function sharedApp(env: Env): AppCreds | null {
  const id = env.SHOPIFY_API_KEY?.trim();
  const secret = env.SHOPIFY_API_SECRET?.trim();
  if (!id || !secret || !CLIENT_ID_RE.test(id)) return null;
  return { clientId: id, secret, shop: null };
}

async function fromRow(env: Env, row: AppRow | null): Promise<AppCreds | null> {
  if (!row) return null;
  return { clientId: row.client_id, secret: await decryptSecret(env.TOKEN_KEK, row.client_secret_enc, secretAad('apps', row.client_id, 'client_secret')), shop: row.shop };
}

export async function appByClientId(env: Env, clientId: string): Promise<AppCreds | null> {
  const shared = sharedApp(env);
  if (shared && shared.clientId === clientId) return shared;
  return fromRow(env, await env.DB.prepare('SELECT * FROM apps WHERE client_id = ?').bind(clientId).first<AppRow>());
}

/// Every app that may legitimately sign a request for this shop: its own
/// custom-distribution app first, then the shared one. Requests that do not
/// name their app (install query, webhooks) are matched by whichever secret
/// verifies the signature.
export async function appsForShop(env: Env, shop: string): Promise<AppCreds[]> {
  const own = await fromRow(env, await env.DB.prepare('SELECT * FROM apps WHERE shop = ?').bind(shop).first<AppRow>());
  const shared = sharedApp(env);
  const out: AppCreds[] = [];
  if (own) out.push(own);
  if (shared && shared.clientId !== own?.clientId) out.push(shared);
  return out;
}

/// First app whose secret verifies `check`, or null.
export async function matchApp(apps: AppCreds[], check: (secret: string) => Promise<boolean>): Promise<AppCreds | null> {
  for (const a of apps) if (await check(a.secret)) return a;
  return null;
}

/// May this app act for this shop? A custom app only for its own store.
export function appServesShop(app: AppCreds, shop: string): boolean {
  return app.shop === null || app.shop === shop;
}

export async function upsertApp(env: Env, a: { clientId: string; shop: string; secret: string; label: string | null }): Promise<void> {
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO apps (client_id, shop, client_secret_enc, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       shop = excluded.shop,
       client_secret_enc = excluded.client_secret_enc,
       label = excluded.label,
       updated_at = excluded.updated_at`,
  )
    .bind(a.clientId, a.shop, await encryptSecret(env.TOKEN_KEK, a.secret, secretAad('apps', a.clientId, 'client_secret')), a.label, ts, ts)
    .run();
}

export async function listApps(env: Env): Promise<Omit<AppRow, 'client_secret_enc'>[]> {
  const res = await env.DB.prepare('SELECT client_id, shop, label, created_at, updated_at FROM apps ORDER BY created_at DESC').all<
    Omit<AppRow, 'client_secret_enc'>
  >();
  return res.results ?? [];
}

export async function deleteApp(env: Env, clientId: string): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM apps WHERE client_id = ?').bind(clientId).run();
  return (res.meta?.changes ?? 0) > 0;
}
