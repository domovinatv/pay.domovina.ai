/**
 * KV-backed daily counters shared by the gas-sponsoring Workers.
 *
 * The per-signer free-tier counter (`relay:<signer>:<day>`) lived inline in
 * relay.ts, bootstrap-deploy.ts and status.ts with three slightly different
 * copies of the same key format + TTL. Centralising it keeps the read path
 * (status endpoint) and the write path (relay/bootstrap) provably in lockstep.
 *
 * NOTE on atomicity: Workers KV has no atomic increment and is eventually
 * consistent, so a burst of concurrent requests can each read the same `used`
 * and all proceed — the per-signer cap is best-effort, not a hard gate. It is a
 * free-tier accounting control, NOT the abuse defense; the real backstops are the
 * per-IP + global budget caps (also here) and optional Turnstile (turnstile.ts).
 * A fully atomic per-counter gate would need a Durable Object — see
 * docs/security/relayer-threat-model.md for the rationale on why we layer cheap
 * KV caps + human-attestation instead.
 */

export const FREE_DAILY_LIMIT = 5;

// 36h so a counter set at 23:59 UTC still expires cleanly after the day it names
// has fully passed; the key is date-stamped so the next day uses a fresh key.
const DAY_TTL_SECONDS = 60 * 60 * 36;

/** UTC calendar day (YYYY-MM-DD) used to scope every daily counter. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Read a counter, coercing missing/garbage to 0. */
export async function readCount(kv: KVNamespace, key: string): Promise<number> {
  return Math.max(0, Number((await kv.get(key)) ?? 0));
}

/** Increment a counter by one with the standard day TTL. Read-then-write — see
 * the atomicity note above. */
export async function bumpCount(kv: KVNamespace, key: string, current: number): Promise<void> {
  await kv.put(key, String(current + 1), { expirationTtl: DAY_TTL_SECONDS });
}

/** Per-signer free-tier key. `prefix` is 'relay' or 'bootstrap'. */
export function signerDailyKey(prefix: string, signer: string, day = utcDay()): string {
  return `${prefix}:${signer.toLowerCase()}:${day}`;
}
