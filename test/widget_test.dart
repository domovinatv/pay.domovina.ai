import 'package:flutter_test/flutter_test.dart';
import 'package:pay_domovina/models/eip681_payload.dart';
import 'package:pay_domovina/models/epc_payload.dart';
import 'package:pay_domovina/models/hub3_payload.dart';

void main() {
  test('EPC: no amount + remittance keeps two empty lines after IBAN', () {
    final out = const EpcPayload(
      bic: 'LHVBEE22',
      name: 'ITalk d.o.o.',
      iban: 'EE707777000162921128',
      remittanceInfo: 'gnosis:0x7582f6f5F876E294627934adE3e5b7d1d231b030',
    ).build();

    final lines = out.split('\n');
    expect(lines.length, 10);
    expect(lines[6], 'EE707777000162921128');
    expect(lines[7], ''); // amount slot
    expect(lines[8], ''); // purpose slot
    expect(lines[9], 'gnosis:0x7582f6f5F876E294627934adE3e5b7d1d231b030');
  });

  test('EPC: amount + purpose + remittance fully populated (10 lines)', () {
    final out = const EpcPayload(
      bic: 'LHVBEE22',
      name: 'ITalk d.o.o.',
      iban: 'EE707777000162921128',
      amount: 19.91,
      purposeCode: 'OTHR',
      remittanceInfo: 'gnosis:0x7582f6f5F876E294627934adE3e5b7d1d231b030',
    ).build();

    final lines = out.split('\n');
    expect(lines.length, 10);
    expect(lines[7], 'EUR19.91');
    expect(lines[8], 'OTHR');
    expect(lines[9], 'gnosis:0x7582f6f5F876E294627934adE3e5b7d1d231b030');
  });

  test('EPC: trailing empties trimmed when no remittance', () {
    final out = const EpcPayload(
      bic: 'LHVBEE22',
      name: 'ITalk d.o.o.',
      iban: 'EE707777000162921128',
    ).build();

    expect(out.split('\n').length, 7);
  });

  test('HUB3 payload follows 14-field FINA standard with empty payer block', () {
    final out = const Hub3Payload(
      amount: 1.01,
      name: 'ITalk d.o.o.',
      address: 'IX. Južna obala 20',
      city: 'Zagreb',
      iban: 'HR6023900011500157044',
      reference: '1991',
      description: 'Donacija',
    ).build();

    final lines = out.split('\n');
    expect(lines.length, 14);
    expect(lines[0], 'HRVHUB30');
    expect(lines[1], 'EUR');
    expect(lines[2], '000000000000101');
    expect(lines[3], '');
    expect(lines[4], '');
    expect(lines[5], '');
    expect(lines[6], 'ITalk d.o.o.');
    expect(lines[7], 'IX. Južna obala 20');
    expect(lines[8], 'Zagreb');
    expect(lines[9], 'HR6023900011500157044');
    expect(lines[10], 'HR00');
    expect(lines[11], '1991');
    expect(lines[12], '');
    expect(lines[13], 'Donacija');
  });

  test('EIP-681 ERC-20 transfer matches reference URI', () {
    final out = const EipPayload(
      recipient: '0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c',
      chainId: 100,
      amount: 1.01,
      tokenContract: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
      tokenDecimals: 18,
    ).build();

    expect(
      out,
      'ethereum:0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430@100/transfer'
      '?address=0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c'
      '&uint256=1010000000000000000',
    );
  });

  test('EIP-681 native transfer (no token contract) uses value param', () {
    final out = const EipPayload(
      recipient: '0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c',
      chainId: 100,
      amount: 1.01,
    ).build();

    expect(
      out,
      'ethereum:0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c@100'
      '?value=1010000000000000000',
    );
  });

  test('EIP-681 omits amount param when no amount', () {
    final out = const EipPayload(
      recipient: '0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c',
      chainId: 100,
      tokenContract: '0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430',
    ).build();

    expect(
      out,
      'ethereum:0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430@100/transfer'
      '?address=0xb2AF1Dc5A6290C3B9c69C486014203C823bD7A9c',
    );
  });
}
