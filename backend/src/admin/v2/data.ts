// Admin v2 — upiti. Samo čitanje; sve promjene idu kroz postojeće
// /admin/api/* rute (iste provjere, isti audit).

import type { Env } from '../../types';
import type { Scope } from './scope';

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Status uplate (intent je objekt; sve ostalo su njegovi koraci)
// ---------------------------------------------------------------------------

export type PayStatus = 'paid' | 'processing' | 'stuck' | 'pending' | 'expired';

export const PAY_STATUSES: PayStatus[] = ['paid', 'processing', 'stuck', 'pending', 'expired'];

/// Izvedeni status u SQL-u, nad aliasom `i` (payment_intents) i `s`
/// (intent_settlements). „Zapelo” = zadnji forward za taj sid je
/// failed/blocked; „U obradi” = novac je stigao (settlement postoji), intent
/// još nije plaćen (forward u letu, ili manje plaćeno).
const STATUS_SQL = `CASE
    WHEN i.state = 'paid' THEN 'paid'
    WHEN (SELECT f.status FROM monerium_forwards f WHERE f.sid = i.sid ORDER BY f.id DESC LIMIT 1)
         IN ('failed', 'blocked') THEN 'stuck'
    WHEN i.state = 'pending' AND s.sid IS NOT NULL THEN 'processing'
    WHEN i.state = 'pending' AND i.expires_at >= ${'?'} THEN 'pending'
    ELSE 'expired'
  END`;

export interface PaymentListRow {
  sid: string;
  tenant_id: string | null;
  amount_cents: number;
  amount_received_cents: number | null;
  currency: string;
  label: string | null;
  target_address: string;
  state: string;
  provider: string | null;
  short_ref: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  settled_provider: string | null;
  v2_status: PayStatus;
}

export interface PaymentFilter {
  status?: PayStatus;
  tenant?: string;
  provider?: string;
  q?: string;
  target?: string;
  limit?: number;
  offset?: number;
}

function paymentBase(scope: Scope, f: PaymentFilter): { sql: string; args: unknown[] } {
  const t = f.tenant ? scope.whereTenant(f.tenant, 'i.tenant_id') : scope.where('i.tenant_id');
  const where = [t.sql];
  const args: unknown[] = [now(), ...t.args];
  if (f.provider) {
    where.push(`COALESCE(i.provider, 'monerium') = ?`);
    args.push(f.provider);
  }
  if (f.target) {
    where.push('i.target_address = ?');
    args.push(f.target.toLowerCase());
  }
  if (f.q) {
    where.push('(i.sid LIKE ? OR i.label LIKE ? OR i.short_ref LIKE ?)');
    const like = `%${f.q}%`;
    args.push(like, like, like);
  }
  return {
    sql: `SELECT i.sid, i.tenant_id, i.amount_cents, i.amount_received_cents, i.currency, i.label,
                 i.target_address, i.state, i.provider, i.short_ref, i.created_at, i.expires_at, i.paid_at,
                 s.provider AS settled_provider, ${STATUS_SQL} AS v2_status
            FROM payment_intents i
            LEFT JOIN intent_settlements s ON s.sid = i.sid
           WHERE ${where.join(' AND ')}`,
    args,
  };
}

export async function listPayments(
  env: Env,
  scope: Scope,
  f: PaymentFilter,
): Promise<{ items: PaymentListRow[]; total: number; counts: Record<PayStatus | 'all', number> }> {
  const base = paymentBase(scope, f);
  const countsRes = await env.DB.prepare(
    `SELECT v2_status, COUNT(*) AS c FROM (${base.sql}) GROUP BY v2_status`,
  ).bind(...base.args).all<{ v2_status: PayStatus; c: number }>();
  const counts = { all: 0, paid: 0, processing: 0, stuck: 0, pending: 0, expired: 0 } as Record<PayStatus | 'all', number>;
  for (const r of countsRes.results) {
    counts[r.v2_status] = r.c;
    counts.all += r.c;
  }
  const limit = Math.min(Math.max(f.limit ?? 25, 1), 100);
  const offset = Math.max(f.offset ?? 0, 0);
  const statusSql = f.status ? 'WHERE v2_status = ?' : '';
  const items = await env.DB.prepare(
    `SELECT * FROM (${base.sql}) ${statusSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...base.args, ...(f.status ? [f.status] : []), limit, offset).all<PaymentListRow>();
  return { items: items.results, total: f.status ? counts[f.status] : counts.all, counts };
}

// ---------------------------------------------------------------------------
// Jedna uplata sa svime što je na nju vezano
// ---------------------------------------------------------------------------

export interface PaymentBundle {
  intent: Record<string, unknown> & PaymentListRow & { metadata_json: string | null; forward_tx_hash: string | null; monerium_order_id: string | null; return_url?: string | null };
  settlement: { provider: string; settlement_ref: string; credit_event_id: number | null; created_at: number } | null;
  order: Record<string, unknown> & { id: string; state: string; kind: string; amount: string; counterpart_iban: string | null; counterpart_name: string | null; memo: string | null; placed_at: string | null; processed_at: string | null; tx_hashes: string | null } | null;
  events: Array<{ id: number; event_type: string | null; signature_ok: number; received_at: number; processing_note: string | null; order_id: string | null }>;
  forwards: Array<{ id: number; status: string; tx_hash: string | null; error: string | null; target_address: string; amount_cents: number | null; created_at: number; updated_at: number; attempts: number; order_id: string; memo_prefix: string | null }>;
  outbox: Array<{ id: string; type: string; status: string; attempts: number; last_status: number | null; last_error: string | null; created_at: number; delivered_at: number | null }>;
  credits: Array<{ id: number; provider: string; provider_ref: string; amount_cents: number; finality: string; debtor_name: string | null; debtor_account: string | null; matched_by: string | null; match_note: string | null; occurred_at: number }>;
}

export async function getPaymentBundle(env: Env, sid: string): Promise<PaymentBundle | null> {
  const intent = await env.DB.prepare(
    `SELECT i.*, s.provider AS settled_provider, ${STATUS_SQL} AS v2_status
       FROM payment_intents i LEFT JOIN intent_settlements s ON s.sid = i.sid
      WHERE i.sid = ?`,
  ).bind(now(), sid).first<PaymentBundle['intent']>();
  if (!intent) return null;
  const settlement = await env.DB.prepare(
    `SELECT provider, settlement_ref, credit_event_id, created_at FROM intent_settlements WHERE sid = ?`,
  ).bind(sid).first<NonNullable<PaymentBundle['settlement']>>();
  const orderId = intent.monerium_order_id ?? settlement?.settlement_ref ?? null;
  const order = orderId
    ? await env.DB.prepare(`SELECT * FROM monerium_orders WHERE id = ?`).bind(orderId).first<NonNullable<PaymentBundle['order']>>()
    : null;
  const events = await env.DB.prepare(
    `SELECT id, event_type, signature_ok, received_at, processing_note, order_id
       FROM monerium_webhook_events
      WHERE sid_extracted = ? OR sid_resolved = ? ${orderId ? 'OR order_id = ?' : ''}
      ORDER BY id ASC LIMIT 50`,
  ).bind(sid, sid, ...(orderId ? [orderId] : [])).all<PaymentBundle['events'][number]>();
  const forwards = await env.DB.prepare(
    `SELECT id, status, tx_hash, error, target_address, amount_cents, created_at, updated_at, attempts, order_id, memo_prefix
       FROM monerium_forwards
      WHERE sid = ? ${orderId ? 'OR order_id = ?' : ''}
      ORDER BY id ASC LIMIT 20`,
  ).bind(sid, ...(orderId ? [orderId] : [])).all<PaymentBundle['forwards'][number]>();
  const outbox = await env.DB.prepare(
    `SELECT id, type, status, attempts, last_status, last_error, created_at, delivered_at
       FROM webhook_outbox WHERE id LIKE ? ORDER BY created_at ASC LIMIT 20`,
  ).bind(`%${sid}`).all<PaymentBundle['outbox'][number]>();
  const credits = await env.DB.prepare(
    `SELECT id, provider, provider_ref, amount_cents, finality, debtor_name, debtor_account, matched_by,
            match_note, occurred_at
       FROM credit_events WHERE matched_sid = ? ORDER BY id ASC LIMIT 20`,
  ).bind(sid).all<PaymentBundle['credits'][number]>();
  return {
    intent,
    settlement: settlement ?? null,
    order: order ?? null,
    events: events.results,
    forwards: forwards.results,
    // `%_sid` bi u LIKE-u `_` tretirao kao bilo koji znak; provjeri točno.
    outbox: outbox.results.filter((o) => o.id.endsWith(`_${sid}`)),
    credits: credits.results,
  };
}

// ---------------------------------------------------------------------------
// Pregled
// ---------------------------------------------------------------------------

export interface Overview {
  days: number;
  volumeCents: number;
  paid: number;
  created: number;
  pendingNow: number;
  prevVolumeCents: number;
  series: Array<{ day: string; cents: number; count: number }>;
}

export async function getOverview(env: Env, scope: Scope, days: number): Promise<Overview> {
  const t = scope.where();
  const since = now() - days * 86400;
  const prevSince = since - days * 86400;
  const agg = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN state = 'paid' AND paid_at >= ? THEN COALESCE(amount_received_cents, amount_cents) ELSE 0 END) AS vol,
       SUM(CASE WHEN state = 'paid' AND paid_at >= ? AND paid_at < ? THEN COALESCE(amount_received_cents, amount_cents) ELSE 0 END) AS prev_vol,
       SUM(CASE WHEN state = 'paid' AND paid_at >= ? THEN 1 ELSE 0 END) AS paid,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS created,
       SUM(CASE WHEN state = 'pending' AND expires_at >= ? THEN 1 ELSE 0 END) AS pending_now
     FROM payment_intents WHERE ${t.sql}`,
  ).bind(since, prevSince, since, since, since, now(), ...t.args).first<{
    vol: number | null; prev_vol: number | null; paid: number | null; created: number | null; pending_now: number | null;
  }>();
  const series = await env.DB.prepare(
    `SELECT date(paid_at, 'unixepoch') AS day, SUM(COALESCE(amount_received_cents, amount_cents)) AS cents, COUNT(*) AS count
       FROM payment_intents
      WHERE state = 'paid' AND paid_at >= ? AND ${t.sql}
      GROUP BY day ORDER BY day`,
  ).bind(since, ...t.args).all<{ day: string; cents: number; count: number }>();
  // Popuni dane bez uplata nulom, da graf ima ravnu vremensku os.
  const byDay = new Map(series.results.map((r) => [r.day, r]));
  const filled: Overview['series'] = [];
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date((now() - d * 86400) * 1000).toISOString().slice(0, 10);
    filled.push(byDay.get(day) ?? { day, cents: 0, count: 0 });
  }
  return {
    days,
    volumeCents: agg?.vol ?? 0,
    prevVolumeCents: agg?.prev_vol ?? 0,
    paid: agg?.paid ?? 0,
    created: agg?.created ?? 0,
    pendingNow: agg?.pending_now ?? 0,
    series: filled,
  };
}

export interface AttentionItem {
  kind: 'parked_forward' | 'sig_fail' | 'unknown_tenant' | 'outbox_failed' | 'unmatched_credit';
  severity: 'warn' | 'error';
  title: string;
  sub: string;
  href: string;
  cta: string;
  at: number;
}

export interface ParkedForward {
  id: number;
  tenant_id: string | null;
  order_id: string;
  sid: string | null;
  status: string;
  error: string | null;
  amount_cents: number | null;
  target_address: string;
  updated_at: number;
}

/// Forwardi koji su stali (failed/blocked) i za čiji order ne postoji kasniji
/// živi ili riješeni forward — isto pravilo kao `parked` na v1 ekranu.
export async function listParkedForwards(env: Env, scope: Scope, limit = 20): Promise<ParkedForward[]> {
  const t = scope.where('f.tenant_id');
  const res = await env.DB.prepare(
    `SELECT f.id, f.tenant_id, f.order_id, f.sid, f.status, f.error, f.amount_cents, f.target_address, f.updated_at
       FROM monerium_forwards f
      WHERE f.status IN ('failed', 'blocked') AND ${t.sql}
        AND f.id = (SELECT MAX(g.id) FROM monerium_forwards g WHERE g.order_id = f.order_id)
      ORDER BY f.id DESC LIMIT ?`,
  ).bind(...t.args, limit).all<ParkedForward>();
  return res.results;
}

export async function getAttention(env: Env, scope: Scope, fmtAmount: (c: number | null) => string, tenantName: (id: string | null) => string): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];
  for (const f of await listParkedForwards(env, scope, 10)) {
    items.push({
      kind: 'parked_forward',
      severity: 'warn',
      title: f.status === 'blocked' ? 'Forward blokiran' : 'Forward neuspio',
      sub: `${tenantName(f.tenant_id)} · ${fmtAmount(f.amount_cents)} · ${(f.error ?? '').slice(0, 90) || f.status}`,
      href: f.sid ? `/admin/v2/payments/${encodeURIComponent(f.sid)}` : `/admin/v2/payouts?status=${f.status}`,
      cta: f.status === 'failed' ? 'Ponovi' : 'Riješi',
      at: f.updated_at,
    });
  }
  const t = scope.where();
  const sig = await env.DB.prepare(
    `SELECT COUNT(*) AS c, MAX(received_at) AS last FROM monerium_webhook_events
      WHERE signature_ok = 0 AND event_type IS NOT 'unknown_tenant' AND received_at >= ? AND ${t.sql}`,
  ).bind(now() - 86400, ...t.args).first<{ c: number; last: number | null }>();
  if (sig && sig.c > 0) {
    items.push({
      kind: 'sig_fail',
      severity: 'error',
      title: `Neispravan potpis webhooka ×${sig.c}`,
      sub: 'Monerium · zadnja 24 h',
      href: '/admin/v2/developers?tab=events&sig=0',
      cta: 'Pogledaj',
      at: sig.last ?? 0,
    });
  }
  // Webhook na URL tenanta kojeg nema: potpis se ni ne provjerava (nema čijim
  // tajnim ključem), pa to nije „neispravan potpis” nego krivo postavljen URL.
  // tenant_id je NULL, pa se vidi samo u produkcijskom prikazu (zadani tenant).
  if (scope.mode === 'production') {
    const ut = await env.DB.prepare(
      `SELECT COUNT(*) AS c, MAX(received_at) AS last, MAX(processing_note) AS note FROM monerium_webhook_events
        WHERE event_type = 'unknown_tenant' AND received_at >= ?`,
    ).bind(now() - 86400).first<{ c: number; last: number | null; note: string | null }>();
    if (ut && ut.c > 0) {
      items.push({
        kind: 'unknown_tenant',
        severity: 'warn',
        title: `Webhook na nepoznat tenant ×${ut.c}`,
        sub: `${(ut.note ?? '').replace(/^unknown_tenant:\s*/, '').slice(0, 64)} · zadnja 24 h · krivo postavljen URL pretplate`,
        href: '/admin/v2/developers?tab=events&sig=0',
        cta: 'Pogledaj',
        at: ut.last ?? 0,
      });
    }
  }
  const ob = await env.DB.prepare(
    `SELECT COUNT(*) AS c, MAX(created_at) AS last FROM webhook_outbox
      WHERE status = 'failed' AND created_at >= ? AND ${t.sql}`,
  ).bind(now() - 7 * 86400, ...t.args).first<{ c: number; last: number | null }>();
  if (ob && ob.c > 0) {
    items.push({
      kind: 'outbox_failed',
      severity: 'error',
      title: `Isporuka merchant webhooka pala ×${ob.c}`,
      sub: 'zadnjih 7 dana',
      href: '/admin/v2/developers?tab=outbox&status=failed',
      cta: 'Pošalji ponovno',
      at: ob.last ?? 0,
    });
  }
  const cr = await env.DB.prepare(
    `SELECT COUNT(*) AS c, MAX(occurred_at) AS last FROM credit_events
      WHERE matched_sid IS NULL AND occurred_at >= ? AND ${t.sql}`,
  ).bind(now() - 7 * 86400, ...t.args).first<{ c: number; last: number | null }>();
  if (cr && cr.c > 0) {
    items.push({
      kind: 'unmatched_credit',
      severity: 'warn',
      title: `Priljev bez intenta ×${cr.c}`,
      sub: 'uplata stigla, nije uparena · zadnjih 7 dana',
      href: '/admin/v2/developers?tab=inbox&unmatched=1',
      cta: 'Upari',
      at: cr.last ?? 0,
    });
  }
  return items.sort((a, b) => (a.severity === b.severity ? b.at - a.at : a.severity === 'error' ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Isplate (forwardi)
// ---------------------------------------------------------------------------

export async function listPayouts(
  env: Env,
  scope: Scope,
  f: { status?: string; limit?: number; offset?: number },
): Promise<{ items: Array<ParkedForward & { tx_hash: string | null; created_at: number; memo_prefix: string | null }>; total: number }> {
  const t = scope.where();
  const where = [t.sql];
  const args: unknown[] = [...t.args];
  if (f.status) { where.push('status = ?'); args.push(f.status); }
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM monerium_forwards WHERE ${where.join(' AND ')}`).bind(...args).first<{ c: number }>();
  const res = await env.DB.prepare(
    `SELECT id, tenant_id, order_id, sid, status, error, amount_cents, target_address, updated_at, tx_hash, created_at, memo_prefix
       FROM monerium_forwards WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
  ).bind(...args, Math.min(f.limit ?? 50, 100), f.offset ?? 0).all<ParkedForward & { tx_hash: string | null; created_at: number; memo_prefix: string | null }>();
  return { items: res.results, total: total?.c ?? 0 };
}

// ---------------------------------------------------------------------------
// Developeri
// ---------------------------------------------------------------------------

export async function listWebhookEvents(env: Env, scope: Scope, f: { sig?: '0' | '1'; offset?: number }) {
  const t = scope.where();
  const where = [t.sql];
  const args: unknown[] = [...t.args];
  if (f.sig) { where.push('signature_ok = ?'); args.push(Number(f.sig)); }
  const res = await env.DB.prepare(
    `SELECT id, order_id, event_type, signature_ok, received_at, tenant_id, sid_extracted, sid_resolved,
            amount_cents, processing_note
       FROM monerium_webhook_events WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT 50 OFFSET ?`,
  ).bind(...args, f.offset ?? 0).all<{
    id: number; order_id: string | null; event_type: string | null; signature_ok: number; received_at: number;
    tenant_id: string | null; sid_extracted: string | null; sid_resolved: string | null; amount_cents: number | null; processing_note: string | null;
  }>();
  return res.results;
}

export async function getWebhookEvent(env: Env, id: number) {
  return env.DB.prepare(`SELECT * FROM monerium_webhook_events WHERE id = ?`).bind(id).first<{
    id: number; order_id: string | null; event_type: string | null; signature_ok: number; received_at: number;
    tenant_id: string | null; sid_extracted: string | null; sid_resolved: string | null; amount_cents: number | null;
    processing_note: string | null; payload: string; headers_json: string | null;
  }>();
}

export async function listInbox(env: Env, scope: Scope, f: { unmatched?: boolean }) {
  const t = scope.where();
  const res = await env.DB.prepare(
    `SELECT id, provider, provider_ref, tenant_id, amount_cents, currency, remittance, debtor_name, debtor_account,
            finality, occurred_at, matched_sid, matched_by, match_note
       FROM credit_events WHERE ${t.sql} ${f.unmatched ? 'AND matched_sid IS NULL' : ''}
      ORDER BY id DESC LIMIT 50`,
  ).bind(...t.args).all<{
    id: number; provider: string; provider_ref: string; tenant_id: string; amount_cents: number; currency: string;
    remittance: string | null; debtor_name: string | null; debtor_account: string | null; finality: string;
    occurred_at: number; matched_sid: string | null; matched_by: string | null; match_note: string | null;
  }>();
  return res.results;
}

export async function listOutbox(env: Env, scope: Scope, f: { status?: string }) {
  const t = scope.where();
  const res = await env.DB.prepare(
    `SELECT id, type, tenant_id, status, attempts, last_status, last_error, created_at, delivered_at
       FROM webhook_outbox WHERE ${t.sql} ${f.status ? 'AND status = ?' : ''}
      ORDER BY created_at DESC LIMIT 50`,
  ).bind(...t.args, ...(f.status ? [f.status] : [])).all<{
    id: string; type: string; tenant_id: string | null; status: string; attempts: number; last_status: number | null;
    last_error: string | null; created_at: number; delivered_at: number | null;
  }>();
  return res.results;
}

/// Audit log. Sistemski redovi (cron `outflow.tick` svaki sat) su po defaultu
/// skriveni — u v1 su činili gotovo cijeli popis.
export async function listAuditV2(env: Env, scope: Scope, f: { system?: boolean; tenant?: string; limit?: number }) {
  const t = f.tenant ? scope.whereTenant(f.tenant) : scope.where();
  const res = await env.DB.prepare(
    `SELECT id, at, tenant_id, action, address, actor, detail FROM tenant_audit_log
      WHERE ${t.sql} ${f.system ? '' : `AND actor <> 'system'`}
      ORDER BY id DESC LIMIT ?`,
  ).bind(...t.args, f.limit ?? 100).all<{ id: number; at: number; tenant_id: string | null; action: string; address: string | null; actor: string; detail: string | null }>();
  return res.results;
}

// ---------------------------------------------------------------------------
// Tenanti
// ---------------------------------------------------------------------------

export async function listTenantStats(env: Env, scope: Scope) {
  const since = now() - 30 * 86400;
  const res = await env.DB.prepare(
    `SELECT COALESCE(tenant_id, ?) AS tid,
            SUM(CASE WHEN state = 'paid' AND paid_at >= ? THEN COALESCE(amount_received_cents, amount_cents) ELSE 0 END) AS vol,
            SUM(CASE WHEN state = 'paid' AND paid_at >= ? THEN 1 ELSE 0 END) AS paid,
            MAX(created_at) AS last_intent
       FROM payment_intents GROUP BY tid`,
  ).bind(scope.defaultId, since, since).all<{ tid: string; vol: number; paid: number; last_intent: number | null }>();
  return new Map(res.results.map((r) => [r.tid, r]));
}

export async function getTenantDetail(env: Env, id: string) {
  const tenant = await env.DB.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(id).first<{
    id: string; name: string; status: string; iban: string; bic: string | null; beneficiary_name: string; sandbox: number; created_at: number;
  }>();
  const rail = await env.DB.prepare(`SELECT * FROM tenant_rail WHERE tenant_id = ?`).bind(id).first<{
    monerium_env: string; chain: string; client_id: string; client_secret_enc: string | null; profile_id: string;
    receiving_safe: string; roles_modifier: string | null; role_key: string | null; router_address: string | null;
    router_key_enc: string | null; webhook_secret_enc: string | null; webhook_subscription_id: string | null;
    outbound_webhook_url: string | null; outbound_webhook_secret_enc: string | null; mode: string | null;
    verified_at: number | null; verify_report: string | null;
  }>();
  const sandboxRow = await env.DB.prepare(`SELECT * FROM sandbox_tenants WHERE tenant_id = ?`).bind(id).first<{ outbound_webhook_url: string | null; expires_at: number | null }>();
  const campaigns = await env.DB.prepare(
    `SELECT campaign_id, safe_address, label, created_at, revoked_at FROM tenant_campaigns WHERE tenant_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`,
  ).bind(id).all<{ campaign_id: string; safe_address: string; label: string | null; created_at: number; revoked_at: number | null }>();
  const addresses = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM tenant_payout_addresses WHERE tenant_id = ? AND revoked_at IS NULL`,
  ).bind(id).first<{ c: number }>();
  const accounts = await env.DB.prepare(
    `SELECT id, provider, mode, iban, environment, external_account_id, label, active, created_at FROM receiving_accounts WHERE tenant_id = ? ORDER BY id`,
  ).bind(id).all<{ id: number; provider: string; mode: string; iban: string | null; environment: string; external_account_id: string | null; label: string | null; active: number; created_at: number }>();
  const keys = await env.DB.prepare(
    `SELECT key_hash, kind, label, created_at, revoked_at FROM tenant_api_keys WHERE tenant_id = ? ORDER BY revoked_at IS NOT NULL, created_at DESC`,
  ).bind(id).all<{ key_hash: string; kind: string; label: string | null; created_at: number; revoked_at: number | null }>();
  return {
    tenant: tenant ?? null,
    rail: rail ?? null,
    sandboxRow: sandboxRow ?? null,
    campaigns: campaigns.results,
    addressCount: addresses?.c ?? 0,
    accounts: accounts.results,
    keys: keys.results,
  };
}

// ---------------------------------------------------------------------------
// Pretraga
// ---------------------------------------------------------------------------

export type SearchHit = { kind: string; label: string; sub: string; href: string };

export async function search(env: Env, raw: string): Promise<SearchHit[]> {
  const q = raw.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  const pay = (sid: string, sub: string) => ({ kind: 'Uplata', label: sid, sub, href: `/admin/v2/payments/${encodeURIComponent(sid)}` });

  const bySid = await env.DB.prepare(`SELECT sid, amount_cents, state FROM payment_intents WHERE sid = ? OR short_ref = ? COLLATE NOCASE OR short_ref = ? COLLATE NOCASE LIMIT 5`)
    .bind(q, q, q.replace(/[\s-]/g, '')).all<{ sid: string; amount_cents: number; state: string }>();
  for (const r of bySid.results) hits.push(pay(r.sid, `${(r.amount_cents / 100).toFixed(2)} EUR · ${r.state}`));

  const bySettle = await env.DB.prepare(`SELECT sid, provider FROM intent_settlements WHERE settlement_ref = ? LIMIT 5`).bind(q).all<{ sid: string; provider: string }>();
  for (const r of bySettle.results) hits.push(pay(r.sid, `namireno kroz ${r.provider} · ${q}`));

  const order = await env.DB.prepare(`SELECT id, amount, state FROM monerium_orders WHERE id = ?`).bind(q).first<{ id: string; amount: string; state: string }>();
  if (order && !bySettle.results.length) hits.push({ kind: 'Monerium order', label: order.id, sub: `${order.amount} EUR · ${order.state}`, href: `/admin/orders/${encodeURIComponent(order.id)}` });

  if (/^0x[0-9a-fA-F]{64}$/.test(q)) {
    const lc = q.toLowerCase();
    const fw = await env.DB.prepare(`SELECT id, sid, status, order_id FROM monerium_forwards WHERE lower(tx_hash) = ? LIMIT 5`).bind(lc).all<{ id: number; sid: string | null; status: string; order_id: string }>();
    for (const r of fw.results) hits.push(r.sid ? pay(r.sid, `forward #${r.id} · ${r.status}`) : { kind: 'Forward', label: `#${r.id}`, sub: r.status, href: `/admin/v2/payouts` });
    const it = await env.DB.prepare(`SELECT sid FROM payment_intents WHERE lower(forward_tx_hash) = ? LIMIT 5`).bind(lc).all<{ sid: string }>();
    for (const r of it.results) hits.push(pay(r.sid, 'forward tx'));
  } else if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS c FROM payment_intents WHERE target_address = ?`).bind(q.toLowerCase()).first<{ c: number }>();
    if (c && c.c > 0) hits.push({ kind: 'Odredište', label: q, sub: `${c.c} uplata na ovu adresu`, href: `/admin/v2/payments?target=${q.toLowerCase()}` });
    const camp = await env.DB.prepare(`SELECT tenant_id, campaign_id, label FROM tenant_campaigns WHERE lower(safe_address) = ? LIMIT 5`).bind(q.toLowerCase()).all<{ tenant_id: string; campaign_id: string; label: string | null }>();
    for (const r of camp.results) hits.push({ kind: 'Projekt', label: r.label ?? r.campaign_id, sub: `${r.tenant_id} · ${r.campaign_id}`, href: `/admin/v2/tenants/${encodeURIComponent(r.tenant_id)}` });
  } else if (/^[A-Z]{2}\d{2}[A-Z0-9 ]{10,}$/i.test(q)) {
    const iban = q.replace(/\s/g, '').toUpperCase();
    const ords = await env.DB.prepare(
      `SELECT o.id, o.amount, o.state, s.sid FROM monerium_orders o LEFT JOIN intent_settlements s ON s.settlement_ref = o.id
        WHERE replace(upper(o.counterpart_iban), ' ', '') = ? ORDER BY o.placed_at DESC LIMIT 10`,
    ).bind(iban).all<{ id: string; amount: string; state: string; sid: string | null }>();
    for (const r of ords.results) hits.push(r.sid ? pay(r.sid, `uplatitelj ${iban} · ${r.amount} EUR`) : { kind: 'Monerium order', label: r.id, sub: `uplatitelj ${iban} · ${r.amount} EUR · ${r.state}`, href: `/admin/orders/${encodeURIComponent(r.id)}` });
    const ce = await env.DB.prepare(
      `SELECT id, provider, amount_cents, matched_sid FROM credit_events WHERE replace(upper(debtor_account), ' ', '') = ? ORDER BY id DESC LIMIT 10`,
    ).bind(iban).all<{ id: number; provider: string; amount_cents: number; matched_sid: string | null }>();
    for (const r of ce.results) if (r.matched_sid) hits.push(pay(r.matched_sid, `${r.provider} · uplatitelj ${iban}`));
    const ten = await env.DB.prepare(`SELECT id, name FROM tenants WHERE replace(upper(iban), ' ', '') = ?`).bind(iban).all<{ id: string; name: string }>();
    for (const r of ten.results) hits.push({ kind: 'Tenant', label: r.name, sub: `prihvatni IBAN · ${r.id}`, href: `/admin/v2/tenants/${encodeURIComponent(r.id)}` });
  }

  if (!hits.length && q.length >= 3) {
    const like = await env.DB.prepare(`SELECT sid, amount_cents, state, label FROM payment_intents WHERE sid LIKE ? OR label LIKE ? ORDER BY created_at DESC LIMIT 10`)
      .bind(`%${q}%`, `%${q}%`).all<{ sid: string; amount_cents: number; state: string; label: string | null }>();
    for (const r of like.results) hits.push(pay(r.sid, `${r.label ?? '—'} · ${(r.amount_cents / 100).toFixed(2)} EUR · ${r.state}`));
    const ten = await env.DB.prepare(`SELECT id, name FROM tenants WHERE id LIKE ? OR name LIKE ? LIMIT 5`).bind(`%${q}%`, `%${q}%`).all<{ id: string; name: string }>();
    for (const r of ten.results) hits.push({ kind: 'Tenant', label: r.name, sub: r.id, href: `/admin/v2/tenants/${encodeURIComponent(r.id)}` });
  }
  // Isti cilj iz dva izvora = jedan pogodak.
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.href) ? false : (seen.add(h.href), true)));
}
