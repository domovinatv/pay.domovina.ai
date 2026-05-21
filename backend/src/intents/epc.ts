/// EPC069-12 SEPA QR payload builder. Mirrors the strict 10-line layout
/// that Revolut iOS accepts (verified empirically — feedback_epc_format
/// memory: compact 8-line + 11-line layouts both fail, only 10 with
/// positional empties + drop the structured-reference slot works).
///
/// Used by the intent API to bake the EPC text shown on the checkout
/// page's QR. Keeping it server-side (rather than rendering on the
/// Flutter client) means the checkout page is fully self-contained
/// HTML and works without any client-side build step.

export interface EpcArgs {
  beneficiaryName: string;
  iban: string;
  amountEur: number;          // e.g. 1.02
  purposeCode?: string;       // 4-char ISO 20022, default OTHR
  remittanceInfo: string;     // unstructured, max 140 chars
  bic?: string;               // optional but recommended for non-EUR area routing
}

export function buildEpcText(a: EpcArgs): string {
  // EPC069-12 strict 10-line layout (no trailing fields after remittance).
  // Field order:
  //   1. Service tag                 BCD
  //   2. Version                     001 (compatible with iOS Revolut) or 002
  //   3. Character set               1 = UTF-8
  //   4. Identification code         SCT (SEPA Credit Transfer)
  //   5. BIC (optional, can be empty)
  //   6. Beneficiary name
  //   7. Beneficiary IBAN
  //   8. Amount (EUR + decimal, e.g. EUR1.02)
  //   9. Purpose (4 chars, default OTHR)
  //  10. Unstructured remittance information (max 140 chars)
  //
  // Both v001 and v002 are accepted by most banking apps; v001 is more
  // permissive about empty BIC. Use v002 when BIC supplied.
  const version = a.bic ? '002' : '001';
  const amount = `EUR${a.amountEur.toFixed(2)}`;
  return [
    'BCD',
    version,
    '1',
    'SCT',
    a.bic ?? '',
    a.beneficiaryName,
    a.iban.replace(/\s+/g, ''),
    amount,
    a.purposeCode ?? 'OTHR',
    a.remittanceInfo.slice(0, 140),
  ].join('\n');
}
