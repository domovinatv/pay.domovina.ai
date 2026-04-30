import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/token_transaction.dart';

class BlockscoutService {
  static const String defaultBase = 'https://gnosis.blockscout.com/api';

  final String baseUrl;
  final http.Client _client;

  BlockscoutService({this.baseUrl = defaultBase, http.Client? client})
      : _client = client ?? http.Client();

  Future<List<TokenTransaction>> tokenTransfers({
    required String address,
    required String contractAddress,
  }) async {
    final uri = Uri.parse(baseUrl).replace(queryParameters: {
      'module': 'account',
      'action': 'tokentx',
      'address': address,
      'contractaddress': contractAddress,
      'sort': 'desc',
    });
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw Exception('Blockscout HTTP ${res.statusCode}');
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final status = body['status']?.toString();
    if (status != '1') {
      // status "0" with message "No transactions found" is a normal empty case
      final msg = body['message']?.toString() ?? '';
      if (msg.toLowerCase().contains('no transactions')) return [];
      if (body['result'] is! List) {
        throw Exception('Blockscout error: $msg');
      }
    }
    final list = (body['result'] as List).cast<Map<String, dynamic>>();
    return list.map(TokenTransaction.fromJson).toList();
  }

  Future<BigInt> tokenBalance({
    required String address,
    required String contractAddress,
  }) async {
    final uri = Uri.parse(baseUrl).replace(queryParameters: {
      'module': 'account',
      'action': 'tokenbalance',
      'address': address,
      'contractaddress': contractAddress,
    });
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw Exception('Blockscout HTTP ${res.statusCode}');
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final result = body['result']?.toString() ?? '0';
    return BigInt.tryParse(result) ?? BigInt.zero;
  }

  void close() => _client.close();
}
