/// HUB3 (HRVHUB30) PDF417 payload builder for Croatian payment slips.
///
/// Spec: HUB „HUB 3A obrazac — specifikacija PDF417 barkoda", verzija 6
/// (rujan 2022). Checked against four real bills (HEP, Telemach, VG Čistoća,
/// an e-račun) in docs/research/aircash/05-hub3-format-provjera.md.
///
/// Why it exists: Croatian apps that scan only uplatnice (Aircash
/// „Slikaj i plati", bank apps) cannot read the EPC QR. The intent API offers
/// this text next to `epc_qr_data`; the client only renders it.
///
/// Routing caveat: the description field holds 35 characters, so the
/// `mpt:0x…?sid=…` memo (~60 chars) cannot travel in it — and for a
/// cross-border payment (HR bank → EE Monerium IBAN) Croatian banks drop the
/// description anyway, keeping only the reference. The description therefore
/// carries NO `sid` token: a payment without one is a stray, matched to its
/// intent by tenant + exact amount + time (ADR 0018). A `sid` without an
/// address would instead park as unroutable.

/// Maximum field lengths in characters (spec Tablica 1). Field 1–3 are fixed.
export const HUB3_MAX = {
  payerName: 30,
  payerStreet: 27,
  payerCity: 27,
  name: 25,
  street: 25,
  city: 27,
  iban: 21,
  model: 4,
  reference: 22,
  purpose: 4,
  description: 35,
} as const;

/// Above this the 15-digit amount field would overflow.
const MAX_CENTS = 999_999_999_999_999;

export interface Hub3Args {
  beneficiaryName: string;
  iban: string;
  amountEur: number;
  beneficiaryStreet?: string;
  beneficiaryCity?: string;
  /// `HRxx`. Default HR99 = no reference.
  model?: string;
  reference?: string;
  /// 4-char ISO 20022 purpose code, e.g. OTHR. Optional in HUB3.
  purposeCode?: string;
  description?: string;
}

const DIACRITICS: Record<string, string> = {
  Č: 'C', č: 'c', Ć: 'C', ć: 'c', Đ: 'D', đ: 'd', Š: 'S', š: 's', Ž: 'Z', ž: 'z',
};

/// Reduce text to the spec's character set without Croatian diacritics.
///
/// The spec allows č/ć/đ/š/ž as UTF-8, but the symbol carries no ECI marker,
/// so decoders guess the code page: Apple Vision returns „Južna" as „JuÅ¾na".
/// All four real bills we checked write ASCII only (STEPANIC, CISTOCA) — so do we.
/// Anything outside digits, letters, space and , . : - + ? ' / ( ) becomes a
/// space, runs of spaces collapse, and the result is cut to `max` characters.
export function hub3Text(value: string | undefined, max: number): string {
  if (!value) return '';
  const ascii = value
    .replace(/[ČčĆćĐđŠšŽž]/g, (ch) => DIACRITICS[ch] ?? ch)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
  const clean = ascii
    .replace(/[^0-9A-Za-z ,.:\-+?'/()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, max).trimEnd();
}

/// Returns null when the account cannot be expressed in HUB3 (IBAN longer than
/// the 21-character field, e.g. DE) or the amount does not fit — callers then
/// simply offer no HUB3 code.
export function buildHub3Text(a: Hub3Args): string | null {
  const iban = a.iban.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban) || iban.length > HUB3_MAX.iban) return null;
  const cents = Math.round(a.amountEur * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_CENTS) return null;

  const model = /^HR[0-9]{2}$/.test(a.model ?? '') ? a.model! : 'HR99';
  const reference = model === 'HR99' ? '' : hub3Text(a.reference, HUB3_MAX.reference);
  const purpose = /^[A-Z]{4}$/.test(a.purposeCode ?? '') ? a.purposeCode! : '';

  const fields = [
    'HRVHUB30',
    'EUR',
    String(cents).padStart(15, '0'),
    '', // payer name — the payer's app fills it in
    '', // payer street
    '', // payer city
    hub3Text(a.beneficiaryName, HUB3_MAX.name),
    hub3Text(a.beneficiaryStreet, HUB3_MAX.street),
    hub3Text(a.beneficiaryCity, HUB3_MAX.city),
    iban,
    model,
    reference,
    purpose,
    hub3Text(a.description, HUB3_MAX.description),
  ];
  // „Nakon zadnjeg znaka u polju, stavlja se graničnik" — every field, the
  // 14th included, ends with LF (as on the HEP and VG Čistoća bills).
  return fields.map((f) => `${f}\n`).join('');
}
