/// HUB3 (Croatian payment slip) 2D barcode payload builder.
/// Spec: FINA HUB-3 standard — 14 fields separated by \n.
///
/// Field layout:
///   1   HRVHUB30
///   2   Currency (EUR/HRK)
///   3   Amount in cents, 15 digits, zero-padded
///   4   Payer name        (empty when not specified)
///   5   Payer address     (empty when not specified)
///   6   Payer city        (empty when not specified)
///   7   Recipient name
///   8   Recipient address
///   9   Recipient city
///  10   Recipient IBAN
///  11   Model (HRxx)
///  12   Reference
///  13   Purpose code (4 chars, ISO 20022)
///  14   Description
class Hub3Payload {
  final String currency;
  final double amount;
  final String payerName;
  final String payerAddress;
  final String payerCity;
  final String name;
  final String address;
  final String city;
  final String iban;
  final String model;
  final String reference;
  final String purposeCode;
  final String description;

  const Hub3Payload({
    this.currency = 'EUR',
    required this.amount,
    this.payerName = '',
    this.payerAddress = '',
    this.payerCity = '',
    required this.name,
    required this.address,
    required this.city,
    required this.iban,
    this.model = 'HR00',
    this.reference = '',
    this.purposeCode = '',
    required this.description,
  });

  String build() {
    final cents = (amount * 100).round();
    final amountStr = cents.toString().padLeft(15, '0');
    return [
      'HRVHUB30',
      currency,
      amountStr,
      payerName,
      payerAddress,
      payerCity,
      name,
      address,
      city,
      iban.replaceAll(' ', ''),
      model,
      reference,
      purposeCode,
      description,
    ].join('\n');
  }
}
