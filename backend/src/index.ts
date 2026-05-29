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
import {
  extractEventType,
  extractOrder,
  verifyWebhookSignature,
} from './monerium/webhook';
import {
  alreadyProcessedEvent,
  getForwardByOrder,
  getMoneriumOrder,
  insertForward,
  listMoneriumOrders,
  recordMoneriumWebhookEvent,
  updateForward,
  upsertMoneriumOrder,
} from './monerium/db';
import { extractRoutingFromOrder, extractSessionId } from './monerium/sid';
import { forwardViaSafe } from './router/safe';
import { mountAdminUi } from './admin/app';
import { buildIntentApi } from './intents/api';
import { buildWalletApi } from './wallets/api';
import {
  getIntent,
  markIntentPaid,
  sweepExpiredIntents,
} from './intents/db';
import { emitIntentPaidWebhook } from './intents/outbound';
import { renderCheckoutPage } from './checkout/page';
import type { Address } from 'viem';
import type { MoneriumWebhookEvent } from './monerium/types';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const origins = c.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  const origin = origins.includes('*') ? '*' : origins;
  return cors({
    origin,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
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

app.post('/api/monerium/webhook', async (c) => {
  const rawBody = await c.req.text();
  const verify = await verifyWebhookSignature(
    rawBody,
    c.req.raw.headers,
    c.env.MONERIUM_WEBHOOK_SECRET,
  );
  let event: MoneriumWebhookEvent | null = null;
  try {
    event = JSON.parse(rawBody) as MoneriumWebhookEvent;
  } catch {
    // Persist the raw payload anyway so we can debug malformed events.
  }
  const eventType = event ? extractEventType(event) : 'invalid_json';
  const order = event ? extractOrder(event) : null;
  const sid = extractSessionId(order);
  const amountCents = parseAmountCents(order?.amount);
  const headersObj: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headersObj[k] = v; });
  let processingNote: string | null = null;
  if (!verify.ok) processingNote = `signature_invalid: ${verify.reason}`;
  else if (eventType === 'subscription.created') processingNote = 'subscription_ack';
  else if (!order) processingNote = 'no_order_in_payload';
  await recordMoneriumWebhookEvent(c.env, {
    orderId: order?.id ?? null,
    eventType,
    signatureOk: verify.ok,
    payload: rawBody,
    headersJson: JSON.stringify(headersObj),
    sidExtracted: sid,
    amountCents,
    currency: order?.currency ?? null,
    processingNote,
  });
  if (!verify.ok) {
    console.warn(
      `monerium webhook signature FAILED: ${verify.reason}\n` +
        `  body[${rawBody.length}b]: ${rawBody.slice(0, 300)}\n` +
        `  debug: ${JSON.stringify(verify.debug, null, 2)}`,
    );
    return c.json({ error: 'invalid signature' }, 401);
  }
  // Idempotency: skip re-processing if Monerium retried (up to 10× / 12h).
  if (verify.webhookId) {
    const seen = await alreadyProcessedEvent(c.env, verify.webhookId);
    if (seen) {
      console.log(`monerium webhook ${verify.webhookId} already processed`);
      return c.json({ ok: true, dedup: true });
    }
  }
  // `subscription.created` is sent once on registration — just return 200.
  if (eventType === 'subscription.created') {
    console.log('monerium subscription.created — webhook activated');
    return c.json({ ok: true });
  }
  if (order) {
    await upsertMoneriumOrder(c.env, order);
    console.log(`monerium ${eventType} order ${order.id} state=${order.state ?? '?'}`);
    // Auto-forward via Safe + Roles Modifier on incoming issue orders.
    //
    // Critical race-condition fix (2026-05-21): only forward AFTER Monerium
    // has actually executed the EURe mint TX on-chain. `order.created` fires
    // when Monerium receives the SEPA payment but BEFORE the mint reaches
    // chain — Safe has no EURe to forward, so `execTransactionWithRole`
    // reverts with `ModuleTransactionFailed()` at the inner `EURe.transfer`
    // call. `order.updated` with `state=processed` is the signal that the
    // mint TX is in `meta.txHashes` and the Safe balance is live.
    //
    // Idempotency: order.updated may fire more than once. Skip if we already
    // have a `submitted` or `confirmed` forward for this order_id. A prior
    // `failed` forward is allowed to retry — covers transient RPC errors.
    if (
      order.kind === 'issue'
      && eventType === 'order.updated'
      && order.state === 'processed'
      && c.env.ROUTER_PRIVATE_KEY
    ) {
      c.executionCtx.waitUntil(maybeForward(c.env, order));
    }
  }
  return c.json({ ok: true });
});

// ---- Monerium read endpoints (public) ----

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

// Public branded checkout page rendered server-side; polls /api/intents/:sid.
app.get('/checkout/:sid', async (c) => {
  const sid = c.req.param('sid');
  const intent = await getIntent(c.env, sid);
  if (!intent) return c.text('intent not found', 404);
  return c.html(renderCheckoutPage(intent));
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

/// Convert Monerium's decimal-string amount ("12.34", "0.5", "1000") to
/// integer minor units for sortable indexing. Returns null on parse failure
/// — we still want the event row to land in the audit log either way.
function parseAmountCents(amount: string | undefined | null): number | null {
  if (!amount) return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/// EURe has 18 decimals (per Monerium standard). Convert a decimal-string
/// amount to wei. Avoids floating-point by splitting on the decimal point
/// and padding the fractional half to 18 chars before BigInt parse.
function eurToWei(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(fracPadded || '0');
}

/// Wrapper that enforces forward-level idempotency before invoking the
/// actual forward. Called from `executionCtx.waitUntil` so the webhook
/// response is never blocked.
async function maybeForward(
  env: import('./types').Env,
  order: import('./monerium/types').MoneriumOrder,
): Promise<void> {
  const existing = await getForwardByOrder(env, order.id);
  if (existing && (existing.status === 'submitted' || existing.status === 'confirmed')) {
    console.log(`forward ${order.id} already ${existing.status}, skipping`);
    return;
  }
  await handleForward(env, order);
}

/// Fire-and-forget forward of a single issue order's EURe from the Safe to
/// the wallet encoded in the memo. Called inside `executionCtx.waitUntil`
/// so the webhook response returns immediately to Monerium.
async function handleForward(
  env: import('./types').Env,
  order: import('./monerium/types').MoneriumOrder,
): Promise<void> {
  const routing = extractRoutingFromOrder(order);
  const amountCents = parseAmountCents(order.amount);
  if (!routing.target) {
    await insertForward(env, {
      orderId: order.id,
      targetAddress: '',
      amountWei: '0',
      amountCents,
      sid: routing.sid,
      memoPrefix: routing.prefix,
      status: 'failed',
      error: 'no_routing_target',
    });
    console.warn(`forward ${order.id}: no target in memo "${order.memo ?? ''}"`);
    return;
  }
  // Skip self-forward — if memo target IS the Safe itself, leave funds in
  // place. Common for "fund the Safe" deposits.
  if (env.SAFE_ADDRESS && routing.target.toLowerCase() === env.SAFE_ADDRESS.toLowerCase()) {
    await insertForward(env, {
      orderId: order.id,
      targetAddress: routing.target,
      amountWei: '0',
      amountCents,
      sid: routing.sid,
      memoPrefix: routing.prefix,
      status: 'confirmed',
      error: 'self_target_noop',
    });
    return;
  }
  const amountWei = eurToWei(order.amount ?? '0');
  const forwardId = await insertForward(env, {
    orderId: order.id,
    targetAddress: routing.target,
    amountWei: amountWei.toString(),
    amountCents,
    sid: routing.sid,
    memoPrefix: routing.prefix,
    status: 'pending',
  });
  const result = await forwardViaSafe(env, {
    target: routing.target as Address,
    amountWei,
    // When PAYMENT_REGISTRY_ADDRESS + MULTISEND_ADDRESS are set, the rail
    // batches `registry.record(...)` alongside the transfer so each forward
    // emits an onchain `Payment` event. `sessionId` is the join-key the feed
    // indexer uses to look up the offchain metadata (URL, label, …). When
    // null, we fall through to the legacy single-transfer path.
    sessionId: routing.sid,
  });
  if (result.ok) {
    await updateForward(env, forwardId, {
      status: 'submitted',
      tx_hash: result.txHash!,
      attempts: 1,
    });
    console.log(`forward ${order.id} → ${routing.target} tx=${result.txHash}`);
    // Link to the corresponding payment intent (if any) so the checkout
    // page can flip to 'paid'. Idempotent: only flips pending → paid,
    // ignores already-paid or expired intents.
    if (routing.sid) {
      const flipped = await markIntentPaid(env, routing.sid, {
        moneriumOrderId: order.id,
        forwardId,
        forwardTxHash: result.txHash!,
        amountReceivedCents: amountCents,
      });
      // Notify the merchant (e.g. pinka.finance) exactly once, on the real
      // pending → paid flip. Monerium retries / duplicate order.updated events
      // return flipped=false here, so no duplicate outbound webhook fires.
      if (flipped) {
        const paidIntent = await getIntent(env, routing.sid);
        if (paidIntent) await emitIntentPaidWebhook(env, paidIntent);
      }
    }
  } else {
    await updateForward(env, forwardId, {
      status: 'failed',
      error: result.error ?? 'unknown',
      attempts: 1,
    });
    console.error(`forward ${order.id} FAILED: ${result.error}`);
  }
}

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

export default {
  fetch: app.fetch,
  scheduled: async (
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ) => {
    ctx.waitUntil(
      refreshAllAccounts(env).then((n) =>
        console.log(`cron: inserted ${n} new transactions`),
      ),
    );
    // Flip overdue pending intents to expired so the checkout page can
    // show a clear "istekao" state. Idempotent + cheap UPDATE.
    ctx.waitUntil(
      sweepExpiredIntents(env).then((n) =>
        console.log(`cron: expired ${n} pending intents`),
      ),
    );
  },
};
