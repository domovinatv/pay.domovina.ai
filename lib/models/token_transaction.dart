class TokenTransaction {
  final String hash;
  final DateTime timestamp;
  final String from;
  final String to;
  final BigInt rawValue;
  final int decimals;
  final String tokenSymbol;
  final BigInt blockNumber;

  TokenTransaction({
    required this.hash,
    required this.timestamp,
    required this.from,
    required this.to,
    required this.rawValue,
    required this.decimals,
    required this.tokenSymbol,
    required this.blockNumber,
  });

  factory TokenTransaction.fromJson(Map<String, dynamic> json) {
    final ts = int.parse(json['timeStamp'].toString());
    return TokenTransaction(
      hash: json['hash'].toString(),
      timestamp: DateTime.fromMillisecondsSinceEpoch(ts * 1000),
      from: json['from'].toString(),
      to: json['to'].toString(),
      rawValue: BigInt.parse(json['value'].toString()),
      decimals: int.parse(json['tokenDecimal'].toString()),
      tokenSymbol: json['tokenSymbol']?.toString() ?? '',
      blockNumber: BigInt.parse(json['blockNumber'].toString()),
    );
  }

  bool isIncomingFor(String address) =>
      to.toLowerCase() == address.toLowerCase();

  /// Display value formatted with up to [maxFractionDigits] significant decimals.
  double get value {
    final divisor = BigInt.from(10).pow(decimals);
    final whole = rawValue ~/ divisor;
    final frac = rawValue - whole * divisor;
    return whole.toDouble() + frac.toDouble() / divisor.toDouble();
  }
}
