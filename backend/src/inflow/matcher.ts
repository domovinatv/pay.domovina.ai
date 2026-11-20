import type { Env } from '../types';
import type { CreditEvent } from './creditEvent';
import { parseSidFromText } from '../monerium/sid';
import { parseShortRef, findIntentByShortRef } from '../intents/shortRef';
import { findStrayCandidates, getIntent, isSettled, type PaymentIntentRow } from '../intents/db';
import {
  resolveStray,
  STRAY_CLOCK_SKEW_SECONDS,
  STRAY_LOOKBACK_SECONDS,
  type StrayCandidate,
} from '../monerium/strayResolver';
import { defaultTenantId } from '../tenants/whitelist';

/// ADR 0032 §5: one matcher for every provider. Order: sid in the
/// remittance → short_ref (ADR 0028) → tenant + amount + time (ADR 0018) →
/// none (caller parks + alerts). Never a unique amount per intent (decision
/// 2026-10-19). A hit is only ever an intent of the event's own tenant.

export type MatchResult =
  | { kind: 'match'; sid: string; by: 'sid' | 'short_ref' | 'stray'; note: string | null }
  | { kind: 'none'; note: string };

export interface MatcherDeps {
  defaultTenantId: string;
  nowUnix(): number;
  getIntent(sid: string): Promise<PaymentIntentRow | null>;
  findByShortRef(code: string, nowUnix: number): Promise<{ sid: string; trusted: boolean } | null>;
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

  const code = parseShortRef(ev.remittance);
  if (code) {
    const hit = await deps.findByShortRef(code, deps.nowUnix());
    if (hit?.trusted) return { kind: 'match', sid: hit.sid, by: 'short_ref', note: `short_ref ${code}` };
  }

  const candidates = await deps.findStrayCandidates({
    amountCents: ev.amountCents,
    createdFrom: ev.occurredAt - STRAY_LOOKBACK_SECONDS,
    createdTo: ev.occurredAt + STRAY_CLOCK_SKEW_SECONDS,
  });
  const res = resolveStray(candidates, ev.occurredAt);
  if (res.kind === 'match') {
    return {
      kind: 'match',
      sid: res.sids[0],
      by: 'stray',
      note: res.ambiguousIntent ? `stray_ambiguous: ${res.sids.join(',')}` : null,
    };
  }
  if (res.kind === 'conflict') return { kind: 'none', note: `stray_conflict: ${res.candidates.map((c) => c.sid).join(',')}` };
  return { kind: 'none', note: res.untrusted ? `stray_none (untrusted ${res.untrusted})` : 'stray_none' };
}
