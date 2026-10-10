import { describe, expect, it } from 'vitest';

import { isKnownPayer } from '../src/monerium/db';
import { makeAuthorizeDeps } from '../src/tenants/whitelist';
import { legacyRail } from '../src/tenants/rail';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

const SAFE = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e';

describe('MT-03: ITalk checks the mint address behind LEGACY_REQUIRE_MINT_AT', () => {
  const base = { SAFE_ADDRESS: SAFE, DEFAULT_TENANT_ID: 'italk' } as unknown as Env;
  it('"1" → requireMintAt = the Safe', () => {
    const env = { ...base, LEGACY_REQUIRE_MINT_AT: '1' } as Env;
    expect(makeAuthorizeDeps(env, legacyRail(env)).requireMintAt?.toLowerCase()).toBe(SAFE.toLowerCase());
  });
  it('unset → old behaviour (no check)', () => {
    expect(makeAuthorizeDeps(base, legacyRail(base)).requireMintAt).toBeNull();
  });
});

describe('MT-08: isKnownPayer only looks at the same tenant', () => {
  it('a payer known to ITalk is new to another tenant (and NULL rows are ITalk)', async () => {
    const { db, raw } = migratedD1();
    raw.prepare(`INSERT INTO monerium_orders (id, kind, state, amount, currency, counterpart_iban, raw_json, updated_at, tenant_id)
                 VALUES ('o-old', 'issue', 'processed', '5', 'eur', 'HR12 1001 0051 8630 0016 0', '{}', 0, NULL)`).run();
    const env = { DB: db } as unknown as Env;
    expect(await isKnownPayer(env, 'HR1210010051863000160', 'o-new', 'italk', 'italk')).toBe(true);
    expect(await isKnownPayer(env, 'HR1210010051863000160', 'o-new', 'zupa-x', 'italk')).toBe(false);
  });
});
