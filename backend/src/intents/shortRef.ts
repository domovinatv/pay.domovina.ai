import type { Env } from '../types';
import { STRAY_LOOKBACK_SECONDS } from '../monerium/strayResolver';
import { TRUSTED_CANDIDATE_SQL } from './db';

/// Short intent reference (ADR 0028): a body of 3 digits plus one Damm check
/// digit ("0076"), unique among the LIVE intents of one tenant. When Revolut
/// drops the long `gnosis:<Safe> sid:<sid>` reference, the payer types this
/// code instead, read off the checkout screen or a screenshot.
///
/// The body grows (4 + 1, 5 + 1, …) only when every shorter code of the
/// tenant is held, the same idea as git's short hash.

/// Damm quasigroup (order 10, weakly totally anti-symmetric): catches every
/// single wrong digit and every swap of adjacent digits, 09↔90 included,
/// which Luhn misses.
const DAMM: readonly (readonly number[])[] = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

function dammInterim(digits: string): number {
  let interim = 0;
  for (const ch of digits) interim = DAMM[interim][ch.charCodeAt(0) - 48];
  return interim;
}

/// Check digit for a digit-only body.
export function dammCheckDigit(body: string): string {
  return String(dammInterim(body));
}

/// A full code (body + check digit) is valid when the Damm interim over all
/// of it is 0.
export function isValidShortRef(code: string): boolean {
  return SHORT_REF_RE.test(code) && dammInterim(code) === 0;
}

export function shortRefFromBody(body: string): string {
  return body + dammCheckDigit(body);
}

/// Body lengths the allocator walks through, shortest first.
export const SHORT_REF_MIN_BODY = 3;
export const SHORT_REF_MAX_BODY = 6;
const SHORT_REF_RE = new RegExp(`^\\d{${SHORT_REF_MIN_BODY + 1},${SHORT_REF_MAX_BODY + 1}}$`);

/// How long after `expires_at` a code stays held (ADR 0028 §Otvoreno 3).
/// Same 48 h the stray resolver looks back: a bank transfer may trail the
/// checkout by minutes to days (2026-10-07: 7 and 23 min after expiry), and a
/// code freed earlier could send a late payment to a stranger's intent. A paid
/// intent frees its code at once.
export const SHORT_REF_HOLD_SECONDS = STRAY_LOOKBACK_SECONDS;

/// The one short code a remittance carries, or null. Normalisation: drop
/// whitespace, punctuation and symbols ("007-6", "0 0 7 6", "Lukavec 0076"),
/// then exactly one run of digits must remain, of a code's length and with a
/// valid check digit. Anything else (two numbers, a wrong check digit, a date)
/// is not a code and the payment takes the ordinary stray path.
export function parseShortRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const norm = text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '');
  const runs = norm.match(/\d+/g) ?? [];
  if (runs.length !== 1) return null;
  return isValidShortRef(runs[0]) ? runs[0] : null;
}

/// Short code of an order's remittance: memo and referenceNumber must not
/// name two different codes.
export function shortRefFromOrder(order: { memo?: string | null; referenceNumber?: string | null }): string | null {
  const codes = new Set(
    [parseShortRef(order.memo), parseShortRef(order.referenceNumber)].filter((c): c is string => c !== null),
  );
  return codes.size === 1 ? [...codes][0] : null;
}

/// SQL: is the held row `r` still live at `?` (unix now)? A paid intent frees
/// its code before the hold ends.
const LIVE_HOLD_SQL = `(r.hold_until > ?
       AND NOT EXISTS (SELECT 1 FROM payment_intents p WHERE p.sid = r.sid AND p.state = 'paid'))`;

const ALLOCATE_ATTEMPTS = 5;

function randomBody(len: number): string {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => String(n % 10)).join('');
}

/// Pick a random code no live intent of the tenant holds and take it. D1
/// decides, not this function: the insert takes the (tenant, code) row only
/// when it is absent or dead, so a concurrent allocation of the same code gets
/// `changes = 0` and tries another.
export async function allocateShortRef(
  env: Env,
  args: { tenantId: string; sid: string; holdUntil: number; nowUnix: number },
): Promise<string | null> {
  for (let len = SHORT_REF_MIN_BODY; len <= SHORT_REF_MAX_BODY; len++) {
    for (let attempt = 0; attempt < ALLOCATE_ATTEMPTS; attempt++) {
      const body = await pickFreeBody(env, args.tenantId, len, args.nowUnix);
      if (body === null) break; // every body of this length is held
      const code = shortRefFromBody(body);
      const res = await env.DB.prepare(
        `INSERT INTO intent_short_refs AS r (tenant_id, short_ref, sid, hold_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, short_ref) DO UPDATE
            SET sid = excluded.sid, hold_until = excluded.hold_until
          WHERE NOT ${LIVE_HOLD_SQL}`,
      )
        .bind(args.tenantId, code, args.sid, args.holdUntil, args.nowUnix)
        .run();
      if ((res.meta?.changes ?? 0) > 0) {
        await env.DB.prepare(`UPDATE payment_intents SET short_ref = ? WHERE sid = ?`)
          .bind(code, args.sid)
          .run();
        return code;
      }
    }
  }
  return null;
}

/// A random body of `len` digits whose code no live intent holds. Short
/// lengths read the held set (≤ 10 000 rows) and choose among the free ones,
/// so the pool really fills before the body grows; longer ones are nearly
/// empty and a random draw is enough.
async function pickFreeBody(env: Env, tenantId: string, len: number, nowUnix: number): Promise<string | null> {
  if (len > 4) return randomBody(len);
  const res = await env.DB.prepare(
    `SELECT r.short_ref FROM intent_short_refs r
      WHERE r.tenant_id = ? AND length(r.short_ref) = ? AND ${LIVE_HOLD_SQL}`,
  )
    .bind(tenantId, len + 1, nowUnix)
    .all<{ short_ref: string }>();
  const held = new Set(res.results.map((r) => r.short_ref.slice(0, len)));
  const size = 10 ** len;
  if (held.size >= size) return null;
  // Random start, walk to the first free body: uniform enough, and finite.
  const start = Number.parseInt(randomBody(len), 10);
  for (let i = 0; i < size; i++) {
    const body = String((start + i) % size).padStart(len, '0');
    if (!held.has(body)) return body;
  }
  return null;
}

/// The live, unsettled intent of `tenantId` holding `code`, with the same
/// trust flag the stray resolver uses (SR-01). Null when nothing live holds
/// it, or its intent already has a live forward (another payment took it).
export async function findIntentByShortRef(
  env: Env,
  args: { tenantId: string; code: string; nowUnix: number; defaultTenantId: string },
): Promise<{ sid: string; target_address: string; trusted: boolean } | null> {
  const row = await env.DB.prepare(
    `SELECT i.sid, i.target_address, ${TRUSTED_CANDIDATE_SQL} AS trusted
       FROM intent_short_refs r
       JOIN payment_intents i ON i.sid = r.sid
      WHERE r.tenant_id = ? AND r.short_ref = ? AND ${LIVE_HOLD_SQL}
        AND i.state IN ('pending', 'expired') AND i.monerium_order_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM monerium_forwards f
           WHERE f.sid = i.sid
             AND f.status IN ('pending', 'submitted', 'confirmed'))`,
  )
    .bind(args.defaultTenantId, args.tenantId, args.code, args.nowUnix)
    .first<{ sid: string; target_address: string; trusted: number }>();
  return row ? { sid: row.sid, target_address: row.target_address, trusted: row.trusted === 1 } : null;
}
