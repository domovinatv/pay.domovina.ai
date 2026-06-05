import type { MoneriumOrder } from './types';

/// Hex regex for an EVM address (40 hex chars, case-insensitive). We don't
/// enforce EIP-55 checksum because banks may upper/lowercase memo en route.
const ADDR_RE = /0x[0-9a-fA-F]{40}/;

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
  if (!order) return { target: null, sid: null, campaignId: null, prefix: null };
  const fromMemo = extractRoutingTarget(order.memo ?? null);
  if (fromMemo.target) return fromMemo;
  const fromRef = extractRoutingTarget(order.referenceNumber ?? null);
  return fromRef.target ? fromRef : fromMemo;
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
  /// Lowercased 0x-prefixed EVM address parsed from the memo. Null if memo
  /// has no recognizable routing prefix or no valid address found.
  target: string | null;
  /// Session id extracted from `?sid=…` / `?sid.…` / `sid:…` token; null if absent.
  sid: string | null;
  /// Campaign id extracted from `?id=…` (the `cmp:` permanent-QR protocol); null
  /// for the per-intent `mpt:`/`gnosis:` flows.
  campaignId: string | null;
  /// Which prefix was matched, for audit ("mpt", "gnosis", "cmp", or null = bare).
  prefix: 'mpt' | 'gnosis' | 'cmp' | null;
}

/// Parses an MPT routing instruction out of the Monerium webhook memo. Memo
/// shape options accepted (all SEPA-safe character set after = → . mapping):
///
///   mpt:0x<addr>?sid=<id>     (preferred — branded, per-intent)
///   mpt:0x<addr>?sid.<id>     (post-SEPA-mapping form)
///   gnosis:0x<addr>?sid=<id>  (legacy; user-facing QR still emits this)
///   gnosis:0x<addr>           (bare wallet, no session marker)
///   cmp:0x<safe>?id=<campaign>(PERMANENT campaign QR — many payments, one QR;
///                              0x = campaign Safe forward target, id = campaign)
///   0x<addr>                  (last-resort fallback — accept bare address)
///
/// Returns `{target: null, ...}` when no usable address was found — webhook
/// handler then leaves EURe parked in the Safe and logs `no_routing_target`
/// so it can be reconciled manually via Safe UI.
export function extractRoutingTarget(
  memo: string | null | undefined,
): RoutingTarget {
  if (!memo) return { target: null, sid: null, campaignId: null, prefix: null };
  let prefix: 'mpt' | 'gnosis' | 'cmp' | null = null;
  if (/^mpt:/i.test(memo)) prefix = 'mpt';
  else if (/^gnosis:/i.test(memo)) prefix = 'gnosis';
  else if (/^cmp:/i.test(memo)) prefix = 'cmp';
  const addrMatch = memo.match(ADDR_RE);
  const target = addrMatch ? addrMatch[0].toLowerCase() : null;
  return {
    target,
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
