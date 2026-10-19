import { concat, getAddress, hexToBytes, isAddress, keccak256, toBytes, type Hex } from 'viem';

/// Receipt-bound session ids (ADR 0022 §1).
///
///   digest = keccak256("MPT-RECEIPT-v1" ‖ owner(20 B) ‖ salt(16 B))
///   sid    = "r1" ‖ base32(digest)[0:24]          // 26 chars, 120 bits
///
/// The payer's device derives the sid from an owner it controls BEFORE paying
/// and writes it into its own bank transfer. Nobody else (MPT, the merchant)
/// can later swap the owner: the sid already commits to it.
///
/// Isomorphic: the Worker and the browser bundle (receipts/client) share this
/// file, so both sides derive byte-identical sids.

/// ⚠️ COPIES — change together, with their golden values: scripts/mpt_receipt_verify.py
/// (+ tools/receipt-checkpoints/), energy.domovina.ai lib/receipt-sid.ts and its
/// browser verifier /beta/provjera/ (lib + tests compare against this file).
export const RECEIPT_SID_PREFIX = 'r1';
export const RECEIPT_DOMAIN = 'MPT-RECEIPT-v1';
/// Same confusable-free alphabet as generateSid() (intents/sid.ts): lowercase
/// only, so a bank that upper-cases the remittance is undone by lower-casing.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const BODY_CHARS = 24;
const SALT_RE = /^0x[0-9a-fA-F]{32}$/;
const RECEIPT_SID_RE = new RegExp(`^${RECEIPT_SID_PREFIX}[${ALPHABET}]{${BODY_CHARS}}$`);

export function isReceiptSid(sid: string | null | undefined): sid is string {
  return typeof sid === 'string' && RECEIPT_SID_RE.test(sid);
}

export function isReceiptSalt(salt: string): salt is Hex {
  return SALT_RE.test(salt);
}

/// 5 bits per char, MSB first, from the start of the digest.
function base32Prefix(bytes: Uint8Array, chars: number): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
    if (out.length === chars) break;
  }
  return out;
}

export function receiptDigest(owner: string, salt: Hex): Hex {
  if (!isAddress(owner, { strict: false })) throw new Error('invalid_owner');
  if (!isReceiptSalt(salt)) throw new Error('invalid_salt');
  // All three as BYTES (14 + 20 + 16 = 50). viem's concat must never get a mix
  // of Uint8Array and hex strings: it then copies the hex string char by char
  // and every a–f becomes 0 (caught by scripts/mpt_receipt_verify.py, ADR 0023).
  return keccak256(concat([toBytes(RECEIPT_DOMAIN), hexToBytes(getAddress(owner)), hexToBytes(salt)]));
}

export function deriveReceiptSid(owner: string, salt: Hex): string {
  return RECEIPT_SID_PREFIX + base32Prefix(toBytes(receiptDigest(owner, salt)), BODY_CHARS);
}

/// True iff (owner, salt) is the commitment `sid` carries. Never throws.
export function receiptSidMatches(sid: string, owner: string, salt: string): boolean {
  if (!isReceiptSid(sid) || !isReceiptSalt(salt)) return false;
  try {
    return deriveReceiptSid(owner, salt) === sid;
  } catch {
    return false;
  }
}

/// `kind` written into the forward's PaymentRegistry event (ADR 0022 §3).
/// `via` is how the forward found its intent: null = the sid came in the
/// payer's own remittance; 'code' | 'auto' | 'manual' = short code (ADR 0028,
/// no receipt: anyone who knows the code can type it) / stray resolver / operator
/// (amount + time is not proof of who paid). Non-receipt sids keep the
/// registry default ('payment').
export function receiptKind(
  sid: string | null | undefined,
  via: 'code' | 'auto' | 'manual' | null,
): 'rcpt1' | 'rcpt1-unbound' | undefined {
  if (!isReceiptSid(sid)) return undefined;
  return via === null ? 'rcpt1' : 'rcpt1-unbound';
}
