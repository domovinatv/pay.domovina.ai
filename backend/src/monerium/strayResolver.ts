/// Stray payment resolver: a SEPA payment that reached the MPT Safe WITHOUT a
/// routing reference (empty or free-text memo) is matched to the intent it
/// most plausibly paid, using only facts the rail already holds — tenant
/// (whose IBAN received it), exact amount and time.
///
/// Why this exists: since 2026-10-07 Revolut iOS drops the EPC remittance line
/// when the balance covers the amount, and payers also delete or retype the
/// reference by hand. Before this, every such payment parked as
/// `no_routing_target` and waited for a manual transfer.
///
/// Safety argument — the resolver never INVENTS a destination:
///   - a candidate's target is `payment_intents.target_address`, which the
///     tenant authorised through the intent API;
///   - the synthesised routing still goes through `authorizeForward` (tenant
///     binding, whitelist, cap, mint address) like any memo-carried forward;
///   - when the candidates disagree on the destination, nothing moves.
/// What it may get wrong is ATTRIBUTION between intents that share a target
/// (which one flips to paid). Money still lands where any of them would have
/// sent it.
///
/// Pure decision logic lives here; the D1 query is `findStrayCandidates` in
/// ../intents/db.ts.

export interface StrayCandidate {
  sid: string;
  target_address: string;
  state: 'pending' | 'expired' | 'paid';
  created_at: number;
  expires_at: number;
}

export type StrayResolution =
  /// All candidates point at one destination. `sids` is the claim order —
  /// the forward takes the first one nobody else has claimed yet.
  | { kind: 'match'; target: string; sids: string[]; ambiguousIntent: boolean }
  | { kind: 'none' }
  /// Candidates disagree on where the money should go — park.
  | { kind: 'conflict'; candidates: StrayCandidate[] };

/// How far back an intent may have been created and still claim a stray.
/// Bank transfers trail the QR scan by minutes to days; the intent TTL (15 min
/// by default) is about the checkout UI, not about when the money arrives.
/// 2026-10-07: both 1,00 € strays arrived 7 and 23 min after expiry.
export const STRAY_LOOKBACK_SECONDS = 48 * 3600;

/// Clock skew allowance between Monerium's placedAt and our created_at.
export const STRAY_CLOCK_SKEW_SECONDS = 120;

/// Rank candidates and decide. Ranking: an intent still open when the money
/// was placed beats an expired one; then the most recently created one (the
/// payer's latest checkout is the likeliest one they acted on).
export function resolveStray(
  candidates: StrayCandidate[],
  placedAtUnix: number,
): StrayResolution {
  const live = candidates.filter((c) => c.state === 'pending' || c.state === 'expired');
  if (live.length === 0) return { kind: 'none' };

  const targets = new Set(live.map((c) => c.target_address.toLowerCase()));
  if (targets.size > 1) return { kind: 'conflict', candidates: live };

  const openAtPlacement = (c: StrayCandidate) => c.expires_at >= placedAtUnix;
  const ranked = [...live].sort((a, b) => {
    const oa = openAtPlacement(a) ? 1 : 0;
    const ob = openAtPlacement(b) ? 1 : 0;
    if (oa !== ob) return ob - oa;
    return b.created_at - a.created_at;
  });
  return {
    kind: 'match',
    target: ranked[0].target_address.toLowerCase(),
    sids: ranked.map((c) => c.sid),
    ambiguousIntent: ranked.length > 1,
  };
}

/// Monerium's placedAt (when the bank accepted the transfer), falling back to
/// now. Unparseable → now, which only ever narrows the window.
export function placedAtUnix(placedAt: string | undefined | null, nowUnix: number): number {
  if (!placedAt) return nowUnix;
  const ms = Date.parse(placedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : nowUnix;
}
