import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../main.dart' show DomovinaBrand;
import '../models/payment_status.dart';
import '../services/intent_service.dart';

/// In-app payment status timeline ("gdje su moji novci") + merchant POS mode.
///
/// Renders the same honest stage machine as the checkout page: vertical
/// steps with proof markers (✓ proven / pulsing in-progress / hollow
/// waiting / ⚠ failed), custodian named per step, progressive-disclosure
/// copy in the blind bank window, terminal screens for rejected/expired.
///
/// POS mode (toggle in the app bar) flips to a fullscreen glanceable view:
/// one dominant status line + amount, stays alive through long waits, big
/// green "Primljeno ✓" on settled.
class PaymentStatusPage extends StatefulWidget {
  const PaymentStatusPage({
    super.key,
    required this.sid,
    required this.targetAddress,
    required this.amountEur,
    this.startInPosMode = false,
  });

  final String sid;
  final String targetAddress;
  final double amountEur;
  final bool startInPosMode;

  @override
  State<PaymentStatusPage> createState() => _PaymentStatusPageState();
}

class _PaymentStatusPageState extends State<PaymentStatusPage> {
  static const _success = Color(0xFF2E8540);
  static const _warning = Color(0xFFB45309);
  static const _danger = Color(0xFFB42318);

  final _service = IntentService();
  Timer? _pollTimer;
  Timer? _tickTimer;
  IntentStatusSnapshot? _snapshot;
  String? _error;
  bool _posMode = false;

  /// Local elapsed clock between polls: server value + seconds since sync.
  int _serverElapsed = 0;
  DateTime _lastSync = DateTime.now();

  int get _elapsed =>
      _serverElapsed + DateTime.now().difference(_lastSync).inSeconds;

  @override
  void initState() {
    super.initState();
    _posMode = widget.startInPosMode;
    _bootstrap();
    // 1 s UI tick keeps the blind-window elapsed copy live between polls.
    _tickTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      final stage = _snapshot?.status?.stage;
      if (stage == PaymentStage.awaitingPayment && mounted) setState(() {});
    });
  }

  Future<void> _bootstrap() async {
    try {
      await _service.createIntent(
        sid: widget.sid,
        targetAddress: widget.targetAddress,
        amountEur: widget.amountEur,
      );
    } catch (e) {
      // 409 is swallowed by the service; anything else means the backend is
      // unreachable — surface it, polling below will keep retrying anyway.
      if (mounted) setState(() => _error = '$e');
    }
    await _poll();
    // Same 2 s cadence as the checkout page (decision: stay on polling).
    _pollTimer = Timer.periodic(const Duration(seconds: 2), (_) => _poll());
  }

  Future<void> _poll() async {
    try {
      final snap = await _service.fetchStatus(widget.sid);
      if (!mounted) return;
      setState(() {
        _snapshot = snap;
        _error = null;
        _serverElapsed = snap.status?.elapsedSeconds ?? _serverElapsed;
        _lastSync = DateTime.now();
      });
      final stage = snap.status?.stage;
      if (stage != null && stage.isTerminal) {
        _pollTimer?.cancel();
      }
    } catch (e) {
      if (mounted && _snapshot == null) setState(() => _error = '$e');
    }
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _tickTimer?.cancel();
    _service.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_posMode) return _buildPosView();
    return Scaffold(
      appBar: AppBar(
        title: const Text('Status uplate'),
        actions: [
          TextButton.icon(
            onPressed: () => setState(() => _posMode = true),
            icon: const Icon(Icons.storefront, color: DomovinaBrand.white),
            label: const Text('POS mod',
                style: TextStyle(color: DomovinaBrand.white)),
          ),
        ],
      ),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    final snap = _snapshot;
    if (snap == null) {
      return Center(
        child: _error != null
            ? Padding(
                padding: const EdgeInsets.all(24),
                child: Text('Greška: $_error\nPokušavam ponovno…',
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: DomovinaBrand.muted)),
              )
            : const CircularProgressIndicator(),
      );
    }
    final status = snap.status;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _amountHeader(snap),
              const SizedBox(height: 16),
              if (status != null) ...[
                _stageBanner(status),
                const SizedBox(height: 16),
                ..._timelineSteps(status),
              ],
              const SizedBox(height: 12),
              Text(
                'Sesija: ${widget.sid}',
                textAlign: TextAlign.center,
                style: const TextStyle(
                    fontSize: 12,
                    color: DomovinaBrand.muted,
                    fontFamily: 'Menlo'),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _amountHeader(IntentStatusSnapshot snap) {
    return Column(
      children: [
        Text(
          '${snap.amountEur} EUR',
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 40,
            fontWeight: FontWeight.w800,
            color: DomovinaBrand.navy,
          ),
        ),
        const Text(
          'IZNOS ZA PLAĆANJE',
          textAlign: TextAlign.center,
          style: TextStyle(
            fontSize: 11,
            letterSpacing: 1.2,
            color: DomovinaBrand.muted,
          ),
        ),
      ],
    );
  }

  Color _stageColor(PaymentStage stage) {
    switch (stage) {
      case PaymentStage.settled:
        return _success;
      case PaymentStage.rejected:
      case PaymentStage.expired:
        return _danger;
      default:
        return _warning;
    }
  }

  Widget _stageBanner(PaymentStatus status) {
    final color = _stageColor(status.stage);
    final note = stageNote(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        border: Border.all(color: color.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            stageHeadline(status),
            style: TextStyle(
                fontSize: 16, fontWeight: FontWeight.w700, color: color),
          ),
          if (note != null) ...[
            const SizedBox(height: 4),
            Text(note,
                style: const TextStyle(
                    fontSize: 13, height: 1.4, color: DomovinaBrand.navy)),
          ],
          if (status.stage == PaymentStage.awaitingPayment) ...[
            const SizedBox(height: 4),
            Text('Proteklo: ${_fmtClock(_elapsed)}',
                style: const TextStyle(
                    fontSize: 12,
                    color: DomovinaBrand.muted,
                    fontFeatures: [FontFeature.tabularFigures()])),
          ],
        ],
      ),
    );
  }

  List<Widget> _timelineSteps(PaymentStatus status) {
    final steps = status.steps;
    return [
      for (var i = 0; i < steps.length; i++)
        _timelineStep(steps[i], status, isLast: i == steps.length - 1),
    ];
  }

  Widget _timelineStep(PaymentStep step, PaymentStatus status,
      {required bool isLast}) {
    final copy = kStepCopy[step.key] ?? StepCopy(step.key, '');
    final marker = _marker(step.status);
    final titleColor = step.status == StepStatus.waiting
        ? DomovinaBrand.muted
        : DomovinaBrand.navy;
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 30,
            child: Column(
              children: [
                marker,
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 2,
                      color: step.status == StepStatus.proven
                          ? _success
                          : DomovinaBrand.border,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(bottom: isLast ? 0 : 18),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(copy.title,
                      style: TextStyle(
                          fontSize: 14.5,
                          fontWeight: FontWeight.w700,
                          color: titleColor)),
                  Text(copy.custodian,
                      style: const TextStyle(
                          fontSize: 12, color: DomovinaBrand.muted)),
                  ..._stepExtras(step, status),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _stepExtras(PaymentStep step, PaymentStatus status) {
    final widgets = <Widget>[];
    // Blind-window / stage note appears under the step that owns the stage.
    final ownsNote =
        (step.key == 'payment' && status.stage == PaymentStage.awaitingPayment) ||
            (step.key == 'processing' &&
                (status.stage == PaymentStage.receivedProcessing ||
                    status.stage == PaymentStage.rejected)) ||
            (step.key == 'forwarding' && status.stage == PaymentStage.forwarding) ||
            (step.key == 'settled' && status.stage == PaymentStage.settled);
    if (ownsNote) {
      final note = stageNote(status);
      if (note != null) {
        widgets.add(Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(note,
              style: const TextStyle(
                  fontSize: 12.5, height: 1.35, color: DomovinaBrand.navy)),
        ));
      }
    }
    if (step.key == 'forwarding' && step.status == StepStatus.failed) {
      widgets.add(const Padding(
        padding: EdgeInsets.only(top: 4),
        child: Text(
          'Prosljeđivanje nije uspjelo — novac je siguran u MPT Safeu, '
          'rješava se ručno.',
          style: TextStyle(fontSize: 12.5, height: 1.35, color: _danger),
        ),
      ));
    }
    final hashes = <String>[
      if (step.key == 'minted') ...status.mintTxHashes,
      if ((step.key == 'forwarding' || step.key == 'settled') &&
          step.txHash != null)
        step.txHash!,
    ];
    for (final h in hashes) {
      widgets.add(Padding(
        padding: const EdgeInsets.only(top: 3),
        child: InkWell(
          onTap: () => launchUrl(Uri.parse('https://gnosisscan.io/tx/$h'),
              mode: LaunchMode.externalApplication),
          child: Text(
            'tx ${_shortHash(h)} →',
            style: const TextStyle(
                fontSize: 12,
                fontFamily: 'Menlo',
                color: DomovinaBrand.navy,
                decoration: TextDecoration.underline),
          ),
        ),
      ));
    }
    return widgets;
  }

  Widget _marker(StepStatus s) {
    switch (s) {
      case StepStatus.proven:
        return Container(
          width: 24,
          height: 24,
          decoration:
              const BoxDecoration(color: _success, shape: BoxShape.circle),
          child: const Icon(Icons.check, size: 16, color: Colors.white),
        );
      case StepStatus.inProgress:
        return Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: _warning, width: 2),
          ),
          padding: const EdgeInsets.all(4),
          child: const CircularProgressIndicator(
              strokeWidth: 2, color: _warning),
        );
      case StepStatus.failed:
        return Container(
          width: 24,
          height: 24,
          decoration:
              const BoxDecoration(color: _danger, shape: BoxShape.circle),
          child:
              const Icon(Icons.priority_high, size: 15, color: Colors.white),
        );
      case StepStatus.waiting:
        return Container(
          width: 24,
          height: 24,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: DomovinaBrand.border, width: 2),
          ),
        );
    }
  }

  // ---- POS / kiosk view ----------------------------------------------

  Widget _buildPosView() {
    final snap = _snapshot;
    final status = snap?.status;
    final stage = status?.stage ?? PaymentStage.awaitingPayment;
    final settled = stage == PaymentStage.settled;
    final color = settled
        ? _success
        : (stage == PaymentStage.rejected || stage == PaymentStage.expired)
            ? _danger
            : DomovinaBrand.navy;
    return Scaffold(
      backgroundColor: settled ? _success : DomovinaBrand.surface,
      body: SafeArea(
        child: Stack(
          children: [
            Center(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Text(
                    snap != null ? '${snap.amountEur} EUR' : '…',
                    style: TextStyle(
                      fontSize: 64,
                      fontWeight: FontWeight.w800,
                      color: settled ? Colors.white : DomovinaBrand.navy,
                    ),
                  ),
                  const SizedBox(height: 24),
                  if (settled)
                    const Icon(Icons.check_circle,
                        size: 96, color: Colors.white)
                  else if (stage != PaymentStage.rejected &&
                      stage != PaymentStage.expired)
                    const SizedBox(
                      width: 56,
                      height: 56,
                      child: CircularProgressIndicator(
                          strokeWidth: 5, color: DomovinaBrand.navy),
                    ),
                  const SizedBox(height: 24),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 32),
                    child: Text(
                      status != null ? stageHeadline(status) : 'Učitavanje…',
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 36,
                        fontWeight: FontWeight.w700,
                        color: settled ? Colors.white : color,
                      ),
                    ),
                  ),
                  if (stage == PaymentStage.awaitingPayment) ...[
                    const SizedBox(height: 12),
                    Text(
                      'Proteklo: ${_fmtClock(_elapsed)}',
                      style: const TextStyle(
                          fontSize: 20,
                          color: DomovinaBrand.muted,
                          fontFeatures: [FontFeature.tabularFigures()]),
                    ),
                    if (_elapsed >= 25)
                      const Padding(
                        padding: EdgeInsets.fromLTRB(48, 16, 48, 0),
                        child: Text(
                          'Prva uplata s novog računa zna potrajati '
                          '(do 30 min). Novac je siguran.',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              fontSize: 16,
                              height: 1.4,
                              color: DomovinaBrand.muted),
                        ),
                      ),
                  ],
                ],
              ),
            ),
            Positioned(
              top: 8,
              right: 8,
              child: IconButton(
                onPressed: () => setState(() => _posMode = false),
                icon: Icon(Icons.close,
                    color: settled ? Colors.white : DomovinaBrand.muted),
                tooltip: 'Zatvori POS mod',
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _fmtClock(int secs) {
    if (secs <= 0) return '0:00';
    final m = secs ~/ 60;
    final s = secs % 60;
    return '$m:${s.toString().padLeft(2, '0')}';
  }

  static String _shortHash(String h) =>
      h.length > 20 ? '${h.substring(0, 10)}…${h.substring(h.length - 8)}' : h;
}
