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

// ── Abuse caps: the REAL backstop against relayer-gas drain ────────────────────
//
// The per-signer cap is trivially bypassed — an attacker can mint unlimited
// secp256r1 keys offline (no real authenticator needed; the on-chain WebAuthn
// signer verifies only the P-256 signature) and rotate signers to reset it. These
// two caps bound the damage regardless of identity rotation:
//   - per source IP  (one network can only burn so much sponsored gas / day)
//   - global daily   (a hard ceiling on the relayer's total daily gas exposure)
// Both are shared across /api/relay AND /api/bootstrap-deploy (one gas budget).
// Turnstile (turnstile.ts) is the human-attestation layer on top.

export type AbuseLimits = { ipDaily: number; globalDaily: number };

/** Sane defaults if the env vars are unset/garbage. Tuned so a household behind one
 * NAT IP can run a handful of wallets, while a script is throttled hard. */
export const DEFAULT_ABUSE_LIMITS: AbuseLimits = { ipDaily: 25, globalDaily: 1000 };

function posIntOr(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Read the abuse caps from env (RELAY_IP_DAILY_LIMIT / RELAY_GLOBAL_DAILY_LIMIT),
 * falling back to DEFAULT_ABUSE_LIMITS. */
export function abuseLimitsFromEnv(env: {
  RELAY_IP_DAILY_LIMIT?: string;
  RELAY_GLOBAL_DAILY_LIMIT?: string;
}): AbuseLimits {
  return {
    ipDaily: posIntOr(env.RELAY_IP_DAILY_LIMIT, DEFAULT_ABUSE_LIMITS.ipDaily),
    globalDaily: posIntOr(env.RELAY_GLOBAL_DAILY_LIMIT, DEFAULT_ABUSE_LIMITS.globalDaily),
  };
}

export function ipDailyKey(ip: string, day = utcDay()): string {
  return `gas:ip:${ip}:${day}`;
}
export function globalDailyKey(day = utcDay()): string {
  return `gas:global:${day}`;
}

export type AbuseState = {
  /** Resolved client IP, or null when CF didn't supply one (per-IP check skipped). */
  ip: string | null;
  ipKey: string | null;
  ipUsed: number;
  globalKey: string;
  globalUsed: number;
  limits: AbuseLimits;
};

/** Snapshot the per-IP + global counters once, so the same numbers gate the request
 * and (on success) get bumped. */
export async function readAbuseState(
  kv: KVNamespace,
  ip: string | null,
  limits: AbuseLimits,
): Promise<AbuseState> {
  const globalKey = globalDailyKey();
  const ipKey = ip ? ipDailyKey(ip) : null;
  const [globalUsed, ipUsed] = await Promise.all([
    readCount(kv, globalKey),
    ipKey ? readCount(kv, ipKey) : Promise.resolve(0),
  ]);
  return { ip, ipKey, ipUsed, globalKey, globalUsed, limits };
}

/** Which cap (if any) is already at/over its limit. Global is checked first because
 * it protects the operator's wallet even when the IP is unknown. */
export function capExceeded(s: AbuseState): 'global' | 'ip' | null {
  if (s.globalUsed >= s.limits.globalDaily) return 'global';
  if (s.ipKey && s.ipUsed >= s.limits.ipDaily) return 'ip';
  return null;
}

/** Bump the global (and per-IP, when known) counters after a sponsored op lands. */
export async function bumpAbuse(kv: KVNamespace, s: AbuseState): Promise<void> {
  await Promise.all([
    bumpCount(kv, s.globalKey, s.globalUsed),
    s.ipKey ? bumpCount(kv, s.ipKey, s.ipUsed) : Promise.resolve(),
  ]);
}
