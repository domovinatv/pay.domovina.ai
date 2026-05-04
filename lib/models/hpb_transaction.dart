class HpbAccount {
  final String id;
  final String? iban;
  final String? name;
  final String? currency;
  final int? lastRefreshedAt;

  HpbAccount({
    required this.id,
    this.iban,
    this.name,
    this.currency,
    this.lastRefreshedAt,
  });

  factory HpbAccount.fromJson(Map<String, dynamic> j) => HpbAccount(
        id: j['id'].toString(),
        iban: j['iban']?.toString(),
        name: j['name']?.toString(),
        currency: j['currency']?.toString(),
        lastRefreshedAt: j['last_refreshed_at'] is int
            ? j['last_refreshed_at'] as int
            : null,
      );
}

class HpbTransaction {
  final String id;
  final DateTime? bookingDate;
  final DateTime? valueDate;
  final double amount;
  final String? currency;
  final String? remittanceInfo;
  final String? counterpartyName;
  final String? counterpartyIban;

  HpbTransaction({
    required this.id,
    required this.amount,
    this.bookingDate,
    this.valueDate,
    this.currency,
    this.remittanceInfo,
    this.counterpartyName,
    this.counterpartyIban,
  });

  bool get isIncoming => amount >= 0;

  static DateTime? _parseDate(dynamic v) {
    if (v == null) return null;
    return DateTime.tryParse(v.toString());
  }

  factory HpbTransaction.fromJson(Map<String, dynamic> j) => HpbTransaction(
        id: j['id'].toString(),
        bookingDate: _parseDate(j['booking_date']),
        valueDate: _parseDate(j['value_date']),
        amount: (j['amount'] as num).toDouble(),
        currency: j['currency']?.toString(),
        remittanceInfo: j['remittance_info']?.toString(),
        counterpartyName: j['counterparty_name']?.toString(),
        counterpartyIban: j['counterparty_iban']?.toString(),
      );
}
