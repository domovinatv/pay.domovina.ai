// EIP-55 mixed-case checksum encoding for Ethereum addresses.
//
// Used to defend against typos in the MPT routing target: when a user
// pastes a mixed-case address from MetaMask / Rabby / Etherscan, every
// non-zero hex digit's case is determined by the keccak-256 hash of the
// lowercase address. A single-character typo almost always flips at least
// one case bit, making the input fail the checksum.
//
// Ref: https://eips.ethereum.org/EIPS/eip-55
import 'dart:convert' show ascii;
import 'dart:typed_data';

import 'package:pointycastle/digests/keccak.dart';

class Eip55 {
  /// Validates a 0x-prefixed 42-char address. Returns `valid` if the input
  /// is well-formed and either:
  ///   - has no case-signal (all lowercase or all uppercase hex), OR
  ///   - has mixed case AND matches the EIP-55 checksum encoding.
  /// Returns specific failure reason otherwise.
  static Eip55Result validate(String input) {
    if (!RegExp(r'^0x[0-9a-fA-F]{40}$').hasMatch(input)) {
      return Eip55Result.invalidFormat;
    }
    final body = input.substring(2);
    final hasUpper = body.contains(RegExp(r'[A-F]'));
    final hasLower = body.contains(RegExp(r'[a-f]'));
    if (!hasUpper || !hasLower) {
      // No checksum claimed (all lowercase or all uppercase) — accept.
      return Eip55Result.validNoChecksum;
    }
    return toChecksumAddress(input) == input
        ? Eip55Result.validChecksum
        : Eip55Result.badChecksum;
  }

  /// Encodes the address per EIP-55. Input may be any-case 0x-prefixed.
  /// Output is lowercase prefix + checksum-cased body.
  static String toChecksumAddress(String input) {
    final lower = input.toLowerCase();
    final body = lower.substring(2);
    final hashHex = _keccak256HexOf(body);
    final out = StringBuffer('0x');
    for (var i = 0; i < 40; i++) {
      final c = body[i];
      if (RegExp(r'[0-9]').hasMatch(c)) {
        out.write(c);
      } else {
        final nibble = int.parse(hashHex[i], radix: 16);
        out.write(nibble >= 8 ? c.toUpperCase() : c);
      }
    }
    return out.toString();
  }

  static String _keccak256HexOf(String s) {
    final bytes = Uint8List.fromList(ascii.encode(s));
    final out = KeccakDigest(256).process(bytes);
    final sb = StringBuffer();
    for (final b in out) {
      sb.write(b.toRadixString(16).padLeft(2, '0'));
    }
    return sb.toString();
  }
}

enum Eip55Result {
  /// Address is well-formed AND case matches EIP-55 checksum.
  validChecksum,

  /// Address is well-formed but case carries no checksum claim (all
  /// lower or all upper). Acceptable but provides no typo protection.
  validNoChecksum,

  /// Address looks well-formed but mixed-case doesn't match EIP-55.
  /// Almost always a typo or copy-paste corruption.
  badChecksum,

  /// Doesn't even pass the 0x + 40 hex regex.
  invalidFormat,
}
