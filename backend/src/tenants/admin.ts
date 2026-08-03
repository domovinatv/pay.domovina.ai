import type { Hono } from 'hono';

import type { Env } from '../types';
import {
  addCampaign,
  addPayoutAddress,
  getTenant,
  hashApiKey,
  insertApiKey,
  listApiKeys,
  listAudit,
  listCampaigns,
  listPayoutAddresses,
  listTenants,
  revokeApiKey,
  revokeCampaign,
  revokePayoutAddress,
  whitelistSource,
  writeAudit,
} from './db';
import { generateApiKey } from './auth';
import { trySendAlert } from '../alerts';
import { renderWhitelistPage } from '../admin/views';

/// Admin surface for the tenant payout whitelist. Mounted under `/admin/*`,
/// which the existing Basic Auth middleware in ../admin/app.ts already gates —
/// there is no public route here by design.
///
/// Every mutation writes a tenant_audit_log row (who / when / which address),
/// with the actor taken from the Basic Auth username on the request.

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

/// Basic Auth username of the caller, for the audit trail. The middleware has
/// already verified the credentials — we only decode them for attribution.
function actorFrom(header: string | undefined): string {
  if (!header?.startsWith('Basic ')) return 'admin:unknown';
  try {
    const user = atob(header.slice(6)).split(':')[0];
    return `admin:${user || 'unknown'}`;
  } catch {
    return 'admin:unknown';
  }
}

export function mountTenantAdmin(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/whitelist', (c) => c.html(renderWhitelistPage()));

  app.get('/admin/api/tenants', async (c) => {
    const tenants = await listTenants(c.env);
    const enriched = await Promise.all(
      tenants.map(async (t) => ({
        ...t,
        address_count: (await listPayoutAddresses(c.env, t.id)).length,
        campaign_count: (await listCampaigns(c.env, t.id)).filter((r) => !r.revoked_at).length,
      })),
    );
    return c.json({ tenants: enriched });
  });

  app.get('/admin/api/tenants/:id/addresses', async (c) => {
    const tenantId = c.req.param('id');
    const includeRevoked = c.req.query('all') === '1';
    const rows = await listPayoutAddresses(c.env, tenantId, { includeRevoked });
    return c.json({ tenant_id: tenantId, addresses: rows });
  });

  app.post('/admin/api/tenants/:id/addresses', async (c) => {
    const tenantId = c.req.param('id');
    const tenant = await getTenant(c.env, tenantId);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);
    let body: { address?: string; label?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const address = (body.address ?? '').trim();
    if (!ADDR_RE.test(address)) return c.json({ error: 'invalid_address' }, 400);
    const actor = actorFrom(c.req.header('Authorization'));
    const label = (body.label ?? '').trim() || null;
    await addPayoutAddress(c.env, { tenantId, address, label, actor });
    await writeAudit(c.env, {
      tenantId,
      action: 'address.add',
      address: address.toLowerCase(),
      actor,
      detail: label,
    });
    return c.json({ ok: true, tenant_id: tenantId, address: address.toLowerCase() });
  });

  app.delete('/admin/api/tenants/:id/addresses/:address', async (c) => {
    const tenantId = c.req.param('id');
    const address = c.req.param('address');
    if (!ADDR_RE.test(address)) return c.json({ error: 'invalid_address' }, 400);
    const actor = actorFrom(c.req.header('Authorization'));
    const revoked = await revokePayoutAddress(c.env, { tenantId, address, actor });
    if (!revoked) return c.json({ error: 'not_found_or_already_revoked' }, 404);
    await writeAudit(c.env, {
      tenantId,
      action: 'address.revoke',
      address: address.toLowerCase(),
      actor,
    });
    return c.json({ ok: true });
  });

  /// "Would this address be allowed right now, and why?" — the check an
  /// operator runs before telling a customer their payment will work.
  app.get('/admin/api/tenants/:id/check/:address', async (c) => {
    const tenantId = c.req.param('id');
    const address = c.req.param('address');
    if (!ADDR_RE.test(address)) return c.json({ error: 'invalid_address' }, 400);
    const source = await whitelistSource(c.env, tenantId, address);
    return c.json({
      tenant_id: tenantId,
      address: address.toLowerCase(),
      allowed: source !== null,
      source,
    });
  });

  app.get('/admin/api/tenants/:id/campaigns', async (c) => {
    const rows = await listCampaigns(c.env, c.req.param('id'));
    return c.json({ tenant_id: c.req.param('id'), campaigns: rows });
  });

  app.post('/admin/api/tenants/:id/campaigns', async (c) => {
    const tenantId = c.req.param('id');
    const tenant = await getTenant(c.env, tenantId);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);
    let body: { campaign_id?: string; safe_address?: string; label?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const campaignId = (body.campaign_id ?? '').trim();
    const safeAddress = (body.safe_address ?? '').trim();
    if (!ID_RE.test(campaignId)) return c.json({ error: 'invalid_campaign_id' }, 400);
    if (!ADDR_RE.test(safeAddress)) return c.json({ error: 'invalid_safe_address' }, 400);
    const actor = actorFrom(c.req.header('Authorization'));
    const label = (body.label ?? '').trim() || null;
    await addCampaign(c.env, { tenantId, campaignId, safeAddress, label, actor });
    // A campaign Safe is a payout destination — register it on the whitelist
    // too, so the `cmp:` binding and the whitelist can never disagree.
    await addPayoutAddress(c.env, {
      tenantId,
      address: safeAddress,
      label: `campaign ${campaignId}${label ? ` — ${label}` : ''}`,
      actor,
    });
    await writeAudit(c.env, {
      tenantId,
      action: 'campaign.add',
      address: safeAddress.toLowerCase(),
      actor,
      detail: JSON.stringify({ campaign_id: campaignId, label }),
    });
    return c.json({ ok: true, campaign_id: campaignId, safe_address: safeAddress.toLowerCase() });
  });

  app.delete('/admin/api/tenants/:id/campaigns/:campaignId', async (c) => {
    const tenantId = c.req.param('id');
    const campaignId = c.req.param('campaignId');
    const actor = actorFrom(c.req.header('Authorization'));
    const revoked = await revokeCampaign(c.env, { campaignId, actor });
    if (!revoked) return c.json({ error: 'not_found_or_already_revoked' }, 404);
    await writeAudit(c.env, {
      tenantId,
      action: 'campaign.revoke',
      actor,
      detail: JSON.stringify({ campaign_id: campaignId }),
    });
    return c.json({ ok: true });
  });

  app.get('/admin/api/tenants/:id/keys', async (c) => {
    const rows = await listApiKeys(c.env, c.req.param('id'));
    // Never echo a full hash — it is the only secret-equivalent value stored.
    return c.json({
      tenant_id: c.req.param('id'),
      keys: rows.map((k) => ({
        key_hash_short: `${k.key_hash.slice(0, 12)}…`,
        kind: k.kind,
        label: k.label,
        created_at: k.created_at,
        revoked_at: k.revoked_at,
      })),
    });
  });

  /// Issues a key and returns the RAW value exactly once — it is never
  /// recoverable afterwards, only its sha256 is stored.
  app.post('/admin/api/tenants/:id/keys', async (c) => {
    const tenantId = c.req.param('id');
    const tenant = await getTenant(c.env, tenantId);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);
    let body: { kind?: string; label?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const kind = body.kind === 'secret' ? 'secret' : 'public';
    const raw = generateApiKey(kind);
    const keyHash = await hashApiKey(raw);
    const label = (body.label ?? '').trim() || null;
    await insertApiKey(c.env, { tenantId, keyHash, kind, label });
    const actor = actorFrom(c.req.header('Authorization'));
    await writeAudit(c.env, {
      tenantId,
      action: 'key.issue',
      actor,
      detail: JSON.stringify({ kind, label, key_hash_short: `${keyHash.slice(0, 12)}…` }),
    });
    return c.json({ ok: true, key: raw, kind, note: 'Spremi odmah — više se ne može pročitati.' });
  });

  app.delete('/admin/api/tenants/:id/keys/:keyHash', async (c) => {
    const keyHash = c.req.param('keyHash');
    if (!/^[0-9a-f]{64}$/.test(keyHash)) return c.json({ error: 'invalid_key_hash' }, 400);
    const revoked = await revokeApiKey(c.env, keyHash);
    if (!revoked) return c.json({ error: 'not_found_or_already_revoked' }, 404);
    await writeAudit(c.env, {
      tenantId: c.req.param('id'),
      action: 'key.revoke',
      actor: actorFrom(c.req.header('Authorization')),
      detail: JSON.stringify({ key_hash_short: `${keyHash.slice(0, 12)}…` }),
    });
    return c.json({ ok: true });
  });

  /// Proves the WHOLE alert chain from inside the Worker: secrets present,
  /// token valid, chat id reachable. A curl against api.telegram.org only
  /// proves the credentials work somewhere — not that they landed correctly in
  /// the Worker's secrets. Alerting is fail-open, so without this a broken
  /// chat id (e.g. after a group → supergroup migration silently changes the
  /// id) stays invisible until the first real blocked forward.
  app.post('/admin/api/alert-test', async (c) => {
    const actor = actorFrom(c.req.header('Authorization'));
    const result = await trySendAlert(
      c.env,
      '🔔 <b>MPT alert test</b>\n' +
        'Ovo je ručna provjera alert kanala — nije incident.\n' +
        `pokrenuo: <code>${actor}</code>`,
    );
    await writeAudit(c.env, {
      tenantId: null,
      action: 'alert.test',
      actor,
      detail: JSON.stringify(result),
    });
    if (!result.configured) {
      return c.json(
        {
          ...result,
          hint: 'TELEGRAM_BOT_TOKEN i/ili TELEGRAM_CHAT_ID nisu postavljeni — alerti idu samo u console.',
        },
        503,
      );
    }
    if (!result.ok) {
      return c.json(
        {
          ...result,
          hint: '"chat not found" najčešće znači da je grupa migrirala u supergrupu i promijenila id — ponovi getUpdates i prepiši TELEGRAM_CHAT_ID.',
        },
        502,
      );
    }
    return c.json(result);
  });

  app.get('/admin/api/tenants/audit', async (c) => {
    const rows = await listAudit(c.env, {
      tenantId: c.req.query('tenant') || undefined,
      limit: Number(c.req.query('limit')) || 100,
    });
    return c.json({ entries: rows });
  });
}
