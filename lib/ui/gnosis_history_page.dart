import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/token_transaction.dart';
import '../services/blockscout_service.dart';

class GnosisHistoryPage extends StatefulWidget {
  final String address;
  final String tokenContract;
  final int decimals;
  final String symbol;

  const GnosisHistoryPage({
    super.key,
    required this.address,
    required this.tokenContract,
    this.decimals = 18,
    this.symbol = 'EURe',
  });

  @override
  State<GnosisHistoryPage> createState() => _GnosisHistoryPageState();
}

class _GnosisHistoryPageState extends State<GnosisHistoryPage> {
  final _service = BlockscoutService();
  late Future<_HistoryData> _future;

  static final _amountFmt = NumberFormat.currency(
      locale: 'hr_HR', symbol: '€', decimalDigits: 2);
  static final _dateFmt = DateFormat('dd.MM.yyyy HH:mm');

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _service.close();
    super.dispose();
  }

  Future<_HistoryData> _load() async {
    final results = await Future.wait([
      _service.tokenTransfers(
        address: widget.address,
        contractAddress: widget.tokenContract,
      ),
      _service.tokenBalance(
        address: widget.address,
        contractAddress: widget.tokenContract,
      ),
    ]);
    final txs = results[0] as List<TokenTransaction>;
    final bal = results[1] as BigInt;
    return _HistoryData(transactions: txs, balanceRaw: bal);
  }

  void _refresh() {
    setState(() => _future = _load());
  }

  double _toDouble(BigInt raw) {
    final divisor = BigInt.from(10).pow(widget.decimals);
    final whole = raw ~/ divisor;
    final frac = raw - whole * divisor;
    return whole.toDouble() + frac.toDouble() / divisor.toDouble();
  }

  String _shortHash(String s) =>
      s.length > 14 ? '${s.substring(0, 8)}…${s.substring(s.length - 6)}' : s;

  String _shortAddr(String s) =>
      s.length > 12 ? '${s.substring(0, 6)}…${s.substring(s.length - 4)}' : s;

  Future<void> _openTx(String hash) async {
    final uri = Uri.parse('https://gnosis.blockscout.com/tx/$hash');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Ne mogu otvoriti $uri')));
    }
  }

  Future<void> _openAddress() async {
    final uri = Uri.parse(
        'https://gnosis.blockscout.com/address/${widget.address}');
    if (!await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Ne mogu otvoriti $uri')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () async => _refresh(),
        child: FutureBuilder<_HistoryData>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) {
              return const Center(child: CircularProgressIndicator());
            }
            if (snap.hasError) {
              return _errorView(snap.error.toString());
            }
            final data = snap.data!;
            return ListView.builder(
              padding: const EdgeInsets.all(16),
              itemCount: data.transactions.length + 1,
              itemBuilder: (context, i) {
                if (i == 0) return _headerCard(data);
                final tx = data.transactions[i - 1];
                return _txTile(tx);
              },
            );
          },
        ),
      ),
    );
  }

  Widget _errorView(String message) {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
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

  Widget _headerCard(_HistoryData data) {
    final balance = _toDouble(data.balanceRaw);
    final inSum = data.transactions
        .where((t) => t.isIncomingFor(widget.address))
        .fold<double>(0, (a, t) => a + t.value);
    final outSum = data.transactions
        .where((t) => !t.isIncomingFor(widget.address))
        .fold<double>(0, (a, t) => a + t.value);
    return Card(
      margin: const EdgeInsets.only(bottom: 16),
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.account_balance_wallet, size: 22),
                const SizedBox(width: 8),
                const Text('Trenutno stanje',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w500)),
                const Spacer(),
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
            Text('${widget.symbol} • Gnosis Chain',
                style: TextStyle(color: Colors.grey[600])),
            const Divider(height: 32),
            Row(
              children: [
                _statBlock(
                    label: 'Ukupno uplate',
                    value: _amountFmt.format(inSum),
                    color: Colors.green[700]!,
                    icon: Icons.arrow_downward),
                const SizedBox(width: 16),
                _statBlock(
                    label: 'Ukupno isplate',
                    value: _amountFmt.format(outSum),
                    color: Colors.red[700]!,
                    icon: Icons.arrow_upward),
                const SizedBox(width: 16),
                _statBlock(
                    label: 'Broj transakcija',
                    value: data.transactions.length.toString(),
                    color: Colors.grey[800]!,
                    icon: Icons.receipt_long),
              ],
            ),
            const SizedBox(height: 16),
            InkWell(
              onTap: _openAddress,
              child: Row(
                children: [
                  const Icon(Icons.public, size: 16, color: Colors.grey),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      widget.address,
                      style: TextStyle(
                          fontFamily: 'Menlo',
                          fontSize: 12,
                          color: Colors.grey[700]),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  IconButton(
                    iconSize: 16,
                    tooltip: 'Kopiraj adresu',
                    icon: const Icon(Icons.copy),
                    onPressed: () async {
                      await Clipboard.setData(
                          ClipboardData(text: widget.address));
                      if (!mounted) return;
                      ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                              content: Text('Adresa kopirana')));
                    },
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _statBlock({
    required String label,
    required String value,
    required Color color,
    required IconData icon,
  }) {
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
                    fontSize: 16,
                    color: color,
                    fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Widget _txTile(TokenTransaction tx) {
    final incoming = tx.isIncomingFor(widget.address);
    final color = incoming ? Colors.green[700]! : Colors.red[700]!;
    final sign = incoming ? '+' : '−';
    final counterparty = incoming ? tx.from : tx.to;
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: () => _openTx(tx.hash),
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Row(
            children: [
              CircleAvatar(
                backgroundColor: color.withValues(alpha: 0.12),
                child: Icon(
                    incoming ? Icons.arrow_downward : Icons.arrow_upward,
                    color: color),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      incoming ? 'Uplata' : 'Isplata',
                      style: TextStyle(
                          color: color,
                          fontWeight: FontWeight.w600,
                          fontSize: 13),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${incoming ? "od" : "za"} ${_shortAddr(counterparty)}',
                      style: const TextStyle(
                          fontFamily: 'Menlo', fontSize: 12),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      '${_dateFmt.format(tx.timestamp)} • ${_shortHash(tx.hash)}',
                      style:
                          TextStyle(fontSize: 11, color: Colors.grey[600]),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '$sign${_amountFmt.format(tx.value)}',
                style: TextStyle(
                    color: color,
                    fontWeight: FontWeight.w700,
                    fontSize: 16),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HistoryData {
  final List<TokenTransaction> transactions;
  final BigInt balanceRaw;
  _HistoryData({required this.transactions, required this.balanceRaw});
}
