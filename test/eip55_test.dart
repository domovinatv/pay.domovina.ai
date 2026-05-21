import 'package:flutter_test/flutter_test.dart';
import 'package:pay_domovina/utils/eip55.dart';

void main() {
  group('EIP-55 checksum validator', () {
    // Test vectors from https://eips.ethereum.org/EIPS/eip-55
    const validChecksumAddresses = [
      '0x52908400098527886E0F7030069857D2E4169EE7',
      '0x8617E340B3D01FA5F11F306F4090FD50E238070D',
      '0xde709f2102306220921060314715629080e2fb77',
      '0x27b1fdb04752bbc536007a920d24acb045561c26',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
      '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
    ];

    test('validates official EIP-55 test vectors as either checksum or no-checksum', () {
      for (final a in validChecksumAddresses) {
        final r = Eip55.validate(a);
        expect(r == Eip55Result.validChecksum || r == Eip55Result.validNoChecksum, isTrue,
            reason: 'Expected $a to pass; got $r');
      }
    });

    test('detects single-character typo in MPT main-rail Safe address', () {
      const original = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e';
      expect(Eip55.validate(original), Eip55Result.validChecksum);

      // Flip one nibble in the middle — common typo pattern
      const typo = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAfFe'; // 2e → Fe
      expect(Eip55.validate(typo), Eip55Result.badChecksum,
          reason: 'Single-char nibble flip should trip EIP-55 check');
    });

    test('accepts all-lowercase (no checksum claim)', () {
      const addr = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
      expect(Eip55.validate(addr), Eip55Result.validNoChecksum);
    });

    test('accepts all-uppercase (no checksum claim)', () {
      const addr = '0x449ABCEF4E29A7DD8D98DB451AF2C463561BAF2E';
      expect(Eip55.validate(addr), Eip55Result.validNoChecksum);
    });

    test('rejects malformed inputs', () {
      expect(Eip55.validate(''), Eip55Result.invalidFormat);
      expect(Eip55.validate('0x'), Eip55Result.invalidFormat);
      expect(Eip55.validate('449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e'), Eip55Result.invalidFormat);
      expect(Eip55.validate('0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2'), Eip55Result.invalidFormat);
      expect(Eip55.validate('0xZZZaBCEf4e29a7Dd8d98dB451AF2c463561BAf2e'), Eip55Result.invalidFormat);
    });

    test('toChecksumAddress round-trips against lowercase input', () {
      const lower = '0x449abcef4e29a7dd8d98db451af2c463561baf2e';
      const expected = '0x449aBCEf4e29a7Dd8d98dB451AF2c463561BAf2e';
      expect(Eip55.toChecksumAddress(lower), expected);
    });
  });
}
