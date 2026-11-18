// Admin v2 — rute pod /admin/v2. Prijava, CSP nonce i CSRF dolaze od
// mountAdminAuth (sve pod /admin), pa ovdje nema vlastite autentikacije.
// Samo čitanje; akcije na stranicama zovu postojeće /admin/api/* POST rute.

import type { Context, Hono } from 'hono';

import type { Env } from '../../types';
import { adminSession } from '../auth/mount';
import {
  getAttention, getOverview, getPaymentBundle, getResolveBundle, getTenantDetail, getWebhookEvent, listAuditV2, listInbox, listOutbox,
  listParkedForwards, listPayments, listPayouts, listTenantStats, listWebhookEvents, PAY_STATUSES, search,
  type PaymentFilter, type PayStatus,
} from './data';
import {
  DevelopersPage, EventDetailPage, HomePage, PaymentDetailPage, PaymentsPage, PayoutsPage, ResolvePage, SearchPage, TenantDetailPage,
  TenantsPage, type DevTab,
} from './pages';
import { loadScope, MODE_COOKIE, modeFromCookie, type Mode, type Scope } from './scope';
import { fmtEur, Layout, type NavKey } from './ui';
import { defaultTenantId } from '../../tenants/whitelist';
import { getTenantRail } from '../../tenants/rail';
import { listOffRailLegs, makeOffRailDeps, type OffRailLeg } from '../../monerium/offrail';
import { eurToWei } from '../../monerium/forward';

type Ctx = Context<{ Bindings: Env }>;

async function scopeOf(c: Ctx): Promise<Scope> {
  return loadScope(c.env, modeFromCookie(c.req.header('cookie')));
}

function page(c: Ctx, scope: Scope, title: string, nav: NavKey, body: unknown, q?: string) {
  const url = new URL(c.req.url);
  return c.html(
    <Layout title={title} nav={nav} scope={scope} email={adminSession(c)?.email ?? null} path={url.pathname + url.search} q={q}>
      {body as never}
    </Layout>,
  );
}

function paymentFilter(c: Ctx): PaymentFilter {
  const status = c.req.query('status');
  const offset = Number(c.req.query('offset') ?? '0');
  return {
    status: (PAY_STATUSES as string[]).includes(status ?? '') ? (status as PayStatus) : undefined,
    tenant: c.req.query('tenant') || undefined,
    provider: c.req.query('provider') || undefined,
    q: (c.req.query('q') ?? '').trim() || undefined,
    target: /^0x[0-9a-fA-F]{40}$/.test(c.req.query('target') ?? '') ? c.req.query('target') : undefined,
    limit: 25,
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Formula injection u Excelu/Sheetsu: vodeći = + - @ postaju tekst.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function mountAdminV2(app: Hono<{ Bindings: Env }>): void {
  app.get('/admin/v2/mode/:mode', (c) => {
    const mode: Mode = c.req.param('mode') === 'sandbox' ? 'sandbox' : 'production';
    const next = c.req.query('next') ?? '';
    // Samo unutar v2; detalj uplate/tenanta iz drugog okruženja vodi na listu.
    const target = /^\/admin\/v2(\/(payments|tenants|developers\/events)\/[^?]+)/.test(next)
      ? next.replace(/^(\/admin\/v2\/(payments|tenants|developers)).*$/, '$1')
      : next.startsWith('/admin/v2') && !next.startsWith('//') ? next : '/admin/v2';
    const secure = new URL(c.req.url).protocol === 'https:' ? '; Secure' : '';
    c.header('set-cookie', `${MODE_COOKIE}=${mode}; Path=/admin; Max-Age=31536000; SameSite=Lax; HttpOnly${secure}`);
    return c.redirect(target, 302);
  });

  app.get('/admin/v2', async (c) => {
    const scope = await scopeOf(c);
    const days = [1, 7, 30, 90].includes(Number(c.req.query('days'))) ? Number(c.req.query('days')) : 7;
    const [ov, attention, recent] = await Promise.all([
      getOverview(c.env, scope, days),
      getAttention(c.env, scope, fmtEur, (id) => scope.byId(id)?.name ?? id ?? scope.defaultId),
      listPayments(c.env, scope, { limit: 8 }),
    ]);
    return page(c, scope, 'Pregled', 'home', <HomePage scope={scope} ov={ov} attention={attention} recent={recent.items} />);
  });
  app.get('/admin/v2/', (c) => c.redirect('/admin/v2', 301));

  app.get('/admin/v2/payments', async (c) => {
    const scope = await scopeOf(c);
    const f = paymentFilter(c);
    const r = await listPayments(c.env, scope, f);
    return page(c, scope, 'Uplate', 'payments', <PaymentsPage scope={scope} f={f} items={r.items} total={r.total} counts={r.counts} />);
  });

  app.get('/admin/v2/payments.csv', async (c) => {
    const scope = await scopeOf(c);
    const f = { ...paymentFilter(c), limit: 100 };
    const rows: string[] = ['sid,status,amount_eur,received_eur,label,tenant,provider,short_ref,target,created_at,paid_at'];
    for (let offset = 0; offset < 5000; offset += 100) {
      const r = await listPayments(c.env, scope, { ...f, offset });
      for (const p of r.items) {
        rows.push([
          p.sid, p.v2_status, (p.amount_cents / 100).toFixed(2), p.amount_received_cents == null ? '' : (p.amount_received_cents / 100).toFixed(2),
          p.label, p.tenant_id ?? scope.defaultId, p.settled_provider ?? p.provider ?? 'monerium', p.short_ref, p.target_address,
          new Date(p.created_at * 1000).toISOString(), p.paid_at ? new Date(p.paid_at * 1000).toISOString() : '',
        ].map(csvCell).join(','));
      }
      if (r.items.length < 100) break;
    }
    c.header('content-type', 'text/csv; charset=utf-8');
    c.header('content-disposition', `attachment; filename="mpt-uplate-${scope.mode}-${new Date().toISOString().slice(0, 10)}.csv"`);
    return c.body(rows.join('\n') + '\n');
  });

  app.get('/admin/v2/payments/:sid', async (c) => {
    const scope = await scopeOf(c);
    const b = await getPaymentBundle(c.env, c.req.param('sid'));
    if (!b) return page(c, scope, 'Nije pronađeno', 'payments', <div class="empty">Uplata „{c.req.param('sid')}” ne postoji. <a href="/admin/v2/payments">Natrag</a></div>);
    // Detalj se uvijek prikaže; ako je iz drugog okruženja, layout to kaže.
    const t = scope.byId(b.intent.tenant_id);
    const otherMode = t && t.sandbox !== (scope.mode === 'sandbox');
    const view = otherMode ? await loadScope(c.env, t.sandbox ? 'sandbox' : 'production') : scope;
    return page(c, view, `Uplata ${b.intent.sid}`, 'payments', <PaymentDetailPage scope={view} b={b} />);
  });

  app.get('/admin/v2/payouts', async (c) => {
    const scope = await scopeOf(c);
    const status = c.req.query('status') || undefined;
    const [r, parked] = await Promise.all([listPayouts(c.env, scope, { status }), listParkedForwards(c.env, scope, 50)]);
    return page(c, scope, 'Isplate', 'payouts', <PayoutsPage scope={scope} status={status} items={r.items} total={r.total} parked={parked} />);
  });

  // Riješi zapelu uplatu. Čita (D1 + na ?tx= EURe transfere iz Safea na lancu);
  // akcije na stranici zovu postojeće /admin/api/orders/:id/* POST rute.
  app.get('/admin/v2/payouts/order/:id', async (c) => {
    const scope = await scopeOf(c);
    const id = c.req.param('id');
    const b = await getResolveBundle(c.env, id, defaultTenantId(c.env));
    if (!b) return page(c, scope, 'Nije pronađeno', 'payouts', <div class="empty">Order „{id}” ne postoji. <a href="/admin/v2/payouts">Natrag</a></div>);
    const t = scope.byId(b.tenantId);
    const view = t && t.sandbox !== (scope.mode === 'sandbox') ? await loadScope(c.env, t.sandbox ? 'sandbox' : 'production') : scope;
    const tx = (c.req.query('tx') ?? '').trim();
    let legs: OffRailLeg[] | null | undefined;
    if (tx && b.parked) {
      const rail = await getTenantRail(c.env, b.tenantId);
      legs = rail ? await listOffRailLegs(makeOffRailDeps(c.env, rail), tx).catch(() => null) : null;
    }
    let orderWei = '0';
    try { orderWei = eurToWei(b.order.amount).toString(); } catch { /* neispravan iznos: nijedan leg nije „isti” */ }
    return page(c, view, `Riješi ${fmtEur(b.amountCents)}`, 'payouts',
      <ResolvePage scope={view} b={b} chain={b.order.chain ?? t?.chain ?? null} orderWei={orderWei} tx={tx || undefined} legs={legs} />);
  });

  app.get('/admin/v2/tenants', async (c) => {
    const scope = await scopeOf(c);
    const stats = await listTenantStats(c.env, scope);
    return page(c, scope, 'Tenanti', 'tenants', <TenantsPage scope={scope} stats={stats} />);
  });

  app.get('/admin/v2/tenants/:id', async (c) => {
    const id = c.req.param('id');
    let scope = await scopeOf(c);
    const t = scope.byId(id);
    if (t && t.sandbox !== (scope.mode === 'sandbox')) scope = await loadScope(c.env, t.sandbox ? 'sandbox' : 'production');
    const d = await getTenantDetail(c.env, id);
    if (!d.tenant && !d.rail) return page(c, scope, 'Nije pronađeno', 'tenants', <div class="empty">Tenant „{id}” ne postoji. <a href="/admin/v2/tenants">Natrag</a></div>);
    const [recent, stats, audit] = await Promise.all([
      listPayments(c.env, scope, { tenant: id, limit: 8 }),
      listTenantStats(c.env, scope),
      listAuditV2(c.env, scope, { tenant: id, limit: 10 }),
    ]);
    return page(c, scope, d.tenant?.name ?? id, 'tenants', <TenantDetailPage scope={scope} id={id} d={d} recent={recent.items} stats={stats.get(id)} audit={audit} />);
  });

  app.get('/admin/v2/developers', async (c) => {
    const scope = await scopeOf(c);
    const tab = (['events', 'inbox', 'outbox', 'audit'].includes(c.req.query('tab') ?? '') ? c.req.query('tab') : 'events') as DevTab;
    const query = {
      sig: c.req.query('sig') === '0' || c.req.query('sig') === '1' ? c.req.query('sig') : undefined,
      unmatched: c.req.query('unmatched') ? '1' : undefined,
      status: c.req.query('status') || undefined,
      system: c.req.query('system') ? '1' : undefined,
      tenant: c.req.query('tenant') || undefined,
    };
    const nav: NavKey = tab === 'events' ? 'webhooks' : tab;
    const props = {
      events: tab === 'events' ? await listWebhookEvents(c.env, scope, { sig: query.sig as '0' | '1' | undefined }) : undefined,
      inbox: tab === 'inbox' ? await listInbox(c.env, scope, { unmatched: Boolean(query.unmatched) }) : undefined,
      outbox: tab === 'outbox' ? await listOutbox(c.env, scope, { status: query.status }) : undefined,
      audit: tab === 'audit' ? await listAuditV2(c.env, scope, { system: Boolean(query.system), tenant: query.tenant }) : undefined,
    };
    return page(c, scope, 'Developeri', nav, <DevelopersPage scope={scope} tab={tab} query={query} {...props} />);
  });

  app.get('/admin/v2/developers/events/:id', async (c) => {
    const scope = await scopeOf(c);
    const id = Number(c.req.param('id'));
    const e = Number.isInteger(id) ? await getWebhookEvent(c.env, id) : null;
    if (!e) return page(c, scope, 'Nije pronađeno', 'webhooks', <div class="empty">Event ne postoji.</div>);
    return page(c, scope, `Event #${e.id}`, 'webhooks', <EventDetailPage scope={scope} e={e} />);
  });

  app.get('/admin/v2/search', async (c) => {
    const scope = await scopeOf(c);
    const q = (c.req.query('q') ?? '').trim().slice(0, 200);
    const hits = await search(c.env, q);
    // Jedan jednoznačan pogodak = ravno na njega (kao Stripe).
    if (hits.length === 1) return c.redirect(hits[0].href, 302);
    return page(c, scope, 'Pretraga', 'search', <SearchPage q={q} hits={hits} />, q);
  });
}
