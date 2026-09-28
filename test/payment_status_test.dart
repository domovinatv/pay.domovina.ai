import 'package:flutter_test/flutter_test.dart';
import 'package:pay_domovina/models/payment_status.dart';

PaymentStatus status(String stage, {bool? review, int inStage = 5}) =>
    PaymentStatus.fromJson({
      'stage': stage,
      'steps': <Map<String, dynamic>>[],
      'seconds_in_stage': inStage,
      'review_expected': review,
    });

void main() {
  test('received stages read as success, settlement still pending', () {
    for (final s in ['received_processing', 'minted', 'forwarding']) {
      expect(PaymentStage.fromWire(s).isReceived, isTrue);
      expect(stageHeadline(status(s)), 'Uplata zaprimljena ✓');
    }
    expect(PaymentStage.settled.isReceived, isFalse);
  });

  test('first payment from a new IBAN warns about Monerium screening', () {
    expect(stageNote(status('received_processing', review: true)),
        contains('Prva uplata s novog računa'));
    expect(stageNote(status('received_processing', inStage: 90)),
        contains('Prva uplata s novog računa'));
  });

  test('"seconds" promised only for a known payer', () {
    expect(stageNote(status('received_processing', review: false)),
        contains('nekoliko sekundi'));
    expect(stageNote(status('received_processing')),
        isNot(contains('sekundi')));
  });
}
