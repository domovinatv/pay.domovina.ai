import { describe, expect, it } from 'vitest';

import { isKnownPayer } from '../src/monerium/db';
import type { Env } from '../src/types';
import { migratedD1 } from './helpers/sqliteD1';

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
