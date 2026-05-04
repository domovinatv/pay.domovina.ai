import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../models/hpb_transaction.dart';
import '../services/hpb_backend_service.dart';

class HpbHistoryPage extends StatefulWidget {
  final String iban;

  const HpbHistoryPage({super.key, required this.iban});

  @override
  State<HpbHistoryPage> createState() => _HpbHistoryPageState();
}

class _HpbHistoryPageState extends State<HpbHistoryPage> {
  static final _amountFmt = NumberFormat.currency(
      locale: 'hr_HR', symbol: '€', decimalDigits: 2);
  static final _dateFmt = DateFormat('dd.MM.yyyy');

  final _service = HpbBackendService();
  Future<HpbAccountWithTx?>? _future;

  @override
  void initState() {
    super.initState();
    if (HpbBackendService.isConfigured) {
      _future = _load();
    }
  }

  @override
  void dispose() {
    _service.close();
    super.dispose();
  }

  Future<HpbAccountWithTx?> _load() async {
    final accounts = await _service.listAccounts();
    if (accounts.isEmpty) return null;
    final match = accounts.firstWhere(
      (a) => a.iban?.replaceAll(' ', '') == widget.iban.replaceAll(' ', ''),
      orElse: () => accounts.first,
    );
    return _service.fetchTransactions(match.id);
  }

  void _refresh() => setState(() => _future = _load());

  @override
  Widget build(BuildContext context) {
    if (!HpbBackendService.isConfigured) return _placeholder();
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async => _refresh(),
        child: FutureBuilder<HpbAccountWithTx?>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snap.hasError) return _error(snap.error.toString());
            final data = snap.data;
            if (data == null) return _noAccountsView();
            return _txList(data);
          },
        ),
      ),
    );
  }

  Widget _txList(HpbAccountWithTx data) {
    final inSum = data.transactions
        .where((t) => t.isIncoming)
        .fold<double>(0, (a, t) => a + t.amount);
    final outSum = data.transactions
        .where((t) => !t.isIncoming)
        .fold<double>(0, (a, t) => a + t.amount.abs());
    final balance = inSum - outSum;
    return ListView.builder(
      padding: const EdgeInsets.all(16),
      itemCount: data.transactions.length + 1,
      itemBuilder: (context, i) {
        if (i == 0) return _header(data, balance, inSum, outSum);
        final t = data.transactions[i - 1];
        return _txTile(t);
      },
    );
  }

  Widget _header(HpbAccountWithTx data, double balance, double inSum,
      double outSum) {
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.account_balance, size: 22),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                      data.account.name ?? data.account.iban ?? widget.iban,
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w500)),
                ),
                IconButton(
                  tooltip: 'Osvježi',
                  icon: const Icon(Icons.refresh),
                  onPressed: _refresh,
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              _amountFmt.format(balance),
              style: const TextStyle(
                  fontSize: 36, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 4),
            Text(
                '${data.account.iban ?? widget.iban} • ${data.account.currency ?? "EUR"}',
                style: TextStyle(
                    color: Colors.grey[600], fontFamily: 'Menlo', fontSize: 12)),
            const Divider(height: 32),
            Row(
              children: [
                _stat('Uplate', _amountFmt.format(inSum), Colors.green[700]!,
                    Icons.arrow_downward),
                const SizedBox(width: 12),
                _stat('Isplate', _amountFmt.format(outSum), Colors.red[700]!,
                    Icons.arrow_upward),
                const SizedBox(width: 12),
                _stat('Transakcije', '${data.transactions.length}',
                    Colors.grey[800]!, Icons.receipt_long),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _stat(String label, String value, Color color, IconData icon) {
    return Expanded(
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(icon, size: 14, color: color),
                const SizedBox(width: 4),
                Text(label,
                    style: TextStyle(
                        fontSize: 11,
                        color: color,
                        fontWeight: FontWeight.w500)),
              ],
            ),
            const SizedBox(height: 4),
            Text(value,
                style: TextStyle(
                    fontSize: 16, color: color, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Widget _txTile(HpbTransaction t) {
    final color = t.isIncoming ? Colors.green[700]! : Colors.red[700]!;
    final sign = t.isIncoming ? '+' : '−';
    final cp = t.counterpartyName ?? t.counterpartyIban ?? '—';
    final date = t.bookingDate ?? t.valueDate;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Row(
          children: [
            CircleAvatar(
              backgroundColor: color.withValues(alpha: 0.12),
              child: Icon(
                  t.isIncoming ? Icons.arrow_downward : Icons.arrow_upward,
                  color: color),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(t.isIncoming ? 'Uplata' : 'Isplata',
                      style: TextStyle(
                          color: color,
                          fontWeight: FontWeight.w600,
                          fontSize: 13)),
                  const SizedBox(height: 2),
                  Text(cp,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 13)),
                  if (t.remittanceInfo != null && t.remittanceInfo!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(t.remittanceInfo!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                              fontSize: 12, color: Colors.grey[600])),
                    ),
                  if (date != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(_dateFmt.format(date),
                          style: TextStyle(
                              fontSize: 11, color: Colors.grey[500])),
                    ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            Text(
                '$sign${_amountFmt.format(t.amount.abs())}',
                style: TextStyle(
                    color: color,
                    fontWeight: FontWeight.w700,
                    fontSize: 16)),
          ],
        ),
      ),
    );
  }

  Widget _error(String message) {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 60),
        const Icon(Icons.cloud_off, size: 48, color: Colors.grey),
        const SizedBox(height: 16),
        Text('Greška: $message',
            textAlign: TextAlign.center,
            style: TextStyle(color: Colors.grey[700])),
        const SizedBox(height: 16),
        Center(
          child: FilledButton.icon(
            onPressed: _refresh,
            icon: const Icon(Icons.refresh),
            label: const Text('Pokušaj ponovo'),
          ),
        ),
      ],
    );
  }

  Widget _noAccountsView() {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        const SizedBox(height: 60),
        Icon(Icons.link_off, size: 48, color: Colors.grey[500]),
        const SizedBox(height: 16),
        const Text('Nema povezanih računa',
            textAlign: TextAlign.center,
            style:
                TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        Text(
          'Pokreni connect flow s admin tokenom (vidi backend/README, '
          'curl POST /api/hpb/admin/connect → otvori SCA link → '
          'POST /api/hpb/admin/finalize/{requisitionId}).',
          textAlign: TextAlign.center,
          style: TextStyle(color: Colors.grey[700]),
        ),
      ],
    );
  }

  Widget _placeholder() {
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 520),
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Card(
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      const Icon(Icons.account_balance,
                          size: 28, color: Colors.grey),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('HPB IBAN',
                                style: TextStyle(
                                    fontSize: 18,
                                    fontWeight: FontWeight.w600)),
                            const SizedBox(height: 2),
                            Text(widget.iban,
                                style: TextStyle(
                                    fontFamily: 'Menlo',
                                    fontSize: 13,
                                    color: Colors.grey[700])),
                          ],
                        ),
                      ),
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 10, vertical: 4),
                        decoration: BoxDecoration(
                          color: Colors.amber[100],
                          borderRadius: BorderRadius.circular(12),
                        ),
                        child: Text('USKORO',
                            style: TextStyle(
                                fontSize: 11,
                                fontWeight: FontWeight.w700,
                                color: Colors.amber[900])),
                      ),
                    ],
                  ),
                  const Divider(height: 32),
                  Text('Backend nije konfiguriran.',
                      style: TextStyle(
                          fontSize: 15,
                          color: Colors.grey[800],
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 12),
                  Text(
                    'HPB pregled koristi Enable Banking PSD2 preko tvog '
                    'Cloudflare Worker backenda (free Personal tier). Build '
                    'app s --dart-define=HPB_BACKEND_URL=https://...workers.dev '
                    'da povežeš tab s backendom.',
                    style: TextStyle(
                        fontSize: 14,
                        color: Colors.grey[700],
                        height: 1.5),
                  ),
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: Colors.grey[100],
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: const SelectableText(
                      'flutter run -d macos \\\n'
                      '  --dart-define=HPB_BACKEND_URL=https://pay-domovina-backend.x.workers.dev',
                      style: TextStyle(
                          fontFamily: 'Menlo', fontSize: 12, height: 1.4),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text('Setup koraci u backend/README:',
                      style: TextStyle(
                          fontSize: 13,
                          color: Colors.grey[700],
                          fontWeight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  _bullet('Registriraj se na enablebanking.com (Personal)'),
                  _bullet('cd backend && npm install'),
                  _bullet('wrangler d1 create / kv namespace create'),
                  _bullet('wrangler secret put ENABLE_BANKING_APPLICATION_ID'),
                  _bullet('wrangler secret put ENABLE_BANKING_PRIVATE_KEY'),
                  _bullet('wrangler secret put ADMIN_TOKEN'),
                  _bullet('wrangler deploy'),
                  _bullet('curl admin/connect za HPB → otvori SCA link'),
                  _bullet('Callback hvata code automatski (refresh u D1)'),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _bullet(String text) => Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 6, right: 8),
              child: Icon(Icons.circle, size: 6, color: Colors.grey),
            ),
            Expanded(
                child: Text(text,
                    style: TextStyle(
                        fontSize: 12,
                        color: Colors.grey[700],
                        fontFamily: 'Menlo'))),
          ],
        ),
      );
}
