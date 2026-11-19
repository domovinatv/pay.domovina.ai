import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { markSandboxDismissed } from '../src/monerium/offrail';
import { logicalForwardState, stateSql } from '../src/monerium/forwardStates';
import { mountAdminV2 } from '../src/admin/v2/routes';
import type { MoneriumOrder } from '../src/monerium/types';
import { migratedD1 } from './helpers/sqliteD1';

/// Sandbox: zatvori bez isplate (19. 11. 2026.). Četiri test ordera ITalk
/// sandboxa (#83, #84, #87, #89) imala su test EURe u prihvatnom Safeu, a
/// nijednu istinitu akciju: nitko ih nije ručno poslao, mint nije na odredištu.

const SAFE = '0xe2e21755d3f576f090ecda1d830f3fda865f37ff';
const NOW = Math.floor(Date.now() / 1000);

function setup() {
  const { db, raw } = migratedD1();
  const env = { DB: db, DEFAULT_TENANT_ID: 'italk' } as unknown as Env;
  raw.prepare(`INSERT OR REPLACE INTO tenants (id, name, status, beneficiary_name, iban, created_at, updated_at)
               VALUES ('italk', 'ITalk', 'active', 'ITalk', 'EE701234567890121128', 0, 0),
                      ('italk-sandbox', 'ITalk sandbox', 'active', 'ITalk', 'EE701234567890121128', 0, 0)`).run();
  raw.prepare(`INSERT INTO tenant_rail (tenant_id, monerium_env, chain, client_id, client_secret_enc, profile_id, receiving_safe, created_at, updated_at)
               VALUES ('italk', 'production', 'gnosis', 'c', 'enc', 'p', '0x449abcef4e29a7dd8d98db451af2c463561baf2e', 0, 0),
                      ('italk-sandbox', 'sandbox', 'chiado', 'c2', 'enc', 'p2', ?, 0, 0)`).run(SAFE);
  const park = (orderId: string, tenant: string, status: 'failed' | 'blocked', error: string) => {
    raw.prepare(`INSERT INTO monerium_orders (id, tenant_id, kind, state, amount, currency, memo, address, placed_at, processed_at, raw_json, updated_at)
                 VALUES (?, ?, 'issue', 'processed', '7.11', 'eur', 'One small payment', ?, '2026-10-11T21:04:40Z', '2026-10-11T21:04:47Z', '{}', 0)`).run(orderId, tenant, SAFE);
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, amount_cents, sid, status, error, attempts, created_at, updated_at, tenant_id)
                 VALUES (?, '', '7110000000000000000', 711, NULL, ?, ?, 1, ?, ?, ?)`).run(orderId, status, error, NOW - 3000000, NOW - 3000000, tenant);
  };
  park('ord-sbx', 'italk-sandbox', 'failed', 'no_routing_target');
  park('ord-sbx2', 'italk-sandbox', 'blocked', 'not_whitelisted:unroutable_prefix');
  park('ord-prod', 'italk', 'blocked', 'not_whitelisted');
  const order = (id: string) => ({ id, kind: 'issue', state: 'processed', amount: '7.11', address: SAFE }) as unknown as MoneriumOrder;
  const latest = (orderId: string) =>
    raw.prepare(`SELECT id, status, error, amount_wei, amount_cents FROM monerium_forwards WHERE order_id = ? ORDER BY id DESC LIMIT 1`).get(orderId) as
      { id: number; status: string; error: string | null; amount_wei: string; amount_cents: number };
  return { env, raw, order, latest };
}

describe('sandbox: zatvori bez isplate', () => {
  it('zatvara parkirani sandbox order: novi red dismissed, 0 wei, audit s razlogom', async () => {
    const { env, raw, order, latest } = setup();
    const r = await markSandboxDismissed(env, { order: order('ord-sbx'), tenantId: 'italk-sandbox', sandbox: true, actor: 'ops@x.hr', reason: 'test iz uvođenja whitelista' });
    expect(r.ok).toBe(true);
    const row = latest('ord-sbx');
    expect(row).toMatchObject({ status: 'resolved_offrail', error: 'sandbox_dismissed', amount_wei: '0', amount_cents: 711 });
    expect(logicalForwardState(row as never)).toBe('dismissed');
    const audit = raw.prepare(`SELECT actor, detail FROM tenant_audit_log WHERE action = 'forward.sandbox_dismissed'`).get() as { actor: string; detail: string };
    expect(audit.actor).toBe('ops@x.hr');
    expect(JSON.parse(audit.detail)).toMatchObject({ order_id: 'ord-sbx', reason: 'test iz uvođenja whitelista', previous: { status: 'failed', error: 'no_routing_target' } });
  });

  it('drugi put: already_resolved (i za blocked)', async () => {
    const { env, order } = setup();
    const args = { order: order('ord-sbx2'), tenantId: 'italk-sandbox', sandbox: true, actor: 'a', reason: 'test smeće, Chiado' };
    expect((await markSandboxDismissed(env, args)).ok).toBe(true);
    expect(await markSandboxDismissed(env, args)).toEqual({ ok: false, error: 'already_resolved' });
  });

  it('produkcija nikad: not_sandbox, ništa ne upisuje', async () => {
    const { env, order, latest } = setup();
    expect(await markSandboxDismissed(env, { order: order('ord-prod'), tenantId: 'italk', sandbox: false, actor: 'a', reason: 'dovoljno dug razlog' }))
      .toEqual({ ok: false, error: 'not_sandbox' });
    expect(latest('ord-prod').status).toBe('blocked');
  });

  it('razlog je obavezan (min. 10 znakova)', async () => {
    const { env, order, latest } = setup();
    expect(await markSandboxDismissed(env, { order: order('ord-sbx'), tenantId: 'italk-sandbox', sandbox: true, actor: 'a', reason: '  kratko ' }))
      .toEqual({ ok: false, error: 'reason_required' });
    expect(latest('ord-sbx').status).toBe('failed');
  });

  it('živi forward se ne dira', async () => {
    const { env, raw, order } = setup();
    raw.prepare(`UPDATE monerium_forwards SET status = 'submitted', error = NULL WHERE order_id = 'ord-sbx'`).run();
    expect(await markSandboxDismissed(env, { order: order('ord-sbx'), tenantId: 'italk-sandbox', sandbox: true, actor: 'a', reason: 'dovoljno dug razlog' }))
      .toEqual({ ok: false, error: 'already_forwarded' });
  });

  it('stateSql: dismissed i resolved_offrail se ne preklapaju', () => {
    const { raw } = setup();
    raw.prepare(`INSERT INTO monerium_forwards (order_id, target_address, amount_wei, status, error, attempts, created_at, updated_at)
                 VALUES ('x1', '', '0', 'resolved_offrail', 'sandbox_dismissed', 0, 0, 0), ('x2', '0xab', '1', 'resolved_offrail', NULL, 1, 0, 0)`).run();
    const ids = (s: 'dismissed' | 'resolved_offrail') => (raw.prepare(`SELECT order_id FROM monerium_forwards WHERE order_id IN ('x1','x2') AND ${stateSql(s)}`).all() as Array<{ order_id: string }>).map((r) => r.order_id);
    expect(ids('dismissed')).toEqual(['x1']);
    expect(ids('resolved_offrail')).toEqual(['x2']);
  });

  it('v2 Riješi: kartica samo na sandbox tenantu; nakon zatvaranja oznaka „Zatvoreno bez isplate”', async () => {
    const { env, order } = setup();
    const app = new Hono<{ Bindings: Env }>();
    mountAdminV2(app);
    const html = async (p: string) => (await app.request(p, {}, env)).text();
    const sbx = await html('/admin/v2/payouts/order/ord-sbx');
    expect(sbx).toContain('/admin/api/orders/ord-sbx/sandbox-dismiss');
    expect(sbx).toContain('data-reason="dismiss-reason"');
    expect(await html('/admin/v2/payouts/order/ord-prod')).not.toContain('sandbox-dismiss');
    await markSandboxDismissed(env, { order: order('ord-sbx'), tenantId: 'italk-sandbox', sandbox: true, actor: 'a', reason: 'test smeće, Chiado' });
    const after = await html('/admin/v2/payouts/order/ord-sbx');
    expect(after).toContain('Zatvoreno bez isplate');
    expect(after).not.toContain('/sandbox-dismiss');
  });
});
