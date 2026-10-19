import type { DatabaseSync } from 'node:sqlite';

import { encryptSecret, importKek } from '../../src/tenants/secrets';

/// ITalk is an ordinary tenant_rail row (migration 0030): tests that used to
/// get its rail from env seed this row instead. Same Safe and modifier as
/// production; secrets under a test KEK.
export const ITALK_KEK = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
export const ITALK_SAFE = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
export const ITALK_WEBHOOK_SECRET = 'whsec_' + btoa('italk-webhook-secret-32-bytes-ok');

export async function seedItalkRail(
  raw: DatabaseSync,
  over: { mode?: 'direct' | 'forward'; routerKey?: string; roleKey?: string; outbound?: { url: string; secret: string } } = {},
): Promise<{ MULTI_TENANT_RAIL: string; TENANT_SECRETS_KEK: string; EURE_CONTRACT: string }> {
  const kek = await importKek(ITALK_KEK);
  const enc = (field: Parameters<typeof encryptSecret>[2], v: string) => encryptSecret(kek, 'italk', field, v);
  raw.prepare(
    `INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id,
       receiving_safe, roles_modifier, role_key, router_key_enc, webhook_secret_enc, webhook_subscription_id,
       outbound_webhook_url, outbound_webhook_secret_enc, mode, created_at, updated_at)
     VALUES ('italk', 'production', 'gnosis', 'cid-italk', ?, 'prof-italk', ?, ?, ?, ?, ?, 'sub-italk', ?, ?, ?, 0, 0)`,
  ).run(
    await enc('client_secret', 'cs-italk'),
    ITALK_SAFE,
    '0x330347d656b1a5df972f758de1e25e99ec36762c',
    over.roleKey ?? '0x50726f6a656374526f7574657200000000000000000000000000000000000000',
    over.routerKey ? await enc('router_key', over.routerKey) : null,
    await enc('webhook_secret', ITALK_WEBHOOK_SECRET),
    over.outbound?.url ?? null,
    over.outbound ? await enc('outbound_webhook_secret', over.outbound.secret) : null,
    over.mode ?? 'direct',
  );
  return {
    MULTI_TENANT_RAIL: '1',
    TENANT_SECRETS_KEK: ITALK_KEK,
    EURE_CONTRACT: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
  };
}
