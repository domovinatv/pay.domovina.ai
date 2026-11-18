import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { mountAdminV2 } from '../src/admin/v2/routes';
import { isSandboxTenant, modeFromCookie } from '../src/admin/v2/scope';
import { migratedD1 } from './helpers/sqliteD1';

/// Admin v2 nad pravom shemom (sve migracije): okruženja se ne miješaju,
/// izvedeni status uplate, vremenska crta, pretraga, CSV i preusmjeravanja.
/// Prijava je mountAdminAuth-ov posao (adminAuth.test.ts); ovdje je app bez nje.

const NOW = Math.floor(Date.now() / 1000);

function setup() {
  const { db, raw } = migratedD1();
  const env = { DB: db, DEFAULT_TENANT_ID: 'italk' } as unknown as Env;
  const tenant = (id: string, name: string, sandbox = 0) =>
    raw.prepare(
      `INSERT OR REPLACE INTO tenants (id, name, status, beneficiary_name, iban, created_at, updated_at, sandbox)
       VALUES (?, ?, 'active', ?, 'EE701234567890121128', 0, 0, ?)`,
    ).run(id, name, name, sandbox);
  tenant('italk', 'ITalk d.o.o.');
  tenant('crosulja-staging', 'Crošulja staging');
  tenant('sbx-abc', 'Swan probe', 1);
  raw.prepare(
    `INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id, receiving_safe, created_at, updated_at)
     VALUES ('italk', 'production', 'gnosis', 'c', 'enc', 'p', '0x449abcef4e29a7dd8d98db451af2c463561baf2e', 0, 0),
            ('crosulja-staging', 'sandbox', 'chiado', 'c2', 'enc', 'p2', '0x98f14ac6b2ca36abf6e5b25088e12f68c1dbb4e5', 0, 0)`,
  ).run();
  const intent = (sid: string, tenantId: string | null, state: string, cents: number, over: { paidAt?: number; expiresAt?: number; label?: string; target?: string } = {}) =>
    raw.prepare(
      `INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, paid_at, tenant_id, label, amount_received_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(sid, over.target ?? '0x7a1c00000000000000000000000000000000e9b2', cents, state, NOW - 3600, over.expiresAt ?? NOW + 600,
      over.paidAt ?? null, tenantId, over.label ?? null, state === 'paid' ? cents : null);
  intent('paidprod0001', 'italk', 'paid', 1000, { paidAt: NOW - 1800, label: 'Razvoj MPT-a' });
  intent('legacynull01', null, 'paid', 500, { paidAt: NOW - 1700 });
  intent('stuckprod001', 'italk', 'pending', 2500, { label: 'Lukavec 16 kW' });
  intent('waitprod0001', 'italk', 'pending', 700);
  intent('oldprod00001', 'italk', 'pending', 300, { expiresAt: NOW - 60 });
  intent('sbxpaid00001', 'sbx-abc', 'paid', 666, { paidAt: NOW - 100, label: 'Claude provider krug' });
  intent('stagingpaid1', 'crosulja-staging', 'paid', 9900, { paidAt: NOW - 100 });
  // Novac stigao, forward blokiran whitelistom → „Zapelo”.
  raw.prepare(`INSERT INTO monerium_orders (id, tenant_id, kind, state, amount, currency, counterpart_iban, counterpart_name, memo, placed_at, processed_at, raw_json, updated_at)
               VALUES ('ord-stuck', 'italk', 'issue', 'processed', '25.00', 'eur', 'HR1210010051863000160', 'Ana Anić', 'sid:stuckprod001', '2026-11-18T16:11:40Z', '2026-11-18T16:11:41Z', '{}', 0)`).run();
  raw.prepare(`INSERT INTO intent_settlements (sid, provider, settlement_ref, created_at) VALUES ('stuckprod001', 'monerium', 'ord-stuck', ?)`).run(NOW - 900);
  raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, status, error, attempts, created_at, updated_at, tenant_id)
               VALUES ('ord-stuck', '0x7a1c00000000000000000000000000000000e9b2', '25000000000000000000', 2500, 'stuckprod001', 'blocked', 'not_whitelisted', 1, ?, ?, 'italk')`).run(NOW - 890, NOW - 890);
  raw.prepare(`INSERT INTO monerium_webhook_events (order_id, event_type, signature_ok, payload, received_at, sid_extracted, amount_cents, tenant_id)
               VALUES ('ord-stuck', 'order.updated', 1, '{"order":{"id":"ord-stuck"}}', ?, 'stuckprod001', 2500, 'italk'),
                      (NULL, 'order.updated', 0, '{}', ?, NULL, NULL, NULL)`).run(NOW - 895, NOW - 300);
  raw.prepare(`INSERT INTO webhook_outbox (id, type, payload, tenant_id, status, attempts, next_attempt_at, last_status, created_at)
               VALUES ('int_paidprod0001', 'intent.paid', '{}', 'italk', 'failed', 5, 0, 502, ?)`).run(NOW - 1700);
  raw.prepare(`INSERT INTO tenant_audit_log (at, tenant_id, action, actor, detail) VALUES (?, 'italk', 'outflow.tick', 'system', '{}'), (?, 'italk', 'forward.reroute', 'ops@x.hr', '{}')`).run(NOW - 10, NOW - 20);
  const app = new Hono<{ Bindings: Env }>();
  mountAdminV2(app);
  const get = (path: string, mode?: 'sandbox' | 'production') =>
    app.request(path, { headers: mode ? { cookie: `mpt_v2_mode=${mode}` } : {} }, env);
  const html = async (path: string, mode?: 'sandbox' | 'production') => {
    const r = await get(path, mode);
    expect(r.status, path).toBe(200);
    return r.text();
  };
  return { raw, env, get, html };
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe('admin v2', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('scope: sbx-, sandbox=1 i Monerium sandbox rail su sandbox', () => {
    expect(isSandboxTenant({ id: 'sbx-1' })).toBe(true);
    expect(isSandboxTenant({ id: 'x', sandbox: 1 })).toBe(true);
    expect(isSandboxTenant({ id: 'crosulja-staging', monerium_env: 'sandbox' })).toBe(true);
    expect(isSandboxTenant({ id: 'italk', monerium_env: 'production' })).toBe(false);
    expect(modeFromCookie('a=1; mpt_v2_mode=sandbox')).toBe('sandbox');
    expect(modeFromCookie('mpt_v2_mode=evil')).toBe('production');
  });

  it('svaka stranica renderira, a inline skripte se parsiraju', async () => {
    for (const path of ['/admin/v2', '/admin/v2?days=30', '/admin/v2?days=1', '/admin/v2/payments', '/admin/v2/payments/stuckprod001',
      '/admin/v2/payments/paidprod0001', '/admin/v2/payments/waitprod0001', '/admin/v2/payouts', '/admin/v2/tenants',
      '/admin/v2/tenants/italk', '/admin/v2/tenants/sbx-abc', '/admin/v2/developers?tab=events', '/admin/v2/developers?tab=inbox',
      '/admin/v2/developers?tab=outbox', '/admin/v2/developers?tab=audit', '/admin/v2/developers/events/1', '/admin/v2/search?q=nema-toga']) {
      const h = await s.html(path);
      for (const js of inlineScripts(h)) expect(() => new Function(js)).not.toThrow();
    }
  });

  it('produkcija ne prikazuje sandbox uplate i obrnuto; NULL tenant = zadani (prod)', async () => {
    const prod = await s.html('/admin/v2/payments');
    expect(prod).toContain('paidprod0001');
    expect(prod).toContain('legacynull01');
    expect(prod).not.toContain('sbxpaid00001');
    expect(prod).not.toContain('stagingpaid1');
    const sbx = await s.html('/admin/v2/payments', 'sandbox');
    expect(sbx).toContain('sbxpaid00001');
    expect(sbx).toContain('stagingpaid1');
    expect(sbx).not.toContain('paidprod0001');
    expect(sbx).toContain('Sandbox podaci');
  });

  it('izvedeni status: blokiran forward = Zapelo, istekli pending = Istekao', async () => {
    const stuck = await s.html('/admin/v2/payments?status=stuck');
    expect(stuck).toContain('stuckprod001');
    expect(stuck).not.toContain('waitprod0001');
    const expired = await s.html('/admin/v2/payments?status=expired');
    expect(expired).toContain('oldprod00001');
    const pending = await s.html('/admin/v2/payments?status=pending');
    expect(pending).toContain('waitprod0001');
    expect(pending).not.toContain('stuckprod001');
  });

  it('pregled: promet samo iz okruženja i „Traži akciju” s blokiranim forwardom, lošim potpisom i palom isporukom', async () => {
    const h = await s.html('/admin/v2');
    expect(h).toContain('15,00 €'); // 10,00 italk + 5,00 legacy NULL; bez sbx 6,66 i stagingovih 99,00
    expect(h).toContain('Forward blokiran');
    expect(h).toContain('Neispravan potpis webhooka ×1');
    expect(h).toContain('Isporuka merchant webhooka pala ×1');
    const sbx = await s.html('/admin/v2', 'sandbox');
    expect(sbx).toContain('105,66 €');
    expect(sbx).not.toContain('Forward blokiran');
  });

  it('detalj uplate: vremenska crta od intenta do blokiranog forwarda', async () => {
    const h = await s.html('/admin/v2/payments/stuckprod001');
    for (const t of ['Intent kreiran', 'SEPA uplata primljena', 'Ana Anić', 'Webhook primljen', 'Forward blokiran', 'not_whitelisted', 'Novac je u MPT Safeu']) {
      expect(h).toContain(t);
    }
    const paid = await s.html('/admin/v2/payments/paidprod0001');
    expect(paid).toContain('Merchant obaviješten: intent.paid');
    expect(paid).toContain('/admin/api/outbox/int_paidprod0001/resend');
  });

  it('detalj iz drugog okruženja se prikaže u svom okruženju', async () => {
    const h = await s.html('/admin/v2/payments/sbxpaid00001');
    expect(h).toContain('Sandbox podaci');
    expect(h).toContain('Claude provider krug');
  });

  it('audit log skriva sistemske redove osim na zahtjev', async () => {
    const h = await s.html('/admin/v2/developers?tab=audit');
    expect(h).toContain('forward.reroute');
    expect(h).not.toContain('>outflow.tick<');
    const all = await s.html('/admin/v2/developers?tab=audit&system=1');
    expect(all).toContain('>outflow.tick<');
  });

  it('pretraga: točan SID, order id i IBAN vode ravno na uplatu', async () => {
    for (const q of ['stuckprod001', 'ord-stuck', 'HR12 1001 0051 8630 0016 0']) {
      const r = await s.get(`/admin/v2/search?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(302);
      expect(r.headers.get('location')).toBe('/admin/v2/payments/stuckprod001');
    }
    const many = await s.html('/admin/v2/search?q=prod0');
    expect(many).toContain('paidprod0001');
  });

  it('prekidač okruženja: kolačić + preusmjerenje samo unutar v2', async () => {
    const r = await s.get('/admin/v2/mode/sandbox?next=/admin/v2/payments?status=paid');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/admin/v2/payments?status=paid');
    expect(r.headers.get('set-cookie')).toContain('mpt_v2_mode=sandbox');
    for (const next of ['//evil.example', 'https://evil.example', '/admin/../x']) {
      const x = await s.get(`/admin/v2/mode/production?next=${encodeURIComponent(next)}`);
      expect(x.headers.get('location'), next).toBe('/admin/v2');
    }
    const d = await s.get('/admin/v2/mode/sandbox?next=/admin/v2/payments/paidprod0001');
    expect(d.headers.get('location')).toBe('/admin/v2/payments');
  });

  it('CSV: samo okruženje, neutralizirane formule', async () => {
    s.raw.prepare(`UPDATE payment_intents SET label = '=HYPERLINK("x")' WHERE sid = 'paidprod0001'`).run();
    const r = await s.get('/admin/v2/payments.csv');
    const csv = await r.text();
    expect(r.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).not.toContain('sbxpaid00001');
  });

  it('tenant: checklist raila i sandbox tenant bez raila', async () => {
    const h = await s.html('/admin/v2/tenants/italk');
    expect(h).toContain('Postavljanje raila');
    expect(h).toContain('Monerium webhook');
    expect(h).toContain('/admin/api/tenants/italk/rail/verify');
    const sbx = await s.html('/admin/v2/tenants/sbx-abc');
    expect(sbx).toContain('Sandbox tenant (ADR 0024)');
    expect(sbx).not.toContain('rail/verify');
    expect((await s.get('/admin/v2/tenants/nema')).status).toBe(200);
  });
  it('tenant: verify_report u obliku iz onboarding.ts ({ checks }) ne ruši stranicu', async () => {
    s.raw.prepare(`UPDATE tenant_rail SET verified_at = ?, verify_report = ? WHERE tenant_id = 'italk'`).run(
      NOW - 60,
      JSON.stringify({ checks: [{ key: 'monerium_profile', ok: true, detail: 'ok' }, { key: 'webhook', ok: false, detail: 'nema pretplate' }] }),
    );
    const h = await s.html('/admin/v2/tenants/italk');
    expect(h).toContain('1/2');
  });

  it('webhook na nepoznat tenant nije „neispravan potpis”, nego zasebna stavka', async () => {
    s.raw.prepare(`INSERT INTO monerium_webhook_events (order_id, event_type, signature_ok, payload, received_at, processing_note, tenant_id)
                   VALUES (NULL, 'unknown_tenant', 0, '{}', ?, 'unknown_tenant: swan-probe-20261117', NULL),
                          (NULL, 'unknown_tenant', 0, '{}', ?, 'unknown_tenant: swan-probe-20261117', NULL)`).run(NOW - 200, NOW - 100);
    const h = await s.html('/admin/v2');
    expect(h).toContain('Neispravan potpis webhooka ×1');
    expect(h).toContain('Webhook na nepoznat tenant ×2');
    expect(h).toContain('swan-probe-20261117');
    expect(await s.html('/admin/v2', 'sandbox')).not.toContain('nepoznat tenant');
    expect(await s.html('/admin/v2/developers?tab=events')).toContain('nepoznat tenant');
  });

  it('isplate: zapeli forward ima akciju (v1), a mint izravno nije „proslijeđeno”', async () => {
    const h = await s.html('/admin/v2/payouts?status=blocked');
    expect(h).toContain('/admin/forwards?status=blocked');
    expect(h).not.toContain('minted-at-destination'); // samo za mint_address_mismatch
    s.raw.prepare(`UPDATE monerium_forwards SET error = 'not_whitelisted:mint_address_mismatch' WHERE order_id = 'ord-stuck'`).run();
    expect(await s.html('/admin/v2/payouts?status=blocked')).toContain('/admin/api/orders/ord-stuck/minted-at-destination');
    s.raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, status, error, attempts, created_at, updated_at, tenant_id)
                   VALUES ('ord-direct', '0x7a1c00000000000000000000000000000000e9b2', '0', 1000, 'paidprod0001', 'confirmed', 'direct_mint', 0, ?, ?, 'italk')`).run(NOW - 1800, NOW - 1800);
    const d = await s.html('/admin/v2/payments/paidprod0001');
    expect(d).toContain('Mint izravno na odredište');
    expect(d).not.toContain('Proslijeđeno na odredište');
  });

  it('broj tenanata se sklanja', async () => {
    const { tenantCount } = await import('../src/admin/v2/ui');
    expect([1, 2, 5, 11, 12, 21, 22, 25].map(tenantCount)).toEqual(
      ['1 tenant', '2 tenanta', '5 tenanata', '11 tenanata', '12 tenanata', '21 tenant', '22 tenanta', '25 tenanata']);
  });
  it('riješi zapelu uplatu: kandidati za preusmjeravanje, razlog za drugi iznos, povijest forwarda', async () => {
    // Otvoren intent istog tenanta oko vremena uplate, drugog iznosa → treba razlog.
    s.raw.prepare(`INSERT INTO payment_intents (sid, target_address, amount_cents, state, created_at, expires_at, tenant_id)
                   VALUES ('kandidat0001', '0x7a1c00000000000000000000000000000000e9b2', 2400, 'pending', ?, ?, 'italk')`)
      .run(Math.floor(Date.parse('2026-11-18T16:00:00Z') / 1000), NOW + 600);
    const h = await s.html('/admin/v2/payouts/order/ord-stuck');
    expect(h).toContain('Novac je u MPT Safeu, ali nije proslijeđen');
    expect(h).toContain('/admin/api/orders/ord-stuck/reroute');
    expect(h).toContain('kandidat0001');
    expect(h).toMatch(/data-reason="rr-kandidat0001"/);
    expect(h).toContain('Riješeno ručno (izvan raila)');
    expect(h).toContain('Ana Anić');
    expect(h).not.toContain('minted-at-destination');
    for (const js of inlineScripts(h)) expect(() => new Function(js)).not.toThrow();
  });

  it('riješi: mint izvan Safea nudi samo zatvaranje, ne preusmjeravanje', async () => {
    s.raw.prepare(`UPDATE monerium_forwards SET error = 'not_whitelisted:mint_address_mismatch' WHERE order_id = 'ord-stuck'`).run();
    const h = await s.html('/admin/v2/payouts/order/ord-stuck');
    expect(h).toContain('Novac nije u MPT Safeu');
    expect(h).toContain('/admin/api/orders/ord-stuck/minted-at-destination');
    expect(h).not.toContain('/admin/api/orders/ord-stuck/reroute');
    expect(h).not.toContain('Riješeno ručno (izvan raila)');
  });

  it('riješi: order koji nije zapeo nema akcija; nepostojeći order', async () => {
    s.raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, status, attempts, created_at, updated_at, tenant_id)
                   VALUES ('ord-stuck', '0x7a1c00000000000000000000000000000000e9b2', '25000000000000000000', 2500, 'stuckprod001', 'confirmed', 1, ?, ?, 'italk')`).run(NOW - 10, NOW - 10);
    const h = await s.html('/admin/v2/payouts/order/ord-stuck');
    expect(h).toContain('Nije zapelo.');
    expect(h).not.toMatch(/data-post="\/admin\/api\/(orders|forwards)/);
    expect(await s.html('/admin/v2/payouts/order/nema')).toContain('ne postoji');
  });

  it('isplate i detalj uplate vode na v2 „Riješi”', async () => {
    expect(await s.html('/admin/v2/payouts?status=blocked')).toContain('/admin/v2/payouts/order/ord-stuck');
    expect(await s.html('/admin/v2/payments/stuckprod001')).toContain('/admin/v2/payouts/order/ord-stuck');
    expect(await s.html('/admin/v2')).toContain('/admin/v2/payouts/order/ord-stuck');
  });

  it('novi intent: forma u v2 umjesto v1 modala, po okruženju, s odobrenim primateljima', async () => {
    s.raw.prepare(`INSERT INTO tenant_campaigns (tenant_id, campaign_id, safe_address, label, created_at) VALUES ('italk', 'razvoj', '0x1111111111111111111111111111111111111111', 'Razvoj MPT-a', 0)`).run();
    s.raw.prepare(`INSERT INTO tenant_payout_addresses (tenant_id, address, label, source, created_at) VALUES ('italk', '0x2222222222222222222222222222222222222222', 'Ops', 'admin', 0),
                   ('italk', '0x3333333333333333333333333333333333333333', 'Opozvana', 'admin', 0)`).run();
    s.raw.prepare(`UPDATE tenant_payout_addresses SET revoked_at = 1 WHERE address = '0x3333333333333333333333333333333333333333'`).run();
    const home = await s.html('/admin/v2');
    expect(home).toContain('href="/admin/v2/payments/new"');
    const h = await s.html('/admin/v2/payments/new');
    expect(h).toContain('Novi intent');
    expect(h).toContain('name="tenant_id" value="italk"');
    expect(h).toContain('0x1111111111111111111111111111111111111111');
    expect(h).toContain('0x2222222222222222222222222222222222222222');
    expect(h).not.toContain('0x3333333333333333333333333333333333333333');
    expect(h).not.toContain('sbx-abc');
    expect(h).toContain("'/admin/api/intents'");
    for (const js of inlineScripts(h)) expect(() => new Function(js)).not.toThrow();
    const sbx = await s.html('/admin/v2/payments/new', 'sandbox');
    expect(sbx).toContain('name="tenant_id" value="crosulja-staging"');
    expect(sbx).toContain('<option value="sbx-abc"');
    expect(await s.html('/admin/v2/payments/new?tenant=sbx-abc', 'sandbox')).toContain('name="tenant_id" value="sbx-abc"');
    // Tenant iz drugog okruženja se ne može odabrati preko ?tenant=.
    expect(await s.html('/admin/v2/payments/new?tenant=sbx-abc')).toContain('name="tenant_id" value="italk"');
  });

  it('novi intent: tenant sa Swan računom nudi Swan kao zadani, bez obaveznog odredišta', async () => {
    s.raw.prepare(`INSERT INTO receiving_accounts (tenant_id, provider, mode, iban, environment, external_account_id, client_id, client_secret_enc, label, active, created_at)
                   VALUES ('italk', 'swan', 'fiat_notify', 'FR7612345000019876543210987', 'live', 'acc1', 'cid', 'enc', 'Swan', 1, 0)`).run();
    const h = await s.html('/admin/v2/payments/new');
    expect(h).toMatch(/<option value="swan" data-fiat="1" selected="">/);
    expect(h).toContain('data-target-wrap="true" hidden=""');
  });

  it('riješi: naslov kaže „Zapela uplata” samo kad je zapelo', async () => {
    expect(await s.html('/admin/v2/payouts/order/ord-stuck')).toContain('Zapela uplata ·');
    s.raw.prepare(`UPDATE monerium_forwards SET status = 'confirmed' WHERE order_id = 'ord-stuck'`).run();
    const h = await s.html('/admin/v2/payouts/order/ord-stuck');
    expect(h).not.toContain('Zapela uplata ·');
    expect(h).toContain('Isplata ·');
  });
});
