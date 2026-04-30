/// EPC QR (SEPA Credit Transfer) payload builder.
/// Spec: EPC069-12 v2.1 — "Quick Response Code: Guidelines to Enable
/// the Data Capture for the Initiation of a SEPA Credit Transfer".
///
/// Field layout (positional, separated by \n):
///   1  BCD
///   2  001
///   3  1
///   4  SCT
///   5  BIC
///   6  Name
///   7  IBAN
///   8  Amount       (empty when not prefilled)
///   9  Purpose code (empty when unused)
///  10  Remittance info
///
/// Empty fields between IBAN and remittance are kept as empty lines so
/// strict SEPA scanners (e.g. Revolut) don't reject the QR. Trailing
/// empties are trimmed.
class EpcPayload {
  final String bic;
  final String name;
  final String iban;
  final double? amount;
  final String purposeCode;
  final String remittanceInfo;

  const EpcPayload({
    required this.bic,
    required this.name,
    required this.iban,
    this.amount,
    this.purposeCode = '',
    this.remittanceInfo = '',
  });

  String build() {
    final hasAmount = amount != null && amount! > 0;
    final amountStr =
        hasAmount ? 'EUR${amount!.toStringAsFixed(2)}' : '';

    final lines = <String>[
      'BCD',
      '001',
      '1',
      'SCT',
      bic,
      name,
      iban.replaceAll(' ', ''),
      amountStr,
      purposeCode,
      remittanceInfo,
    ];

    while (lines.isNotEmpty && lines.last.isEmpty) {
      lines.removeLast();
    }

    return lines.join('\n');
  }
}
