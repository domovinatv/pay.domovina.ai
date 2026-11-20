import type { Env } from '../types';
import type { CreditEvent } from './creditEvent';
import type { MoneriumOrder } from '../monerium/types';
import { extractRoutingFromOrder, parseSidFromText, type RoutingTarget } from '../monerium/sid';
import { parseShortRef, findIntentByShortRef, shortRefFromOrder } from '../intents/shortRef';
import { findStrayCandidates, getIntent, isSettled, type PaymentIntentRow } from '../intents/db';
import {
  placedAtUnix,
  resolveStray,
  STRAY_CLOCK_SKEW_SECONDS,
  STRAY_LOOKBACK_SECONDS,
  type StrayCandidate,
} from '../monerium/strayResolver';
import { parseAmountCents } from '../monerium/orderState';
import { defaultTenantId } from '../tenants/whitelist';

/// ADR 0032 §5: one matcher for every provider. Order: sid in the
/// remittance → short_ref (ADR 0028) → tenant + amount + time (ADR 0018) →
/// none (caller parks + alerts). Never a unique amount per intent (decision
/// 2026-10-19). A hit is only ever an intent of the event's own tenant.
///
/// The matcher DECIDES which intent a payment belongs to; it never moves
/// value or settles. Two entry points share one reference-less core:
///   - `matchCreditEvent` (fiat providers: Swan, …) → settleFiat;
///   - `matchMoneriumOrder` (onchain mint) → monerium/forward.ts, which only
///     executes the decision through the authorisation gate and the latches.

export type MatchResult =
  | { kind: 'match'; sid: string; by: 'sid' | 'short_ref' | 'stray'; note: string | null }
  | { kind: 'none'; note: string };

/// Short code lookup result: at least the intent and its SR-01 trust flag.
export interface ShortRefHit {
  sid: string;
  trusted: boolean;
}

/// What the reference-less core needs. `findStrayCandidates` absent = the
/// stray resolver is off for this caller (Monerium: `STRAY_RESOLVER` unset).
export interface ReferencelessDeps<H extends ShortRefHit> {
  nowUnix?(): number;
  findByShortRef?(code: string, nowUnix: number): Promise<H | null>;
  findStrayCandidates?(args: { amountCents: number; createdFrom: number; createdTo: number }): Promise<StrayCandidate[]>;
}

export type ReferencelessMatch<H extends ShortRefHit> =
  /// The payer typed a valid short code of a live, trusted intent.
  | { kind: 'short_ref'; code: string; hit: H }
  /// Stray resolver: all candidates agree on `target`; `sids` is the claim order.
  | { kind: 'stray'; target: string; sids: string[]; ambiguousIntent: boolean }
  /// Candidates disagree on the destination — nothing may move.
  | { kind: 'conflict'; candidates: StrayCandidate[] }
  /// No match. `resolverRan` false = the stray step was skipped (off, or no
  /// amount); `untrusted` = candidates left out by SR-01.
  | { kind: 'none'; resolverRan: boolean; untrusted?: number };

/// Short code (ADR 0028), then stray (ADR 0018). Only for a payment whose
/// remittance names neither an intent nor a destination.
export async function matchReferenceless<H extends ShortRefHit>(
  deps: ReferencelessDeps<H>,
  input: { shortRef: string | null; amountCents: number | null; placedAt: (nowUnix: number) => number },
): Promise<ReferencelessMatch<H>> {
  const now = () => deps.nowUnix?.() ?? Math.floor(Date.now() / 1000);
  if (deps.findByShortRef && input.shortRef) {
    const hit = await deps.findByShortRef(input.shortRef, now());
    // SR-01: anyone may open a keyless intent to a self-registered wallet,
    // and a payer's typo with a valid check digit must not land on it. A
    // miss falls through to the stray resolver.
    if (hit?.trusted) return { kind: 'short_ref', code: input.shortRef, hit };
    if (hit) console.warn(`short_ref ${input.shortRef} → intent ${hit.sid} is not a trusted candidate, ignored`);
  }
  if (!deps.findStrayCandidates || input.amountCents === null) return { kind: 'none', resolverRan: false };
  const placed = input.placedAt(now());
  const candidates = await deps.findStrayCandidates({
    amountCents: input.amountCents,
    createdFrom: placed - STRAY_LOOKBACK_SECONDS,
    createdTo: placed + STRAY_CLOCK_SKEW_SECONDS,
  });
  const res = resolveStray(candidates, placed);
  if (res.kind === 'match') return { kind: 'stray', target: res.target, sids: res.sids, ambiguousIntent: res.ambiguousIntent };
  if (res.kind === 'conflict') return { kind: 'conflict', candidates: res.candidates };
  return res.untrusted ? { kind: 'none', resolverRan: true, untrusted: res.untrusted } : { kind: 'none', resolverRan: true };
}

// ---------------------------------------------------------------------------
// Fiat providers (credit_events → settleFiat)

export interface MatcherDeps {
  defaultTenantId: string;
  nowUnix(): number;
  getIntent(sid: string): Promise<PaymentIntentRow | null>;
  findByShortRef(code: string, nowUnix: number): Promise<ShortRefHit | null>;
  findStrayCandidates(args: { amountCents: number; createdFrom: number; createdTo: number }): Promise<StrayCandidate[]>;
}

export function makeMatcherDeps(env: Env, tenantId: string): MatcherDeps {
  const dflt = defaultTenantId(env);
  return {
    defaultTenantId: dflt,
    nowUnix: () => Math.floor(Date.now() / 1000),
    getIntent: (sid) => getIntent(env, sid),
    findByShortRef: (code, nowUnix) => findIntentByShortRef(env, { tenantId, code, nowUnix, defaultTenantId: dflt }),
    findStrayCandidates: (args) => findStrayCandidates(env, { tenantId, defaultTenantId: dflt, ...args }),
  };
}

function settleable(intent: PaymentIntentRow): boolean {
  return (intent.state === 'pending' || intent.state === 'expired') && !isSettled(intent);
}

export async function matchCreditEvent(deps: MatcherDeps, ev: CreditEvent): Promise<MatchResult> {
  const sid = parseSidFromText(ev.remittance);
  if (sid) {
    const intent = await deps.getIntent(sid);
    if (!intent) return { kind: 'none', note: `sid_unknown: ${sid}` };
    if ((intent.tenant_id ?? deps.defaultTenantId) !== ev.tenantId) {
      // Someone else's sid on this tenant's account: never settle across tenants.
      return { kind: 'none', note: `sid_other_tenant: ${sid}` };
    }
    if (!settleable(intent)) return { kind: 'none', note: `sid_already_settled: ${sid} (${intent.state})` };
    return { kind: 'match', sid, by: 'sid', note: null };
  }

  const res = await matchReferenceless(deps, {
    shortRef: parseShortRef(ev.remittance),
    amountCents: ev.amountCents,
    placedAt: () => ev.occurredAt,
  });
  switch (res.kind) {
    case 'short_ref':
      return { kind: 'match', sid: res.hit.sid, by: 'short_ref', note: `short_ref ${res.code}` };
    case 'stray':
      return {
        kind: 'match',
        sid: res.sids[0],
        by: 'stray',
        note: res.ambiguousIntent ? `stray_ambiguous: ${res.sids.join(',')}` : null,
      };
    case 'conflict':
      return { kind: 'none', note: `stray_conflict: ${res.candidates.map((c) => c.sid).join(',')}` };
    case 'none':
      return { kind: 'none', note: res.untrusted ? `stray_none (untrusted ${res.untrusted})` : 'stray_none' };
  }
}

// ---------------------------------------------------------------------------
// Monerium (issue order → onchain mint → forward.ts)

/// Monerium short code lookups also carry the intent's target: the forward
/// needs the destination it routes to.
export interface MoneriumShortRefHit extends ShortRefHit {
  target_address: string;
}

export type MoneriumMatch =
  /// The remittance carries a routing instruction (sid, address, campaign):
  /// the payer named it, so nothing is guessed. The authorisation gate
  /// (`authorizeForward`) decides whether it may be honoured.
  | { kind: 'memo' }
  | ReferencelessMatch<MoneriumShortRefHit>;

/// No address, no sid, no campaign — nothing in the remittance to route on.
/// (A bare 0x / gnosis: memo is NOT reference-less: the payer named a
/// destination we refuse, and guessing a different one would be worse than
/// parking.)
export function isReferenceless(r: RoutingTarget): boolean {
  return !r.target && !r.diagnosticTarget && !r.sid && !r.campaignId;
}

/// Which intent a Monerium `issue` order pays. Same core as fiat; the
/// Monerium specifics are where the remittance lives (memo, then
/// referenceNumber) and that the stray window is anchored on `placedAt`
/// (when the bank accepted the transfer), on `order.created` and on
/// `processed` alike.
export async function matchMoneriumOrder(
  deps: ReferencelessDeps<MoneriumShortRefHit>,
  order: MoneriumOrder,
): Promise<{ routing: RoutingTarget; match: MoneriumMatch }> {
  const routing = extractRoutingFromOrder(order);
  if (!isReferenceless(routing)) return { routing, match: { kind: 'memo' } };
  const match = await matchReferenceless(deps, {
    shortRef: shortRefFromOrder(order),
    amountCents: parseAmountCents(order.amount),
    placedAt: (now) => placedAtUnix(order.meta?.placedAt, now),
  });
  return { routing, match };
}

/// `credit_events.matched_by` for an executed Monerium decision.
export function moneriumMatchedBy(via: 'code' | 'auto' | 'manual' | null): string {
  return via === 'code' ? 'short_ref' : via === 'auto' ? 'stray' : via === 'manual' ? 'manual' : 'sid';
}
