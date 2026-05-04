import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/hpb_transaction.dart';

class HpbBackendService {
  /// Configurable at build time:
  ///   flutter run --dart-define=HPB_BACKEND_URL=https://your-worker.workers.dev
  static const String backendUrl =
      String.fromEnvironment('HPB_BACKEND_URL', defaultValue: '');

  static bool get isConfigured => backendUrl.isNotEmpty;

  final String baseUrl;
  final http.Client _client;

  HpbBackendService({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? backendUrl,
        _client = client ?? http.Client();

  Future<List<HpbAccount>> listAccounts() async {
    final res = await _client.get(Uri.parse('$baseUrl/api/hpb/accounts'));
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['accounts'] as List).cast<Map<String, dynamic>>();
    return list.map(HpbAccount.fromJson).toList();
  }

  Future<HpbAccountWithTx> fetchTransactions(String accountId) async {
    final res = await _client.get(Uri.parse(
        '$baseUrl/api/hpb/transactions?account_id=${Uri.encodeQueryComponent(accountId)}'));
    _ensureOk(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final account = HpbAccount.fromJson(body['account'] as Map<String, dynamic>);
    final transactions = (body['transactions'] as List)
        .cast<Map<String, dynamic>>()
        .map(HpbTransaction.fromJson)
        .toList();
    return HpbAccountWithTx(account: account, transactions: transactions);
  }

  void close() => _client.close();

  void _ensureOk(http.Response res) {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw Exception('Backend ${res.statusCode}: ${res.body}');
    }
  }
}

class HpbAccountWithTx {
  final HpbAccount account;
  final List<HpbTransaction> transactions;
  HpbAccountWithTx({required this.account, required this.transactions});
}
