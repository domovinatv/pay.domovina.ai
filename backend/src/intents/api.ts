import { Hono, type Context } from 'hono';

import type { Env } from '../types';
import { countOpenIntentsForTarget, createIntent, getIntent, isTrustedTarget } from './db';
import { generateSid } from './sid';
import { isReceiptSid } from '../receipts/sid';
import { registerReceiptRoutes } from '../receipts/api';
import { registerSimulateRoute } from '../sandbox/api';
import { registerMoneriumSandboxFundRoute } from '../monerium/sandboxFund';
import { isSandboxTenant, touchSandboxTenant } from '../sandbox/db';
import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  decodeCursor,
  listTenantIntents,
  tenantIntentStats,
  type IntentStateFilter,
} from './list';
import { buildEpcText } from './epc';
import { buildIntentHub3Text } from './hub3';
import { computeStage, confirmForwardIfMined, loadStageContext } from './stage';
import type { StageResult } from './stage';
import { openIntentStream, sseEnabled } from './stream';
import { resolveRequestTenant } from '../tenants/auth';
import { defaultTenantId } from '../tenants/whitelist';
import {
  getReferenceStyle,
  getTenantRail,
  getTenantRailRow,
  intentReference,
  isLegacyTenant,
  multiTenantEnabled,
  type ReferenceStyle,
} from '../tenants/rail';
import {
  findCampaignBySafe,
  getCampaign,
  getSepaDetails,
  isAddressWhitelisted,
  type SepaDetails,
} from '../tenants/db';

/// Public, unauthenticated intent API. Mountable into the root Hono app
/// via `app.route('/api/intents', intentApi)`. Status is available by
/// polling `/:sid` and, when INTENT_SSE=1, pushed on `/:sid/stream` (SSE).

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
  /// ADR 0024 D6: where the checkout sends the buyer back, with
  /// `mpt_sid` + `mpt_status` appended. Secret key only.
  return_url?: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/// ≤ 32 (BW-20): the sid is written on-chain as bytes32 by the payment
/// registry path (router/safe.ts asciiToBytes32 throws above 32 bytes).
const SID_RE = /^[A-Za-z0-9_-]{6,32}$/;

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
    // Which tenant is asking. Soft by default (no key → default tenant); flip
    // INTENT_REQUIRE_TENANT_KEY=1 once every client ships a key.
    const tenant = await resolveRequestTenant(c.env, c.req.raw.headers);
    if (!tenant.ok) {
      return c.json({ error: tenant.error }, tenant.error === 'tenant_suspended' ? 403 : 401);
    }
    // ADR 0024 D6: a public key (or none) could otherwise turn our checkout
    // into a redirect to anywhere — pk_ keys are public by design.
    let returnUrl: string | null = null;
    if (body.return_url !== undefined && body.return_url !== null && body.return_url !== '') {
      if (tenant.keyKind !== 'secret') return c.json({ error: 'return_url_requires_secret_key' }, 400);
      returnUrl = validateReturnUrl(body.return_url, await returnUrlAllowsLoopback(c.env, tenant));
      if (!returnUrl) return c.json({ error: 'invalid_return_url' }, 400);
    }
    // ADR 0024: a sandbox tenant has no rail, no IBAN and no money. Nothing
    // can be paid or forwarded, so the whitelist and the SR-01 cap have
    // nothing to protect; its payments are simulated (/:sid/simulate).
    if (tenant.sandbox === true) {
      return createSandboxIntent(c, body, tenant.tenantId, tenant.keyKind === 'secret', returnUrl);
    }
    // A non-default tenant collects on ITS OWN IBAN. Issuing a QR for that
    // IBAN while the rail cannot see the tenant's Monerium webhook would take
    // money we can never report or route — refuse instead (ADR 0017).
    const railRefusal = await tenantRailRefusal(c.env, tenant.tenantId);
    if (railRefusal) return c.json({ error: railRefusal, tenant_id: tenant.tenantId }, 403);
    // Direct mode: Monerium mints straight into the target, so the target must
    // be one of the tenant's registered project Safes (campaigns). Nothing is
    // ever forwarded, so the payout whitelist does not apply.
    const style = await getReferenceStyle(c.env, tenant.tenantId);
    const direct = style?.mode === 'direct';
    if (direct && !(await findCampaignBySafe(c.env, tenant.tenantId, target))) {
      return c.json(
        { error: 'target_not_campaign', tenant_id: tenant.tenantId, target_address: target.toLowerCase() },
        403,
      );
    }
    // Fail fast on a destination the forward gate would refuse anyway. This is
    // UX, not the security boundary — `authorizeForward` re-checks at forward
    // time, because an address can be revoked between intent and payment.
    if (!direct && !(await isAddressWhitelisted(c.env, tenant.tenantId, target))) {
      return c.json(
        { error: 'target_not_whitelisted', tenant_id: tenant.tenantId, target_address: target.toLowerCase() },
        403,
      );
    }
    const amountEur = parseAmount(body.amount_eur);
    if (amountEur === null) {
      return c.json({ error: 'invalid_amount_eur' }, 400);
    }
    const amountCents = Math.round(amountEur * 100);
    if (amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
      return c.json({ error: 'amount_out_of_range', max: MAX_AMOUNT_CENTS }, 400);
    }
    if (body.expires_in_seconds !== undefined && !Number.isFinite(body.expires_in_seconds)) {
      return c.json({ error: 'invalid_expires_in_seconds' }, 400);
    }
    const ttl = Math.min(
      Math.max(Math.floor(body.expires_in_seconds ?? DEFAULT_TTL_SECONDS), 60),
      MAX_TTL_SECONDS,
    );
    if (body.sid !== undefined && !SID_RE.test(body.sid)) {
      return c.json({ error: 'invalid_sid' }, 400);
    }
    // SR-01 cap: anyone can open intents without a key, so bound how many
    // can sit open on one destination. Only for destinations that are not
    // statically trusted — a cap on a popular campaign Safe would let a
    // spammer lock its real donors out. Secret-key callers are exempt.
    const secretKey = tenant.keyKind === 'secret';
    // A registered campaign is admin-entered, i.e. trusted like a static
    // whitelist entry.
    if (!secretKey && !direct && !(await isTrustedTarget(c.env, tenant.tenantId, target))) {
      const open = await countOpenIntentsForTarget(c.env, tenant.tenantId, target, Math.floor(Date.now() / 1000));
      if (open >= maxOpenIntentsPerTarget(c.env)) {
        return c.json({ error: 'too_many_open_intents', target_address: target.toLowerCase() }, 429);
      }
    }
    const sid = await insertWithRetry(c.env, target, amountCents, ttl, body, tenant.tenantId, secretKey, returnUrl);
    if (sid === 'conflict') return c.json({ error: 'sid_already_exists' }, 409);
    if (!sid) return c.json({ error: 'sid_collision_after_retries' }, 500);
    const intent = await getIntent(c.env, sid);
    if (!intent) return c.json({ error: 'intent_not_persisted' }, 500);

    const origin = new URL(c.req.url).origin;
    const sepa = await getSepaDetails(c.env, tenant.tenantId);
    const status = computeStage({
      intent, order: null, forward: null,
      now: Math.floor(Date.now() / 1000),
    });
    return c.json({ ...intentResponseJson(intent, origin, sepa, style), status });
  });

  // Permanent campaign QR (`cmp:` protocol). Stateless: returns a REUSABLE
  // SEPA EPC payload (blank amount → payer enters it) whose remittance encodes
  // `cmp:0x<campaignSafe>?id=<campaignId>`. Many payments can use the same QR;
  // each inbound Monerium order is forwarded to the Safe and reported to the
  // merchant as a DISTINCT contribution (see emitCampaignContributionWebhook).
  // No DB row is created here — it's a pure, idempotent QR generator over the
  // tenant_campaigns registry. The campaign MUST be registered first (admin:
  // POST /admin/api/tenants/:id/campaigns), otherwise the QR would print a
  // reference that the forward gate refuses on every single payment.
  api.get('/campaign-qr', async (c) => {
    const target = (c.req.query('target') ?? '').trim();
    const id = (c.req.query('id') ?? '').trim();
    const label = (c.req.query('label') ?? '').trim();
    if (!ADDR_RE.test(target)) return c.json({ error: 'invalid_target_address' }, 400);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return c.json({ error: 'invalid_campaign_id' }, 400);
    const campaign = await getCampaign(c.env, id);
    if (!campaign) return c.json({ error: 'campaign_not_registered', campaign_id: id }, 404);
    const railRefusal = await tenantRailRefusal(c.env, campaign.tenant_id);
    if (railRefusal) return c.json({ error: railRefusal, campaign_id: id }, 403);
    if (campaign.safe_address.toLowerCase() !== target.toLowerCase()) {
      return c.json(
        {
          error: 'campaign_target_mismatch',
          campaign_id: id,
          registered_address: campaign.safe_address,
        },
        409,
      );
    }
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
    // The collection IBAN comes from the campaign's OWN tenant — a second
    // tenant collects on its own Monerium account, never on ITalk's.
    const sepa = await getSepaDetails(c.env, campaign.tenant_id);
    const memo = `cmp:${target.toLowerCase()}?id=${id}`;
    const epcText = buildEpcText({
      beneficiaryName: sepa.beneficiaryName,
      iban: sepa.iban,
      amountEur, // null → blank (free), positive → prefilled (still overridable)
      purposeCode: 'OTHR',
      remittanceInfo: memo,
      bic: sepa.bic,
    });
    return c.json({
      campaign_id: id,
      target_address: target.toLowerCase(),
      label: label || null,
      amount_eur: amountEur !== null ? amountEur.toFixed(2) : null,
      memo,
      iban: sepa.iban,
      beneficiary_name: sepa.beneficiaryName,
      bic: sepa.bic,
      epc_qr_data: epcText,
    });
  });

  // ADR 0024 D8: the caller's own intents, newest first. Secret key only —
  // the list carries metadata and amounts a public key must not reveal.
  api.get('/', async (c) => {
    const who = await secretKeyCaller(c);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const range = parseRange(c.req.query('created_from'), c.req.query('created_to'));
    if (!range.ok) return c.json({ error: range.error }, 400);
    const stateRaw = c.req.query('state');
    if (stateRaw !== undefined && !STATES.includes(stateRaw as IntentStateFilter)) {
      return c.json({ error: 'invalid_state', allowed: STATES }, 400);
    }
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? LIST_DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
      return c.json({ error: 'invalid_limit', max: LIST_MAX_LIMIT }, 400);
    }
    const cursorRaw = c.req.query('cursor');
    const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) return c.json({ error: 'invalid_cursor' }, 400);
    const { items, nextCursor } = await listTenantIntents(c.env, {
      tenantId: who.tenantId,
      includeLegacyNull: isLegacyTenant(c.env, who.tenantId),
      state: (stateRaw as IntentStateFilter | undefined) ?? null,
      createdFrom: range.from,
      createdTo: range.to,
      limit,
      cursor,
    });
    const origin = new URL(c.req.url).origin;
    const sepa = await getSepaDetails(c.env, who.tenantId);
    const style = await getReferenceStyle(c.env, who.tenantId);
    const data = items.map((intent) => {
      const json = intentResponseJson(intent, origin, sepa, style);
      const view = who.sandbox ? sandboxView(json, origin) : json;
      // A list is for bookkeeping; payment codes stay on the single intent.
      const { epc_qr_data: _e, hub3_data: _h, ...rest } = view;
      return rest;
    });
    return c.json({ data, has_more: nextCursor !== null, next_cursor: nextCursor });
  });

  // ADR 0024 D8: totals per outcome (Open SaaS `fetchTotalRevenue`).
  api.get('/stats', async (c) => {
    const who = await secretKeyCaller(c);
    if (!who.ok) return c.json({ error: who.error }, who.status);
    const range = parseRange(c.req.query('created_from'), c.req.query('created_to'));
    if (!range.ok) return c.json({ error: range.error }, 400);
    const stats = await tenantIntentStats(c.env, {
      tenantId: who.tenantId,
      includeLegacyNull: isLegacyTenant(c.env, who.tenantId),
      createdFrom: range.from,
      createdTo: range.to,
    });
    return c.json({
      tenant_id: who.tenantId,
      currency: 'eur',
      created_from: range.from === null ? null : isoFromUnix(range.from),
      created_to: range.to === null ? null : isoFromUnix(range.to),
      ...stats,
    });
  });

  api.get('/:sid', async (c) => {
    const sid = c.req.param('sid');
    const intent = await getIntent(c.env, sid);
    if (!intent) return c.json({ error: 'intent_not_found' }, 404);
    const origin = new URL(c.req.url).origin;
    const sepa = await getSepaDetails(c.env, intent.tenant_id ?? defaultTenantId(c.env));
    const style = await getReferenceStyle(c.env, intent.tenant_id);
    const status = await buildIntentStatus(c.env, intent, c.executionCtx);
    const json = intentResponseJson(intent, origin, sepa, style);
    if (await isSandboxTenant(c.env, intent.tenant_id)) return c.json({ ...sandboxView(json, origin), status });
    return c.json({ ...json, status });
  });

  // SSE (ADR 0017). Off → the historical 404, and EventSource clients fall
  // back to polling `status_url`, whose shape is unchanged either way. The sid
  // is the capability, exactly as for the polling endpoint.
  api.get('/:sid/stream', async (c) => {
    if (!sseEnabled(c.env)) {
      return c.json({ error: 'sse_not_yet_implemented_use_polling' }, 404);
    }
    const sid = c.req.param('sid');
    if (!SID_RE.test(sid)) return c.json({ error: 'intent_not_found' }, 404);
    return openIntentStream(c.env, sid);
  });

  // ADR 0022: the payer's browser re-issues a pending intent under a receipt
  // sid it derived from its own key. Same tenant, target, amount and label;
  // the original stays as it is. No key needed (the original sid is public
  // anyway), so the same SR-01 cap as keyless creation applies.
  api.post('/:sid/receipt-intent', async (c) => {
    const original = await getIntent(c.env, c.req.param('sid'));
    if (!original) return c.json({ error: 'intent_not_found' }, 404);
    const now = Math.floor(Date.now() / 1000);
    if (original.state !== 'pending' || original.expires_at <= now) {
      return c.json({ error: 'intent_not_pending' }, 409);
    }
    let body: { sid?: string };
    try {
      body = await c.req.json<{ sid?: string }>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!isReceiptSid(body.sid)) return c.json({ error: 'invalid_receipt_sid' }, 400);
    const tenantId = original.tenant_id ?? defaultTenantId(c.env);
    // Receipts are anchored on Gnosis; a simulated payment must never get one.
    if (await isSandboxTenant(c.env, tenantId)) return c.json({ error: 'receipts_not_in_sandbox' }, 409);
    const railRefusal = await tenantRailRefusal(c.env, tenantId);
    if (railRefusal) return c.json({ error: railRefusal, tenant_id: tenantId }, 403);
    const target = original.target_address;
    const style = await getReferenceStyle(c.env, tenantId);
    const direct = style?.mode === 'direct';
    if (!direct && !(await isAddressWhitelisted(c.env, tenantId, target))) {
      return c.json({ error: 'target_not_whitelisted', tenant_id: tenantId, target_address: target }, 403);
    }
    if (!direct && !(await isTrustedTarget(c.env, tenantId, target))) {
      const open = await countOpenIntentsForTarget(c.env, tenantId, target, now);
      if (open >= maxOpenIntentsPerTarget(c.env)) {
        return c.json({ error: 'too_many_open_intents', target_address: target }, 429);
      }
    }
    const metadata = {
      ...(original.metadata_json ? (JSON.parse(original.metadata_json) as Record<string, unknown>) : {}),
      receipt_of: original.sid,
    };
    const sid = await insertWithRetry(
      c.env, target, original.amount_cents,
      Math.max(original.expires_at - now, DEFAULT_TTL_SECONDS),
      { target_address: target, sid: body.sid, label: original.label ?? undefined, metadata },
      tenantId, original.created_with_key === 1,
    );
    if (sid === 'conflict') return c.json({ error: 'sid_already_exists' }, 409);
    if (!sid) return c.json({ error: 'sid_collision_after_retries' }, 500);
    const intent = await getIntent(c.env, sid);
    if (!intent) return c.json({ error: 'intent_not_persisted' }, 500);
    const origin = new URL(c.req.url).origin;
    const sepa = await getSepaDetails(c.env, tenantId);
    const status = computeStage({ intent, order: null, forward: null, now });
    return c.json({ ...intentResponseJson(intent, origin, sepa, style), status }, 201);
  });

  registerReceiptRoutes(api);
  registerSimulateRoute(api);
  registerMoneriumSandboxFundRoute(api);

  return api;
}

type IntentCtx = Context<{ Bindings: Env }>;

/// POST /api/intents for a sandbox tenant (ADR 0024 D5). Same validation of
/// amount, TTL and sid as production; no rail, whitelist or SR-01 cap, and no
/// receipt sids (receipts are anchored on-chain).
async function createSandboxIntent(
  c: IntentCtx,
  body: CreateIntentBody,
  tenantId: string,
  secretKey: boolean,
  returnUrl: string | null,
): Promise<Response> {
  const target = (body.target_address ?? '').trim();
  const amountEur = parseAmount(body.amount_eur);
  if (amountEur === null) return c.json({ error: 'invalid_amount_eur' }, 400);
  const amountCents = Math.round(amountEur * 100);
  if (amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return c.json({ error: 'amount_out_of_range', max: MAX_AMOUNT_CENTS }, 400);
  }
  if (body.expires_in_seconds !== undefined && !Number.isFinite(body.expires_in_seconds)) {
    return c.json({ error: 'invalid_expires_in_seconds' }, 400);
  }
  const ttl = Math.min(Math.max(Math.floor(body.expires_in_seconds ?? DEFAULT_TTL_SECONDS), 60), MAX_TTL_SECONDS);
  if (body.sid !== undefined && !SID_RE.test(body.sid)) return c.json({ error: 'invalid_sid' }, 400);
  if (body.sid !== undefined && isReceiptSid(body.sid)) return c.json({ error: 'receipts_not_in_sandbox' }, 400);
  const sid = await insertWithRetry(c.env, target, amountCents, ttl, body, tenantId, secretKey, returnUrl);
  if (sid === 'conflict') return c.json({ error: 'sid_already_exists' }, 409);
  if (!sid) return c.json({ error: 'sid_collision_after_retries' }, 500);
  const intent = await getIntent(c.env, sid);
  if (!intent) return c.json({ error: 'intent_not_persisted' }, 500);
  await touchSandboxTenant(c.env, tenantId);
  const origin = new URL(c.req.url).origin;
  const sepa = await getSepaDetails(c.env, tenantId);
  const status = computeStage({ intent, order: null, forward: null, now: Math.floor(Date.now() / 1000) });
  return c.json({ ...sandboxView(intentResponseJson(intent, origin, sepa, null), origin), status });
}

/// A sandbox intent must never be payable with real money: no IBAN, no QR,
/// no HUB3 (ADR 0024 D5). Everything else keeps the production shape.
export function sandboxView(json: Record<string, unknown>, origin: string): Record<string, unknown> {
  return {
    ...json,
    iban: null,
    beneficiary_name: null,
    bic: null,
    epc_qr_data: null,
    hub3_data: null,
    sandbox: true,
    simulate_url: `${origin}/api/intents/${json.sid as string}/simulate`,
  };
}

const STATES: readonly IntentStateFilter[] = ['pending', 'paid', 'expired'];

/// The tenant behind a SECRET key (live or test), or why not.
async function secretKeyCaller(
  c: IntentCtx,
): Promise<{ ok: true; tenantId: string; sandbox: boolean } | { ok: false; status: 401 | 403; error: string }> {
  const r = await resolveRequestTenant(c.env, c.req.raw.headers);
  if (!r.ok) return { ok: false, status: r.error === 'tenant_suspended' ? 403 : 401, error: r.error };
  if (r.keyKind === null) return { ok: false, status: 401, error: 'missing_tenant_key' };
  if (r.keyKind !== 'secret') return { ok: false, status: 403, error: 'secret_key_required' };
  return { ok: true, tenantId: r.tenantId, sandbox: r.sandbox === true };
}

/// ISO-8601 `created_from` (inclusive) / `created_to` (exclusive).
function parseRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
): { ok: true; from: number | null; to: number | null } | { ok: false; error: string } {
  const parse = (v: string | undefined): number | null | 'bad' => {
    if (v === undefined || v === '') return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 'bad';
  };
  const from = parse(fromRaw);
  if (from === 'bad') return { ok: false, error: 'invalid_created_from' };
  const to = parse(toRaw);
  if (to === 'bad') return { ok: false, error: 'invalid_created_to' };
  return { ok: true, from, to };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/// Whether a tenant may use an http loopback `return_url` (local development).
/// A self-serve sandbox tenant may, and so may a rail tenant on Monerium's
/// sandbox: neither moves real money. A production tenant never may.
export async function returnUrlAllowsLoopback(
  env: Env,
  tenant: { tenantId: string; sandbox?: boolean },
): Promise<boolean> {
  if (tenant.sandbox === true) return true;
  const rail = await getTenantRailRow(env, tenant.tenantId);
  return rail?.monerium_env === 'sandbox';
}

/// ADR 0024 D6. Absolute, ≤ 2048 chars, no credentials, no fragment; https,
/// or http on a loopback host when `allowLoopback` (see
/// `returnUrlAllowsLoopback`).
export function validateReturnUrl(raw: unknown, allowLoopback: boolean): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.hash) return null;
  if (u.protocol === 'https:') return u.toString();
  if (u.protocol === 'http:' && allowLoopback && LOOPBACK_HOSTS.has(u.hostname)) return u.toString();
  return null;
}

/// Why a tenant may not issue payment QRs right now, or null when it may.
/// The default tenant (ITalk) is never refused here — its behaviour is
/// unchanged by ADR 0017.
async function tenantRailRefusal(
  env: Env,
  tenantId: string,
): Promise<'tenant_rail_disabled' | 'tenant_rail_not_configured' | null> {
  if (isLegacyTenant(env, tenantId)) return null;
  if (!multiTenantEnabled(env)) return 'tenant_rail_disabled';
  const rail = await getTenantRail(env, tenantId);
  if (!rail || !rail.webhookSecret) return 'tenant_rail_not_configured';
  return null;
}

/// Builds the full intent representation returned to API callers and used
/// by the checkout page. Kept in one place so the shape is consistent
/// between create + status endpoints.
export function intentResponseJson(
  intent: import('./db').PaymentIntentRow,
  origin: string,
  sepa: SepaDetails,
  /// Tenant's rail style; null/absent = the `mpt:` reference (default tenant).
  style: ReferenceStyle | null = null,
): Record<string, unknown> {
  const memo = intentReference(style, intent);
  const amountEur = (intent.amount_cents / 100).toFixed(2);
  const epcText = buildEpcText({
    beneficiaryName: sepa.beneficiaryName,
    iban: sepa.iban,
    amountEur: intent.amount_cents / 100,
    purposeCode: 'OTHR',
    remittanceInfo: memo,
    bic: sepa.bic,
  });
  // HUB3 PDF417 for apps that scan only Croatian uplatnice (see hub3.ts).
  const hub3Text = buildIntentHub3Text(intent, sepa);
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
    iban: sepa.iban,
    beneficiary_name: sepa.beneficiaryName,
    bic: sepa.bic,
    epc_qr_data: epcText,
    hub3_data: hub3Text,
    tenant_id: intent.tenant_id,
    checkout_url: `${origin}/checkout/${intent.sid}`,
    status_url: `${origin}/api/intents/${intent.sid}`,
    status_stream_url: `${origin}/api/intents/${intent.sid}/stream`,
    created_at: isoFromUnix(intent.created_at),
    expires_at: isoFromUnix(intent.expires_at),
    paid_at: intent.paid_at ? isoFromUnix(intent.paid_at) : null,
    monerium_order_id: intent.monerium_order_id,
    forward_tx_hash: intent.forward_tx_hash,
    amount_received_cents: intent.amount_received_cents,
    return_url: intent.return_url ?? null,
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
  const { order, forward, knownPayer } = await loadStageContext(env, intent);
  if (forward && forward.status === 'submitted' && forward.tx_hash) {
    const check = confirmForwardIfMined(env, forward);
    if (executionCtx) executionCtx.waitUntil(check);
    else await check.catch(() => {});
  }
  return computeStage({
    intent, order, forward, knownPayer,
    now: Math.floor(Date.now() / 1000),
  });
}

async function insertWithRetry(
  env: Env,
  target: string,
  amountCents: number,
  ttlSeconds: number,
  body: CreateIntentBody,
  tenantId: string,
  createdWithKey: boolean,
  returnUrl: string | null = null,
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
        tenantId,
        createdWithKey,
        returnUrl,
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
        tenantId,
        createdWithKey,
        returnUrl,
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

function maxOpenIntentsPerTarget(env: Env): number {
  const n = Number(env.MAX_OPEN_INTENTS_PER_TARGET);
  return Number.isFinite(n) && n > 0 ? n : 20;
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
