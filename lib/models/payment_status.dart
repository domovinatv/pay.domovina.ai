/// Canonical payment-status model mirroring the backend stage machine
/// (`backend/src/intents/stage.ts`). The copy table here is the single Dart
/// source of truth and must match the checkout page copy
/// (`backend/src/checkout/page.ts` STEP_COPY) — change both together.
library;

/// Backend `stage` enum — "gdje su moji novci".
enum PaymentStage {
  awaitingPayment('awaiting_payment'),
  receivedProcessing('received_processing'),
  minted('minted'),
  forwarding('forwarding'),
  settled('settled'),
  rejected('rejected'),
  expired('expired');

  const PaymentStage(this.wire);
  final String wire;

  static PaymentStage fromWire(String? v) => PaymentStage.values.firstWhere(
        (s) => s.wire == v,
        orElse: () => PaymentStage.awaitingPayment,
      );

  bool get isTerminal =>
      this == PaymentStage.settled || this == PaymentStage.rejected;

  /// Monerium holds (or already minted) the funds — the card-like "approved"
  /// moment. Show success from here on; settlement is only a detail.
  bool get isReceived =>
      this == PaymentStage.receivedProcessing ||
      this == PaymentStage.minted ||
      this == PaymentStage.forwarding;
}

/// Per-step marker: proof vs assumption.
/// proven = we have evidence; inProgress = we have a signal;
/// waiting = blind (time-based estimate only); failed = terminal problem.
enum StepStatus {
  proven('proven'),
  inProgress('in_progress'),
  waiting('waiting'),
  failed('failed');

  const StepStatus(this.wire);
  final String wire;

  static StepStatus fromWire(String? v) => StepStatus.values.firstWhere(
        (s) => s.wire == v,
        orElse: () => StepStatus.waiting,
      );
}

class PaymentStep {
  final String key; // payment | processing | minted | forwarding | settled
  final StepStatus status;
  final int? at; // unix seconds when proven/failed
  final String? txHash;
  final List<String> txHashes;

  const PaymentStep({
    required this.key,
    required this.status,
    this.at,
    this.txHash,
    this.txHashes = const [],
  });

  factory PaymentStep.fromJson(Map<String, dynamic> j) => PaymentStep(
        key: j['key'] as String? ?? '',
        status: StepStatus.fromWire(j['status'] as String?),
        at: (j['at'] as num?)?.toInt(),
        txHash: j['tx_hash'] as String?,
        txHashes: (j['tx_hashes'] as List?)?.cast<String>() ?? const [],
      );
}

class PaymentStatus {
  final PaymentStage stage;
  final List<PaymentStep> steps;
  final int elapsedSeconds;
  final int secondsInStage;
  final bool forwardExpected;
  final String? orderId;
  final String? orderState;
  final List<String> mintTxHashes;
  final String? forwardTxHash;
  final String? rejectedReason;

  /// Backend prediction while Monerium holds the funds: true = likely a first
  /// payment from this IBAN, which Monerium screens manually (minutes to
  /// hours); false = known payer, mint in seconds; null = unknown / n.a.
  final bool? reviewExpected;

  const PaymentStatus({
    required this.stage,
    required this.steps,
    required this.elapsedSeconds,
    required this.secondsInStage,
    required this.forwardExpected,
    this.orderId,
    this.orderState,
    this.mintTxHashes = const [],
    this.forwardTxHash,
    this.rejectedReason,
    this.reviewExpected,
  });

  factory PaymentStatus.fromJson(Map<String, dynamic> j) => PaymentStatus(
        stage: PaymentStage.fromWire(j['stage'] as String?),
        steps: (j['steps'] as List?)
                ?.cast<Map<String, dynamic>>()
                .map(PaymentStep.fromJson)
                .toList() ??
            const [],
        elapsedSeconds: (j['elapsed_seconds'] as num?)?.toInt() ?? 0,
        secondsInStage: (j['seconds_in_stage'] as num?)?.toInt() ?? 0,
        forwardExpected: j['forward_expected'] as bool? ?? true,
        orderId: j['order_id'] as String?,
        orderState: j['order_state'] as String?,
        mintTxHashes: (j['mint_tx_hashes'] as List?)?.cast<String>() ?? const [],
        forwardTxHash: j['forward_tx_hash'] as String?,
        rejectedReason: j['rejected_reason'] as String?,
        reviewExpected: j['review_expected'] as bool?,
      );
}

/// Stage→copy table (Croatian). Honesty rules from
/// docs/plans/payment-status-timeline.md: no fake progress in the blind
/// window, no "AML hold" claims, no "seconds" promise for a first payment,
/// custodian named on every step.
class StepCopy {
  final String title;
  final String custodian;
  const StepCopy(this.title, this.custodian);
}

const Map<String, StepCopy> kStepCopy = {
  'payment': StepCopy('Uplata iz tvoje banke', 'Skrbnik: tvoja banka'),
  'processing': StepCopy('Zaprimljeno — obrada i provjera',
      'Skrbnik: Monerium (regulirani izdavatelj e-novca)'),
  'minted': StepCopy('EURe iskovan', 'Na blockchainu (Gnosis)'),
  'forwarding': StepCopy('Prosljeđivanje primatelju', 'MPT relay'),
  'settled': StepCopy('Kod primatelja', 'Skrbnik: primatelj'),
};

/// Progressive-disclosure copy for the blind window (no Monerium order yet).
/// The only truthful signal is elapsed time, so copy escalates exactly when
/// the payer starts worrying — thresholds shared with the checkout page.
String blindWindowCopy(int elapsedSeconds) {
  if (elapsedSeconds < 8) return 'Čeka se uplata…';
  if (elapsedSeconds < 25) return 'Tvoja banka obrađuje uplatu…';
  return 'Čekamo tvoju banku. Prva uplata s novog računa zna potrajati '
      '(do 30 min). Novac je siguran. Ne moraš ništa raditi. '
      'Provjeri u Revolutu je li uplata poslana.';
}

/// One-line status per stage — dominant line in the POS/kiosk view.
String stageHeadline(PaymentStatus s) {
  switch (s.stage) {
    case PaymentStage.awaitingPayment:
      return 'Čeka se uplata';
    case PaymentStage.receivedProcessing:
    case PaymentStage.minted:
    case PaymentStage.forwarding:
      return 'Uplata zaprimljena ✓';
    case PaymentStage.settled:
      return 'Primljeno ✓';
    case PaymentStage.rejected:
      return 'Odbijeno — novac se vraća uplatitelju';
    case PaymentStage.expired:
      return 'Sesija istekla';
  }
}

/// Secondary explanation per stage (payer-facing timeline note).
String? stageNote(PaymentStatus s) {
  switch (s.stage) {
    case PaymentStage.awaitingPayment:
      return blindWindowCopy(s.elapsedSeconds);
    case PaymentStage.receivedProcessing:
      // Same copy as the checkout page overlay (updateSuccess in page.ts).
      final slow = s.reviewExpected == true || s.secondsInStage > 60;
      if (slow) {
        return 'Izdavanje EURe-a je u tijeku. Prva uplata s novog računa ide '
            'na provjeru kod Moneriuma i može potrajati, ponekad i nekoliko '
            'sati. Novac je siguran i ne moraš ništa raditi.';
      }
      return s.reviewExpected == false
          ? 'Izdavanje EURe-a je u tijeku. Obično traje nekoliko sekundi.'
          : 'Izdavanje EURe-a je u tijeku. Novac je siguran i ne moraš '
              'ništa raditi.';
    case PaymentStage.minted:
    case PaymentStage.forwarding:
      return 'EURe je izdan i prosljeđuje se primatelju…';
    case PaymentStage.settled:
      return 'Potvrđeno on-chain. Gotovo!';
    case PaymentStage.rejected:
      final why = s.rejectedReason;
      return '${why != null ? 'Razlog: $why. ' : ''}'
          'Novac se vraća na uplatiteljev račun.';
    case PaymentStage.expired:
      return 'Ako je uplata već poslana, novac će svejedno stići — '
          'status će se ovdje prikazati.';
  }
}
