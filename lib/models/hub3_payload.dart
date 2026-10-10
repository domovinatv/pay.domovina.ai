/// HUB3 (Croatian payment slip) 2D barcode payload builder.
/// Spec: HUB „HUB 3A obrazac — specifikacija PDF417 barkoda", verzija 6
/// (rujan 2022) — 14 fields, each terminated by LF (the 14th included).
/// Mirrors the rail's `backend/src/intents/hub3.ts`; checked against eight
/// real bills in docs/research/aircash/05-hub3-format-provjera.md.
///
/// Field layout (max length in characters):
///   1   HRVHUB30
///   2   Currency (EUR)
///   3   Amount in cents, 15 digits, zero-padded
///   4   Payer name        (30, empty when not specified)
///   5   Payer address     (27, empty when not specified)
///   6   Payer city        (27, empty when not specified)
///   7   Recipient name    (25)
///   8   Recipient address (25)
///   9   Recipient city    (27)
///  10   Recipient IBAN    (21)
///  11   Model (HRxx)      (4)
///  12   Reference         (22)
///  13   Purpose code      (4, ISO 20022)
///  14   Description       (35)
///
/// Text fields are reduced to the spec character set and written without
/// Croatian diacritics: the symbol carries no ECI marker, so decoders guess
/// the code page (Apple Vision turns „Južna" into „JuÅ¾na"). Over-long values
/// are cut to the field length, as the spec requires.
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

  static const _diacritics = {
    'Č': 'C', 'č': 'c', 'Ć': 'C', 'ć': 'c', 'Đ': 'D', 'đ': 'd',
    'Š': 'S', 'š': 's', 'Ž': 'Z', 'ž': 'z',
  };

  /// Spec character set without diacritics; anything else becomes a space,
  /// spaces collapse, and the result is cut to [max] characters.
  static String text(String value, int max) {
    final ascii = value.split('').map((c) => _diacritics[c] ?? c).join();
    final clean = ascii
        .replaceAll(RegExp(r"[^0-9A-Za-z ,.:\-+?'/()]"), ' ')
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    return (clean.length > max ? clean.substring(0, max) : clean).trimRight();
  }

  String build() {
    final cents = (amount * 100).round();
    final amountStr = cents.toString().padLeft(15, '0');
    final fields = [
      'HRVHUB30',
      currency,
      amountStr,
      text(payerName, 30),
      text(payerAddress, 27),
      text(payerCity, 27),
      text(name, 25),
      text(address, 25),
      text(city, 27),
      iban.replaceAll(' ', '').toUpperCase(),
      model.trim().toUpperCase(),
      text(reference, 22),
      purposeCode.trim().toUpperCase(),
      text(description, 35),
    ];
    // „Nakon zadnjeg znaka u polju, stavlja se graničnik" — LF after every
    // field, the last one included (as on the HEP and VG Čistoća bills).
    return fields.map((f) => '$f\n').join();
  }
}
