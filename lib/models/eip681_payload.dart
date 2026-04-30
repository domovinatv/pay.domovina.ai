/// EIP-681 payment URI builder.
/// Spec: https://eips.ethereum.org/EIPS/eip-681
///
/// - When [tokenContract] is empty: native transfer
///     `ethereum:<recipient>@<chainId>?value=<wei>`
/// - When [tokenContract] is set: ERC-20 transfer
///     `ethereum:<token>@<chainId>/transfer?address=<recipient>&uint256=<units>`
class EipPayload {
  final String recipient;
  final int chainId;
  final double? amount;
  final String tokenContract;
  final int tokenDecimals;

  const EipPayload({
    required this.recipient,
    required this.chainId,
    this.amount,
    this.tokenContract = '',
    this.tokenDecimals = 18,
  });

  String build() {
    final hasAmount = amount != null && amount! > 0;

    if (tokenContract.isEmpty) {
      final query = hasAmount ? '?value=${_units(amount!, tokenDecimals)}' : '';
      return 'ethereum:$recipient@$chainId$query';
    }

    final amountQuery = hasAmount
        ? '&uint256=${_units(amount!, tokenDecimals)}'
        : '';
    return 'ethereum:$tokenContract@$chainId/transfer'
        '?address=$recipient$amountQuery';
  }

  /// Convert a decimal amount to integer smallest units using BigInt
  /// to preserve precision (avoids double overflow for 18 decimals).
  static String _units(double amount, int decimals) {
    final cents = (amount * 100).round();
    final units = BigInt.from(cents) * BigInt.from(10).pow(decimals - 2);
    return units.toString();
  }
}
