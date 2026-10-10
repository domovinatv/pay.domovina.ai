import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bearerAuth } from 'hono/bearer-auth';
import { HTTPException } from 'hono/http-exception';

import type { Env } from './types';
import { getProvider } from './providers';
import {
  getAccount,
  insertAuthorization,
  listAccounts,
  listAuthorizations,
  listTransactions,
  updateAuthorizationSession,
  upsertAccount,
  upsertTransactions,
} from './db';
import { MoneriumClient } from './monerium/client';
import { verifyWebhookSignature } from './monerium/webhook';
import {
  getMoneriumOrder,
  listMoneriumOrders,
  recordMoneriumWebhookEvent,
  upsertMoneriumOrder,
} from './monerium/db';
import { handleMoneriumWebhook, makeWebhookDeps } from './monerium/webhookHandler';
import { getTenantRail, isLegacyTenant, legacyRail, multiTenantEnabled } from './tenants/rail';
import { mountAdminUi } from './admin/app';
import { buildIntentApi, buildIntentStatus } from './intents/api';
import { buildWalletApi } from './wallets/api';
import { buildGnosisPayApi } from './gnosispay/api';
import { buildGnosisPayProxy } from './gnosispay/proxy';
import {
  getIntent,
  sweepExpiredIntents,
} from './intents/db';
import {
  makeConfirmDeps,
  reconcileSubmittedForwards,
} from './intents/confirm';
import { scanOnchainDonations } from './intents/onchainIndexer';
import { deliverDue, makeOutboxDeps } from './intents/outbox';
import { RECONCILE_INTERVAL_S, reconcileMoneriumOrders } from './monerium/reconcile';
import { fetchOgPreview } from './og/preview';
import { publishIntentChange } from './intents/stream';
import { checkRouterGas } from './tenants/onboarding';
import { watchAllRailOutflows } from './monerium/outflowWatch';
import { renderCheckoutPage } from './checkout/page';
import { getSepaDetails } from './tenants/db';
import { defaultTenantId } from './tenants/whitelist';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const origins = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const origin = origins.includes('*') ? '*' : origins;
  return cors({
    origin,
    // PUT/DELETE za GP proxy (daily-limit PUT, owners DELETE); ostale rute ih
    // jednostavno ne koriste.
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })(c, next);
});

app.get('/', (c) =>
  c.json({
    ok: true,
    name: 'pay.domovina.ai backend',
    bankingProvider: getProvider(c.env).name,
    moneriumConfigured: Boolean(c.env.MONERIUM_CLIENT_ID),
  }),
);

// ---- Public read endpoints ----

app.get('/api/hpb/accounts', async (c) => {
  const accounts = await listAccounts(c.env);
  return c.json({ accounts });
});

app.get('/api/hpb/transactions', async (c) => {
  const accountId = c.req.query('account_id');
  if (!accountId) return c.json({ error: 'account_id required' }, 400);
  const account = await getAccount(c.env, accountId);
  if (!account) return c.json({ error: 'account not found' }, 404);
  const transactions = await listTransactions(c.env, accountId);
  return c.json({ account, transactions });
});

app.get('/api/hpb/institutions', async (c) => {
  const country = c.req.query('country') ?? 'HR';
  const institutions = await getProvider(c.env).listInstitutions(country);
  return c.json({ institutions });
});

// ---- SCA callback (public; provider returns code+state here) ----

app.get('/api/hpb/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');
  const authorizationId = c.req.query('authorization_id') ?? state;
  if (error) {
    return c.html(scaPage(`SCA odbijena: ${error}`, false), 400);
  }
  if (!authorizationId) {
    return c.html(scaPage('Nedostaje authorization_id ili state', false), 400);
  }
  try {
    const provider = getProvider(c.env);
    const result = await provider.finalizeAuthorization({
      authorizationId,
      code: code ?? undefined,
    });
    if (result.sessionId) {
      await updateAuthorizationSession(
        c.env,
        authorizationId,
        result.sessionId,
        result.status,
      );
    }
    for (const acc of result.accounts) {
      await upsertAccount(c.env, {
        id: acc.id,
        authorizationId,
        provider: provider.name,
        account: acc,
      });
    }
    // First refresh fires asynchronously; user does not wait.
    c.executionCtx.waitUntil(refreshAccountsForAuthorization(c.env, authorizationId));
    return c.html(
      scaPage(
        `Račun povezan. Spojeno računa: ${result.accounts.length}.`,
        true,
      ),
    );
  } catch (e) {
    return c.html(
      scaPage(`Greška: ${(e as Error).message}`, false),
      500,
    );
  }
});

// ---- Monerium webhook (public, signature-verified) ----

/// A Monerium order event is a few KB. Anything bigger is not Monerium and is
/// refused before it reaches D1 (MT-04).
export const MAX_WEBHOOK_BODY_BYTES = 65_536;

async function readWebhookBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_WEBHOOK_BODY_BYTES) return null;
  const text = await req.text();
  return new TextEncoder().encode(text).length > MAX_WEBHOOK_BODY_BYTES ? null : text;
}

app.post('/api/monerium/webhook', async (c) => {
  // ITalk (default tenant): env secret, env rail — unchanged since ADR 0016.
  const rail = legacyRail(c.env);
  const rawBody = await readWebhookBody(c.req.raw);
  if (rawBody === null) return c.json({ error: 'payload_too_large' }, 413);
  const res = await handleMoneriumWebhook(
    makeWebhookDeps(c.env, rail, c.executionCtx),
    rail,
    rawBody,
    c.req.raw.headers,
  );
  return c.json(res.body, res.status);
});

// Per-tenant webhook (ADR 0017). The tenant in the URL decides whose secret
// verifies the signature and whose rail handles the order — never a
// fallback to ITalk. Off (404) unless MULTI_TENANT_RAIL=1.
app.post('/api/monerium/webhook/t/:tenantId', async (c) => {
  if (!multiTenantEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
  const tenantId = c.req.param('tenantId');
  const rawBody = await readWebhookBody(c.req.raw);
  if (rawBody === null) return c.json({ error: 'payload_too_large' }, 413);
  // The default tenant has exactly one entry point (the legacy URL above).
  const rail = isLegacyTenant(c.env, tenantId) ? null : await getTenantRail(c.env, tenantId);
  if (!rail) {
    await recordMoneriumWebhookEvent(c.env, {
      orderId: null,
      eventType: 'unknown_tenant',
      signatureOk: false,
      // Unauthenticated: keep only enough to debug a misconfigured URL.
      payload: rawBody.slice(0, 1024),
      processingNote: `unknown_tenant: ${tenantId.slice(0, 64)}`,
      tenantId: null,
    });
    return c.json({ error: 'unknown_tenant' }, 404);
  }
  const res = await handleMoneriumWebhook(
    makeWebhookDeps(c.env, rail, c.executionCtx),
    rail,
    rawBody,
    c.req.raw.headers,
  );
  return c.json(res.body, res.status);
});

// ---- Monerium read endpoints (admin bearer) ----
//
// Were public until ADR 0017. They return payer IBANs and names (Fable BW-05),
// and with tenant rails those are other entities' donors — admin only now.
// The /admin dashboard reads orders through /admin/api/*, not these.
app.use('/api/monerium/orders', async (c, next) => bearerAuth({ token: c.env.ADMIN_TOKEN })(c, next));
app.use('/api/monerium/orders/*', async (c, next) => bearerAuth({ token: c.env.ADMIN_TOKEN })(c, next));

app.get('/api/monerium/orders', async (c) => {
  const orders = await listMoneriumOrders(c.env);
  return c.json({ orders });
});

app.get('/api/monerium/orders/:id', async (c) => {
  const order = await getMoneriumOrder(c.env, c.req.param('id'));
  if (!order) return c.json({ error: 'order not found' }, 404);
  return c.json({ order });
});

// ---- Admin endpoints ----

const admin = new Hono<{ Bindings: Env }>();
admin.use('*', async (c, next) =>
  bearerAuth({ token: c.env.ADMIN_TOKEN })(c, next),
);

admin.post('/connect', async (c) => {
  const body = await c.req.json<{
    institution_id: string;
    reference?: string;
  }>();
  if (!body.institution_id) {
    return c.json({ error: 'institution_id required' }, 400);
  }
  const provider = getProvider(c.env);
  const reference = body.reference ?? `pdai-${Date.now()}`;
  const redirectUrl =
    provider.name === 'enable_banking'
      ? c.env.ENABLE_BANKING_REDIRECT_URL
      : c.env.GOCARDLESS_REDIRECT_URL;
  const r = await provider.createAuthorization({
    institutionId: body.institution_id,
    reference,
    redirectUrl,
  });
  await insertAuthorization(c.env, {
    id: r.id,
    provider: provider.name,
    institutionId: body.institution_id,
    reference,
    status: r.status,
    link: r.link,
  });
  return c.json({ id: r.id, link: r.link, status: r.status });
});

admin.post('/refresh', async (c) => {
  const inserted = await refreshAllAccounts(c.env);
  return c.json({ inserted });
});

admin.get('/authorizations', async (c) => {
  const authorizations = await listAuthorizations(c.env);
  return c.json({ authorizations });
});

app.route('/api/hpb/admin', admin);

// ---- Monerium admin (separate sub-app, same bearer auth) ----

const moneriumAdmin = new Hono<{ Bindings: Env }>();
moneriumAdmin.use('*', async (c, next) =>
  bearerAuth({ token: c.env.ADMIN_TOKEN })(c, next),
);

/// Pulls the last N orders from Monerium and upserts them. Useful as a one-shot
/// backfill or whenever you suspect a webhook was missed.
moneriumAdmin.post('/sync', async (c) => {
  const client = new MoneriumClient(c.env);
  const orders = await client.listOrders();
  for (const o of orders) await upsertMoneriumOrder(c.env, o);
  return c.json({ synced: orders.length });
});

moneriumAdmin.get('/profiles', async (c) => {
  const client = new MoneriumClient(c.env);
  const profiles = await client.listProfiles();
  return c.json({ profiles });
});

moneriumAdmin.get('/auth-context', async (c) => {
  const client = new MoneriumClient(c.env);
  const ctx = await client.getAuthContext();
  return c.json(ctx);
});

moneriumAdmin.get('/webhooks', async (c) => {
  const client = new MoneriumClient(c.env);
  const subs = await client.listWebhookSubscriptions();
  return c.json({ subscriptions: subs });
});

/// Replays the most recent stored webhook event through signature verification
/// against the CURRENT MONERIUM_WEBHOOK_SECRET. Useful when secret rotated
/// after the original delivery — shows the diff between received and expected.
moneriumAdmin.get('/replay-last', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT payload, headers_json FROM monerium_webhook_events
     WHERE headers_json IS NOT NULL ORDER BY id DESC LIMIT 1`,
  ).first<{ payload: string; headers_json: string }>();
  if (!row) return c.json({ error: 'no events with headers stored' }, 404);
  const headers = new Headers();
  for (const [k, v] of Object.entries(JSON.parse(row.headers_json))) {
    if (typeof v === 'string') headers.set(k, v);
  }
  const verify = await verifyWebhookSignature(
    row.payload,
    headers,
    c.env.MONERIUM_WEBHOOK_SECRET,
  );
  return c.json({ verify, body: row.payload, headers: JSON.parse(row.headers_json) });
});

/// One-time setup: registers our /api/monerium/webhook endpoint with Monerium.
/// Body: { "url": "https://...", "types": ["order.created","order.updated"] }
moneriumAdmin.post('/webhooks', async (c) => {
  const body = await c.req.json<{ url: string; types?: string[] }>();
  if (!body.url) return c.json({ error: 'url required' }, 400);
  const client = new MoneriumClient(c.env);
  const sub = await client.createWebhookSubscription({
    url: body.url,
    types: body.types,
    secret: c.env.MONERIUM_WEBHOOK_SECRET || undefined,
  });
  return c.json({ subscription: sub });
});

app.route('/api/monerium/admin', moneriumAdmin);

// Public payment-intents API (unauthenticated; rate-limit in Phase 2).
app.route('/api/intents', buildIntentApi());

// Self-custody wallet registry (Phase 3) + OTP-gated phone binding (Phase 4a).
// See [[reference-wallet-domovina]] and [[reference-otp-domovina]].
// Admin endpoints + HTML dashboard live under /admin/wallets (see admin/app.ts).
app.route('/api/wallets', buildWalletApi());

// Gnosis Pay onboarding mirror (kartice) — vidi docs/plans/gnosis-pay-cards/.
app.route('/api/gp', buildGnosisPayApi());

// GP API proxy (zaobilaženje browser CORS-a prije partner registracije).
app.route('/api/gp-proxy', buildGnosisPayProxy());

// Manual trigger for the on-chain donation indexer (same logic as the cron).
// Guarded by the indexer secret so it can be poked for testing/backfill.
app.post('/api/onchain/scan', async (c) => {
  const key = c.req.header('x-indexer-key') ?? '';
  const secret = (c.env.INTENT_WEBHOOK_SECRET ?? '').trim();
  if (!secret || key !== secret) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const r = await scanOnchainDonations(c.env);
  return c.json({ ok: true, ...r });
});

// Open Graph link preview for the pinka support wall. Public-only egress here
// (CF) keeps it SSRF-isolated; the secret keeps it from being an open OG proxy.
app.post('/api/og-preview', async (c) => {
  const key = c.req.header('x-og-key') ?? '';
  const secret = (c.env.INTENT_WEBHOOK_SECRET ?? '').trim();
  if (!secret || key !== secret) return c.json({ ok: false, error: 'unauthorized' }, 401);
  let url = '';
  try {
    url = String(((await c.req.json()) as { url?: string }).url ?? '');
  } catch {
    return c.json({ ok: false, error: 'bad_json' }, 400);
  }
  const preview = await fetchOgPreview(url);
  return c.json({ ok: true, preview });
});

// Public branded checkout page rendered server-side; polls /api/intents/:sid.
app.get('/checkout/:sid', async (c) => {
  const sid = c.req.param('sid');
  const intent = await getIntent(c.env, sid);
  if (!intent) return c.text('intent not found', 404);
  const status = await buildIntentStatus(c.env, intent, c.executionCtx);
  const sepa = await getSepaDetails(c.env, intent.tenant_id ?? defaultTenantId(c.env));
  return c.html(renderCheckoutPage(intent, status, sepa));
});

// Branded HTML dashboard at /admin (Basic Auth gated).
mountAdminUi(app);

app.onError((err, c) => {
  // basicAuth / bearerAuth + any Hono-thrown HTTPException already carries
  // the right status + WWW-Authenticate header — let it through unchanged
  // (otherwise a 401 becomes a 500 with empty body, suppressing browser auth
  // prompts).
  if (err instanceof HTTPException) return err.getResponse();
  console.error('error', err);
  return c.json({ error: err.message }, 500);
});

async function refreshAccountsForAuthorization(
  env: Env,
  authorizationId: string,
): Promise<number> {
  const all = await listAccounts(env);
  const filtered = all.filter((a) => a.authorization_id === authorizationId);
  return refreshAccounts(env, filtered);
}

async function refreshAllAccounts(env: Env): Promise<number> {
  const all = await listAccounts(env);
  return refreshAccounts(env, all);
}

async function refreshAccounts(
  env: Env,
  accounts: Awaited<ReturnType<typeof listAccounts>>,
): Promise<number> {
  const provider = getProvider(env);
  let inserted = 0;
  for (const a of accounts) {
    if (a.provider !== provider.name) continue;
    try {
      const res = await provider.getAccountTransactions(a.id);
      inserted += await upsertTransactions(env, a.id, [
        ...res.booked,
        ...res.pending,
      ]);
      await upsertAccount(env, {
        id: a.id,
        authorizationId: a.authorization_id,
        provider: a.provider,
        account: {
          id: a.id,
          iban: a.iban ?? undefined,
          name: a.name ?? undefined,
          currency: a.currency ?? undefined,
        },
      });
    } catch (e) {
      console.error(`refresh ${a.id} failed`, e);
    }
  }
  return inserted;
}

function scaPage(message: string, ok: boolean): string {
  const color = ok ? '#1b8f3a' : '#c62828';
  return `<!doctype html><meta charset="utf-8"><title>pay.domovina.ai</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f7f8fa}
.card{max-width:480px;padding:32px;border-radius:14px;background:white;box-shadow:0 2px 8px rgba(0,0,0,.06);text-align:center}
h1{color:${color};margin:0 0 8px;font-size:18px}p{color:#444;margin:0;line-height:1.5}</style>
<div class="card"><h1>${ok ? '✓ Povezano' : 'Greška'}</h1><p>${message}</p>
<p style="margin-top:16px;color:#888;font-size:13px">Možeš zatvoriti ovaj prozor i vratiti se u app.</p></div>`;
}

// Durable Object class for SSE (wrangler.toml [[durable_objects.bindings]]).
export { IntentStream } from './intents/stream';

export default {
  fetch: app.fetch,
  scheduled: async (
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ) => {
    // Runs on every cron tick (the frequent one drives on-chain donation
    // detection). Idempotent + cheap when there's nothing new.
    ctx.waitUntil(
      scanOnchainDonations(env).then(
        (r) => console.log(`cron: onchain scan ${r.scanned} found=${r.found} created=${r.created ?? 0}`),
        (e) => console.error(`cron: onchain scan failed: ${e}`),
      ),
    );

    // Backstop for paid-on-confirmed: reconcile broadcast-but-unconfirmed
    // forwards whose primary waitUntil poll never finished (Worker eviction,
    // slow chain). Same settle path as the primary — atomic flip keeps the
    // paid+webhook effects single-fire. Cheap when the submitted set is empty.
    ctx.waitUntil(
      reconcileSubmittedForwards(makeConfirmDeps(env), Math.floor(Date.now() / 1000)).then(
        (r) => {
          if (r.checked > 0) {
            console.log(`cron: forward reconcile checked=${r.checked} confirmed=${r.confirmed} failed=${r.failed}`);
          }
        },
        (e) => console.error(`cron: forward reconcile failed: ${e}`),
      ),
    );

    // Theft detector (ADR 0019 phase 0): every EURe leaving a rail Safe must
    // be one of our own forwards. Cursor-based, cheap when nothing moved.
    ctx.waitUntil(
      watchAllRailOutflows(env).then(
        (n) => { if (n > 0) console.warn(`cron: outflow watch flagged ${n} transfer(s)`); },
        (e) => console.error(`cron: outflow watch failed: ${e}`),
      ),
    );

    // Durable merchant webhooks: retry every outbox row that is due.
    ctx.waitUntil(
      deliverDue(makeOutboxDeps(env), Math.floor(Date.now() / 1000)).then(
        (r) => {
          if (r.due > 0) {
            console.log(`cron: webhook outbox due=${r.due} delivered=${r.delivered} failed=${r.failed}`);
          }
        },
        (e) => console.error(`cron: webhook outbox failed: ${e}`),
      ),
    );

    // Missed-webhook backstop: every RECONCILE_INTERVAL_S, pull recent orders
    // from the Monerium API (only while something is in flight).
    const nowUnix = Math.floor(event.scheduledTime / 1000);
    if (event.cron !== '0 */6 * * *' && Math.floor(nowUnix / 120) % (RECONCILE_INTERVAL_S / 120) === 0) {
      ctx.waitUntil(
        reconcileMoneriumOrders(env, nowUnix).then(
          (r) => {
            if (!r.skipped && (r.advanced > 0 || r.unforwarded > 0)) {
              console.log(`cron: monerium reconcile fetched=${r.fetched} advanced=${r.advanced} unforwarded=${r.unforwarded}`);
            }
          },
          (e) => console.error(`cron: monerium reconcile failed: ${e}`),
        ),
      );
    }

    // Heavier housekeeping only on the 6-hourly cron.
    if (event.cron === '0 */6 * * *') {
      // Tenant routers (ADR 0017) need xDAI for gas; alert before they run dry.
      ctx.waitUntil(
        checkRouterGas(env).then(
          (n) => { if (n > 0) console.log(`cron: ${n} tenant router(s) low on gas`); },
          (e) => console.error(`cron: router gas check failed: ${e}`),
        ),
      );
      ctx.waitUntil(
        refreshAllAccounts(env).then((n) =>
          console.log(`cron: inserted ${n} new transactions`),
        ),
      );
      // Flip overdue pending intents to expired so the checkout page can
      // show a clear "istekao" state. Idempotent + cheap UPDATE.
      ctx.waitUntil(
        sweepExpiredIntents(env).then(async (sids) => {
          console.log(`cron: expired ${sids.length} pending intents`);
          await Promise.all(sids.map((sid) => publishIntentChange(env, sid)));
        }),
      );
    }
  },
};
