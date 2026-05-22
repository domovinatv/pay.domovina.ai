import { bytesToHex, encodeAbiParameters, concatHex, padHex, toHex, size, type Address, type Hex } from 'viem';

// P-256 curve order. Used for low-s normalization — WebAuthn/Apple/Android
// authenticators may emit signatures with s > n/2, which most EVM verifiers
// (including the one inside SafeWebAuthnSignerSingleton) reject as malleable.
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_HALF_N = P256_N / 2n;

/**
 * Parse a DER-encoded ECDSA P-256 signature into its (r, s) components,
 * applying low-s normalization so the Safe verifier accepts it.
 */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error('Invalid DER: missing SEQUENCE tag');
  let i = 2; // skip SEQUENCE tag + total length byte
  // Some authenticators emit 0x81-length form for total length; tolerate.
  if (der[1] === 0x81) i = 3;

  if (der[i] !== 0x02) throw new Error('Invalid DER: expected INTEGER for r');
  const rLen = der[i + 1];
  const rBytes = der.slice(i + 2, i + 2 + rLen);
  i += 2 + rLen;

  if (der[i] !== 0x02) throw new Error('Invalid DER: expected INTEGER for s');
  const sLen = der[i + 1];
  const sBytes = der.slice(i + 2, i + 2 + sLen);

  let r = bytesToBigInt(rBytes);
  let s = bytesToBigInt(sBytes);
  if (s > P256_HALF_N) s = P256_N - s;
  return { r, s };
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

/**
 * The Safe singleton reconstructs the verified clientDataJSON as:
 *   {"type":"webauthn.get","challenge":"<b64url challenge>",<fields>}
 *
 * We strip the leading `{"type":"webauthn.get","challenge":"…",` prefix and
 * trailing `}` from the browser-emitted clientDataJSON. The remainder must be
 * literal — keys, separators, escaping all preserved byte-for-byte — or the
 * keccak256 reconstruction inside the contract won't match clientDataHash.
 */
export function extractClientDataFields(clientDataJSON: Uint8Array): string {
  const text = new TextDecoder().decode(clientDataJSON);
  const match = text.match(/^\{"type":"webauthn\.get","challenge":"[A-Za-z0-9_\-]+",(.+)\}$/);
  if (!match) {
    throw new Error(
      'Unexpected clientDataJSON layout — browser may have used non-canonical key ordering. ' +
        'Got: ' + text.slice(0, 200),
    );
  }
  return match[1];
}

/**
 * Build the signature blob that SafeWebAuthnSignerSingleton.isValidSignature
 * expects: ABI-encoded (bytes authenticatorData, string clientDataFields, uint256[2] rs).
 */
export function encodeWebAuthnSignerSignature(args: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  derSignature: Uint8Array;
}): Hex {
  const { r, s } = parseDerSignature(args.derSignature);
  const clientDataFields = extractClientDataFields(args.clientDataJSON);
  return encodeAbiParameters(
    [
      { type: 'bytes', name: 'authenticatorData' },
      { type: 'string', name: 'clientDataFields' },
      { type: 'uint256[2]', name: 'rs' },
    ],
    [bytesToHex(args.authenticatorData), clientDataFields, [r, s]],
  );
}

/**
 * Wrap an ERC-1271 contract-signer signature into the full `signatures` blob
 * that Safe.execTransaction expects when the owner is a contract.
 *
 * Layout (for a single contract owner):
 *   [0..65)    65-byte "static slot":
 *     [0..32)  signer address, left-padded to 32 bytes
 *     [32..64) dynamic data offset (= 65)
 *     [64]     0x00 (signature type marker for contract signature)
 *   [65..97)   uint256 length of contract signature bytes
 *   [97..)     contract signature bytes (the ABI-encoded WebAuthn signature)
 */
export function encodeSafeContractSignature(
  signerAddress: Address,
  contractSignature: Hex,
): Hex {
  const signerSlot = padHex(signerAddress, { size: 32 });
  const dynamicOffset = padHex(toHex(65), { size: 32 });
  const sigTypeMarker: Hex = '0x00';
  const staticSlot = concatHex([signerSlot, dynamicOffset, sigTypeMarker]);

  const contractSigLen = padHex(toHex(size(contractSignature)), { size: 32 });
  return concatHex([staticSlot, contractSigLen, contractSignature]);
}
