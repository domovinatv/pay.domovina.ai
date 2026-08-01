import type { MoneriumOrder } from './types';

/// Hex regex for an EVM address (40 hex chars, case-insensitive). We don't
/// enforce EIP-55 checksum because banks may upper/lowercase memo en route.
///
/// The trailing negative lookahead is load-bearing: without it a longer hex
/// run (e.g. a 64-hex tx hash pasted into the memo) matched its first 40
/// characters and produced a plausible-looking but WRONG address.
const ADDR_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/// Pull the browser session id out of fields that survive a SEPA round-trip.
///
/// The QR layer puts an `sid=<uuid>` marker into the SEPA Remittance
/// Information so we can match an incoming Monerium order to the browser
/// session that generated the QR. Two encoding shapes are accepted because
/// it's not yet known whether Monerium's `gnosis:` parser is `startsWith` or
/// strict equality:
///
///   1. Query-string suffix appended to the wallet URI (preferred):
///        `gnosis:0x6693a7D1...?sid=abc123&a=0`
///      Survives intact if Monerium does a `startsWith("gnosis:")` match.
///
///   2. Space-separated `sid:` token (fallback):
///        `gnosis:0x6693a7D1... sid:abc123`
///      Used if (1) gets rejected by Monerium parser.
///
/// We check `memo`, `referenceNumber`, and the raw JSON in that order — some
/// Monerium payloads put the SEPA remittance in `memo`, others in
/// `referenceNumber`, and a few wrap it in a `details` substructure that
/// only the raw JSON exposes.
///
/// Returns null when no sid is present (e.g. legacy / manual transfers).
export function extractSessionId(order: MoneriumOrder | null): string | null {
  if (!order) return null;
  const candidates: string[] = [];
  if (typeof order.memo === 'string') candidates.push(order.memo);
  if (typeof order.referenceNumber === 'string') candidates.push(order.referenceNumber);
  // Fallback: scan everything (catches counterpart.details.* and meta.*).
  candidates.push(JSON.stringify(order));
  for (const text of candidates) {
    const sid = parseSidFromText(text);
    if (sid) return sid;
  }
  return null;
}

/// Convenience wrapper: pull routing target out of `memo` then fall back to
/// `referenceNumber` if memo had no usable address. Used by the webhook
/// handler.
export function extractRoutingFromOrder(order: MoneriumOrder | null): RoutingTarget {
  if (!order) {
    return { target: null, diagnosticTarget: null, sid: null, campaignId: null, prefix: null };
  }
  const fromMemo = extractRoutingTarget(order.memo ?? null);
  if (fromMemo.target) return fromMemo;
  const fromRef = extractRoutingTarget(order.referenceNumber ?? null);
  if (fromRef.target) return fromRef;
  // Neither field is routable. Keep whichever one at least saw an address, so
  // the parked forward records what the payer actually typed.
  return fromMemo.diagnosticTarget ? fromMemo : fromRef.diagnosticTarget ? fromRef : fromMemo;
}

/// Sender (counterpart) of an inbound SEPA "issue" order, as exposed by
/// Monerium: `counterpart.identifier.iban` + `counterpart.details.name`.
/// Forwarded to the merchant so it can derive bank-verified / KYC-name-match
/// flags (see domovina-api record_sepa_contribution / mark_contribution_paid).
export interface SenderInfo {
  iban: string | null;
  name: string | null;
}

export function extractSenderFromOrder(order: MoneriumOrder | null): SenderInfo {
  const ident = order?.counterpart?.identifier;
  const iban = ident && ident.standard === 'iban' ? ident.iban : null;
  const name = order?.counterpart?.details?.name ?? null;
  return { iban: iban ?? null, name: name ?? null };
}

export interface RoutingTarget {
  /// Lowercased 0x-prefixed EVM address the rail is WILLING to route on.
  /// Only filled for the `mpt:` and `cmp:` prefixes — a bare `0x…` or a
  /// legacy `gnosis:` memo yields null here (see `diagnosticTarget`).
  ///
  /// A non-null value is NOT an authorisation: it still has to pass
  /// `authorizeForward` (binding + tenant whitelist) before value moves.
  target: string | null;
  /// Any address found in the memo, regardless of prefix — diagnostics only.
  /// Logged and stored so an operator can see what a rejected payer typed,
  /// but never fed to `forwardViaSafe`.
  diagnosticTarget: string | null;
  /// Session id extracted from `?sid=…` / `?sid.…` / `sid:…` token; null if absent.
  sid: string | null;
  /// Campaign id extracted from `?id=…` (the `cmp:` permanent-QR protocol); null
  /// for the per-intent `mpt:`/`gnosis:` flows.
  campaignId: string | null;
  /// Which prefix was matched, for audit ("mpt", "gnosis", "cmp", or null = bare).
  prefix: 'mpt' | 'gnosis' | 'cmp' | null;
}

/// Prefixes that may produce a routing target at all. `gnosis:` was the
/// original user-facing QR scheme and bare `0x…` was a last-resort fallback;
/// both are now diagnostics-only, because either one let any SEPA payer name
/// an arbitrary destination in free-text remittance (ADR 0016).
const ROUTABLE_PREFIXES = new Set(['mpt', 'cmp']);

/// Parses an MPT routing instruction out of the Monerium webhook memo. Memo
/// shape options accepted (all SEPA-safe character set after = → . mapping):
///
///   mpt:0x<addr>?sid=<id>     (routable — branded, per-intent)
///   mpt:0x<addr>?sid.<id>     (routable — post-SEPA-mapping form)
///   cmp:0x<safe>?id=<campaign>(routable — PERMANENT campaign QR: many
///                              payments, one QR; 0x = campaign Safe forward
///                              target, id = campaign)
///   gnosis:0x<addr>[?sid=<id>](DIAGNOSTIC ONLY since ADR 0016 — legacy scheme)
///   0x<addr>                  (DIAGNOSTIC ONLY since ADR 0016 — bare fallback)
///
/// `target` is filled only for the routable prefixes. Everything else lands in
/// `diagnosticTarget`, so the webhook handler leaves EURe parked in the Safe
/// (`unroutable_prefix`) while an operator can still see what was typed and
/// reconcile manually via the Safe UI.
export function extractRoutingTarget(
  memo: string | null | undefined,
): RoutingTarget {
  if (!memo) {
    return { target: null, diagnosticTarget: null, sid: null, campaignId: null, prefix: null };
  }
  let prefix: 'mpt' | 'gnosis' | 'cmp' | null = null;
  if (/^mpt:/i.test(memo)) prefix = 'mpt';
  else if (/^gnosis:/i.test(memo)) prefix = 'gnosis';
  else if (/^cmp:/i.test(memo)) prefix = 'cmp';
  const addrMatch = memo.match(ADDR_RE);
  const diagnosticTarget = addrMatch ? addrMatch[0].toLowerCase() : null;
  const routable = prefix !== null && ROUTABLE_PREFIXES.has(prefix);
  return {
    target: routable ? diagnosticTarget : null,
    diagnosticTarget,
    sid: parseSidFromText(memo),
    campaignId: parseCampaignIdFromText(memo),
    prefix,
  };
}

/// Exported for unit tests + admin UI "what would we extract from this?" probe.
export function parseSidFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  // Form 1: query-style separators. SEPA character set bans `=` and silently
  // maps it to `.` somewhere between Revolut and LHV (verified empirically
  // 2026-05-21 against payload memo `gnosis:0x…?sid.dz4hhkkqsp`). Accept
  // `=`, `.`, `:`, and `-` after the `sid` token so any survival form works.
  const qm = text.match(/[?&]sid[=.:\-]([A-Za-z0-9_\-]{6,64})/);
  if (qm) return qm[1];
  // Form 2: `sid:abc123` token, bounded by whitespace or string edges.
  const sm = text.match(/(?:^|\s)sid[:.\-]([A-Za-z0-9_\-]{6,64})(?=\s|$)/);
  if (sm) return sm[1];
  return null;
}

/// Pull the campaign id out of a `cmp:` permanent-QR memo. Same SEPA-survival
/// rules as `sid` (the `=` may arrive as `.`/`:`/`-`). The `[?&]` lookbehind on
/// the query form means `?sid=…` is never mistaken for `id=…` (the char before
/// `id` there is `s`, not `?`/`&`), and the token form requires a word boundary
/// so `sid:…` doesn't match either.
///
///   cmp:0x<safe>?id=<campaign>   (preferred)
///   cmp:0x<safe>?id.<campaign>   (post-SEPA-mapping form)
///   cmp:0x<safe> id:<campaign>   (space-separated fallback)
export function parseCampaignIdFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const qm = text.match(/[?&]id[=.:\-]([A-Za-z0-9_\-]{6,64})/);
  if (qm) return qm[1];
  const sm = text.match(/(?:^|\s)id[:.\-]([A-Za-z0-9_\-]{6,64})(?=\s|$)/);
  if (sm) return sm[1];
  return null;
}
