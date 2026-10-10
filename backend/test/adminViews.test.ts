import { describe, expect, it } from 'vitest';

import {
  renderEventDetailPage,
  renderEventsPage,
  renderForwardsPage,
  renderIntentsPage,
  renderOrderDetailPage,
  renderOrdersPage,
  renderPasskeysPage,
  renderSybilPage,
  renderTenantsPage,
  renderWalletsPage,
  renderWhitelistPage,
} from '../src/admin/views';

const tag = { tenant_id: 'zupa-x', tenant_name: 'Župa X', monerium_env: 'sandbox' };

const pages: Record<string, string> = {
  events: renderEventsPage(),
  eventDetail: renderEventDetailPage({
    id: 1, received_at: 0, event_type: 'order.updated', signature_ok: 1, order_id: null,
    sid_extracted: null, amount_cents: 100, currency: 'eur', processing_note: null,
    payload: '{}', headers_json: null,
  } as Parameters<typeof renderEventDetailPage>[0], tag),
  orders: renderOrdersPage(),
  orderDetail: renderOrderDetailPage({
    id: 'o1', kind: 'issue', state: 'processed', amount: '1.00', currency: 'eur', address: null,
    chain: 'gnosis', counterpart_iban: null, counterpart_name: null, memo: null,
    reference_number: null, placed_at: null, processed_at: null, raw_json: '{}',
  }, tag),
  forwards: renderForwardsPage(),
  intents: renderIntentsPage(),
  wallets: renderWalletsPage(),
  sybil: renderSybilPage(),
  whitelist: renderWhitelistPage(),
  tenants: renderTenantsPage(),
  passkeys: renderPasskeysPage({ email: 'a@b.c', passkeys: [] }),
};

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe('admin views', () => {
  for (const [name, html] of Object.entries(pages)) {
    it(`${name}: inline scripts parse`, () => {
      for (const js of inlineScripts(html)) {
        // Parse only (async body so top-level await would be legal too).
        expect(() => new Function(`return (async () => {\n${js}\n})`)).not.toThrow();
      }
    });
    it(`${name}: tenant strip on every tab`, () => {
      expect(html).toContain('id="tenantStrip"');
      expect(html).toContain('/admin/api/tenant-tags');
    });
  }

  it('list tabs with per-row tenant show Tenant + Monerium columns and a filter', () => {
    for (const name of ['events', 'orders', 'forwards', 'intents']) {
      expect(pages[name]).toContain('<th>Tenant</th>');
      expect(pages[name]).toContain('<th>Monerium</th>');
      expect(pages[name]).toContain('<select id="tenant">');
    }
  });

  it('detail pages show tenant and environment', () => {
    for (const name of ['eventDetail', 'orderDetail']) {
      expect(pages[name]).toContain('zupa-x');
      expect(pages[name]).toContain('env-sandbox');
    }
  });

  it('global tabs say they are not per tenant', () => {
    expect(pages.wallets).toContain('nije po tenantu');
    expect(pages.sybil).toContain('nije po tenantu');
  });
});
