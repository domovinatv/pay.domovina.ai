import { Hono } from 'hono';

import type { Env } from '../types';
import { createIntent, getIntent } from './db';
import { generateSid } from './sid';
import { buildEpcText } from './epc';
import { computeStage, confirmForwardIfMined, loadStageContext } from './stage';
import type { StageResult } from './stage';

/// Public, unauthenticated intent API. Mountable into the root Hono app
/// via `app.route('/api/intents', intentApi)`. Phase 1 is polling-only;
/// `/stream` is reserved for the Phase 2 SSE upgrade and currently 404s
/// so EventSource clients fall back to polling cleanly.

interface CreateIntentBody {
  target_address?: string;
  amount_eur?: string | number;
  label?: string;
  metadata?: Record<string, unknown>;
  expires_in_seconds?: number;
  /// Optional client-supplied session id. The Flutter app generates its QR
  /// remittance (`mpt:0x…?sid=<id>`) locally, then registers the same sid
  /// here so it can poll the status timeline. Server-generated when absent.
  sid?: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const SID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/// MPT main-rail LHV IBAN + beneficiary name baked into the EPC payload.
/// Hardcoded here because changing it requires changing the Monerium
/// dashboard webhook target too — it's an entire-stack reconfiguration.
const MPT_BENEFICIARY_NAME = 'ITalk d.o.o.';
const MPT_IBAN = 'EE7077770001629211 28';
const MPT_BIC = 'LHVBEE22';
const DEFAULT_TTL_SECONDS = 900; // 15 min — matches PayCek's window
const MAX_TTL_SECONDS = 86_400;  // 24 h hard cap
const MAX_AMOUNT_CENTS = 1_000_000; // €10,000 — bigger needs Phase 2 multisig propose

export function buildIntentApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.post('/', async (c) => {
    let body: CreateIntentBody;
    try {
      body = await c.req.json<CreateIntentBody>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const target = (body.target_address ?? '').trim();
    if (!ADDR_RE.test(target)) {
      return c.json({ error: 'invalid_target_address' }, 400);
    }
    const amountEur = parseAmount(body.amount_eur);
    if (amountEur === null) {
      return c.json({ error: 'invalid_amount_eur' }, 400);
    }
    const amountCents = Math.round(amountEur * 100);
    if (amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
      return c.json({ error: 'amount_out_of_range', max: MAX_AMOUNT_CENTS }, 400);
    }
    const ttl = Math.min(
      Math.max(body.expires_in_seconds ?? DEFAULT_TTL_SECONDS, 60),
      MAX_TTL_SECONDS,
    );
    if (body.sid !== undefined && !SID_RE.test(body.sid)) {
      return c.json({ error: 'invalid_sid' }, 400);
    }
    const sid = await insertWithRetry(c.env, target, amountCents, ttl, body);
    if (sid === 'conflict') return c.json({ error: 'sid_already_exists' }, 409);
    if (!sid) return c.json({ error: 'sid_collision_after_retries' }, 500);
    const intent = await getIntent(c.env, sid);
    if (!intent) return c.json({ error: 'intent_not_persisted' }, 500);

    const origin = new URL(c.req.url).origin;
    const status = computeStage({
      intent, order: null, forward: null,
      now: Math.floor(Date.now() / 1000),
    });
    return c.json({ ...intentResponseJson(intent, origin), status });
  });

  // Permanent campaign QR (`cmp:` protocol). Stateless: returns a REUSABLE
  // SEPA EPC payload (blank amount → payer enters it) whose remittance encodes
  // `cmp:0x<campaignSafe>?id=<campaignId>`. Many payments can use the same QR;
  // each inbound Monerium order is forwarded to the Safe and reported to the
  // merchant as a DISTINCT contribution (see emitCampaignContributionWebhook).
  // No DB row is created here — it's a pure, idempotent QR generator.
  api.get('/campaign-qr', (c) => {
    const target = (c.req.query('target') ?? '').trim();
    const id = (c.req.query('id') ?? '').trim();
    const label = (c.req.query('label') ?? '').trim();
    if (!ADDR_RE.test(target)) return c.json({ error: 'invalid_target_address' }, 400);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return c.json({ error: 'invalid_campaign_id' }, 400);
    // Optional prefilled amount. Absent/blank → reusable, payer-entered amount.
    // When present it's only a PREFILL — the payer can override, and the actual
    // settled amount is what gets recorded (record_sepa_contribution uses the
    // Monerium order amount), so a fixed-amount QR (e.g. membership) and a
    // free-amount QR share the same cmp: reference and Safe.
    const amountRaw = (c.req.query('amount') ?? '').trim();
    let amountEur: number | null = null;
    if (amountRaw) {
      const n = Number(amountRaw.replace(',', '.'));
      if (!Number.isFinite(n) || n <= 0 || Math.round(n * 100) > MAX_AMOUNT_CENTS) {
        return c.json({ error: 'invalid_amount_eur', max: MAX_AMOUNT_CENTS }, 400);
      }
      amountEur = n;
    }
    const memo = `cmp:${target.toLowerCase()}?id=${id}`;
    const epcText = buildEpcText({
      beneficiaryName: MPT_BENEFICIARY_NAME,
      iban: MPT_IBAN,
      amountEur, // null → blank (free), positive → prefilled (still overridable)
      purposeCode: 'OTHR',
      remittanceInfo: memo,
      bic: MPT_BIC,
    });
    return c.json({
      campaign_id: id,
      target_address: target.toLowerCase(),
      label: label || null,
      amount_eur: amountEur !== null ? amountEur.toFixed(2) : null,
      memo,
      iban: MPT_IBAN,
      beneficiary_name: MPT_BENEFICIARY_NAME,
      bic: MPT_BIC,
      epc_qr_data: epcText,
    });
  });

  api.get('/:sid', async (c) => {
    const sid = c.req.param('sid');
    const intent = await getIntent(c.env, sid);
    if (!intent) return c.json({ error: 'intent_not_found' }, 404);
    const origin = new URL(c.req.url).origin;
    const status = await buildIntentStatus(c.env, intent, c.executionCtx);
    return c.json({ ...intentResponseJson(intent, origin), status });
  });

  // Phase 2 SSE endpoint — currently absent. EventSource will receive a 404
  // and the checkout page's JS falls back to polling automatically.
  api.get('/:sid/stream', (c) => {
    return c.json({ error: 'sse_not_yet_implemented_use_polling' }, 404);
  });

  return api;
}

/// Builds the full intent representation returned to API callers and used
/// by the checkout page. Kept in one place so the shape is consistent
/// between create + status endpoints.
export function intentResponseJson(
  intent: import('./db').PaymentIntentRow,
  origin: string,
): Record<string, unknown> {
  const memo = `mpt:${intent.target_address}?sid=${intent.sid}`;
  const amountEur = (intent.amount_cents / 100).toFixed(2);
  const epcText = buildEpcText({
    beneficiaryName: MPT_BENEFICIARY_NAME,
    iban: MPT_IBAN,
    amountEur: intent.amount_cents / 100,
    purposeCode: 'OTHR',
    remittanceInfo: memo,
    bic: MPT_BIC,
  });
  return {
    sid: intent.sid,
    state: intent.state,
    amount_eur: amountEur,
    amount_cents: intent.amount_cents,
    currency: intent.currency,
    target_address: intent.target_address,
    label: intent.label,
    metadata: intent.metadata_json ? JSON.parse(intent.metadata_json) : null,
    memo,
    iban: MPT_IBAN,
    beneficiary_name: MPT_BENEFICIARY_NAME,
    bic: MPT_BIC,
    epc_qr_data: epcText,
    checkout_url: `${origin}/checkout/${intent.sid}`,
    status_url: `${origin}/api/intents/${intent.sid}`,
    status_stream_url: `${origin}/api/intents/${intent.sid}/stream`,
    created_at: isoFromUnix(intent.created_at),
    expires_at: isoFromUnix(intent.expires_at),
    paid_at: intent.paid_at ? isoFromUnix(intent.paid_at) : null,
    monerium_order_id: intent.monerium_order_id,
    forward_tx_hash: intent.forward_tx_hash,
    amount_received_cents: intent.amount_received_cents,
  };
}

/// Per-stage status shared by all surfaces. When a forward is broadcast but
/// unconfirmed, kick a best-effort receipt check into `waitUntil` — the 2 s
/// polling loop then observes `settled` on a subsequent read (§5.1 wiring of
/// the previously never-called getForwardStatus).
export async function buildIntentStatus(
  env: Env,
  intent: import('./db').PaymentIntentRow,
  executionCtx?: { waitUntil(p: Promise<unknown>): void },
): Promise<StageResult> {
  const { order, forward } = await loadStageContext(env, intent);
  if (forward && forward.status === 'submitted' && forward.tx_hash) {
    const check = confirmForwardIfMined(env, forward);
    if (executionCtx) executionCtx.waitUntil(check);
    else await check.catch(() => {});
  }
  return computeStage({
    intent, order, forward,
    now: Math.floor(Date.now() / 1000),
  });
}

async function insertWithRetry(
  env: Env,
  target: string,
  amountCents: number,
  ttlSeconds: number,
  body: CreateIntentBody,
): Promise<string | 'conflict' | null> {
  // Client-supplied sid: single attempt. A real duplicate-sid collision is
  // the caller's error (409); ANY OTHER failure (transient D1 error, etc.)
  // must NOT masquerade as a conflict — the client swallows 409 as success
  // and would then poll a never-created intent forever. Rethrow non-conflict
  // errors so they surface as a 500 the client will retry.
  if (body.sid !== undefined) {
    try {
      await createIntent(env, {
        sid: body.sid,
        targetAddress: target,
        amountCents,
        label: body.label ?? null,
        metadata: body.metadata ?? null,
        ttlSeconds,
      });
      return body.sid;
    } catch (e) {
      if (/UNIQUE constraint failed/i.test((e as Error)?.message ?? '')) {
        return 'conflict';
      }
      throw e;
    }
  }
  for (let i = 0; i < 3; i++) {
    const sid = generateSid();
    try {
      await createIntent(env, {
        sid,
        targetAddress: target,
        amountCents,
        label: body.label ?? null,
        metadata: body.metadata ?? null,
        ttlSeconds,
      });
      return sid;
    } catch (e) {
      // Most likely PK collision on sid — retry. Any other DB error
      // bubbles up on the third attempt.
      if (i === 2) throw e;
    }
  }
  return null;
}

function parseAmount(input: string | number | undefined): number | null {
  if (input === undefined || input === null) return null;
  const n = typeof input === 'number' ? input : Number(String(input).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return n;
}

function isoFromUnix(s: number): string {
  return new Date(s * 1000).toISOString();
}
