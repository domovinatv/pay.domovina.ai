import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/// Minimal D1 stand-in over node:sqlite with every migration applied — for
/// tests whose point is the SQL itself (a mocked .first() would prove nothing).
export function migratedD1(): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  const dir = join(__dirname, '..', '..', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(dir, f), 'utf8'));
  }
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async <T>() => (raw.prepare(sql).get(...(args as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: raw.prepare(sql).all(...(args as never[])) as T[] }),
    run: async () => {
      const r = raw.prepare(sql).run(...(args as never[]));
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  const db = { prepare: (sql: string) => stmt(sql), batch: async () => [] } as unknown as D1Database;
  return { db, raw };
}
