import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/payment_status.dart';

/// Client for the public payment-intents API on the MPT backend
/// (backend/src/intents/api.ts). Registers the app-generated sid so the
/// backend can correlate the incoming Monerium order, then polls the
/// per-stage status timeline.
class IntentService {
  /// Same Worker as HPB_BACKEND_URL but with a production default — status
  /// tracking should work out of the box in release builds.
  ///   flutter run --dart-define=MPT_BACKEND_URL=https://monerium.domovina.ai
  static const String backendUrl = String.fromEnvironment(
    'MPT_BACKEND_URL',
    defaultValue: 'https://monerium.domovina.ai',
  );

  final String baseUrl;
  final http.Client _client;

  IntentService({String? baseUrl, http.Client? client})
      : baseUrl = baseUrl ?? backendUrl,
        _client = client ?? http.Client();

  /// Creates a payment intent for an app-generated QR. The QR remittance
  /// (`mpt:0x…?sid=<sid>`) is built locally, so the SAME sid is registered
  /// here. A 409 means the intent already exists (e.g. status page reopened)
  /// — treated as success so tracking simply resumes.
  Future<void> createIntent({
    required String sid,
    required String targetAddress,
    required double amountEur,
    String? label,
  }) async {
    final res = await _client.post(
      Uri.parse('$baseUrl/api/intents'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'sid': sid,
        'target_address': targetAddress,
        'amount_eur': amountEur.toStringAsFixed(2),
        if (label != null && label.isNotEmpty) 'label': label,
      }),
    );
    if (res.statusCode == 409) return; // already registered — resume tracking
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw Exception('Backend ${res.statusCode}: ${res.body}');
    }
  }

  /// Fetches the intent's per-stage status. Poll this every ~2 s — the same
  /// cadence as the checkout page.
  Future<IntentStatusSnapshot> fetchStatus(String sid) async {
    final res = await _client.get(Uri.parse('$baseUrl/api/intents/$sid'));
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw Exception('Backend ${res.statusCode}: ${res.body}');
    }
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return IntentStatusSnapshot(
      sid: body['sid'] as String? ?? sid,
      state: body['state'] as String? ?? 'pending',
      amountEur: body['amount_eur'] as String? ?? '0.00',
      amountReceivedCents: (body['amount_received_cents'] as num?)?.toInt(),
      expiresAtUnix: _isoToUnix(body['expires_at'] as String?),
      status: body['status'] is Map<String, dynamic>
          ? PaymentStatus.fromJson(body['status'] as Map<String, dynamic>)
          : null,
    );
  }

  void close() => _client.close();

  static int? _isoToUnix(String? iso) {
    if (iso == null) return null;
    final dt = DateTime.tryParse(iso);
    return dt == null ? null : dt.millisecondsSinceEpoch ~/ 1000;
  }
}

class IntentStatusSnapshot {
  final String sid;
  final String state; // legacy pending|paid|expired (backward-compat field)
  final String amountEur;
  final int? amountReceivedCents;
  final int? expiresAtUnix;
  final PaymentStatus? status;

  const IntentStatusSnapshot({
    required this.sid,
    required this.state,
    required this.amountEur,
    this.amountReceivedCents,
    this.expiresAtUnix,
    this.status,
  });
}
