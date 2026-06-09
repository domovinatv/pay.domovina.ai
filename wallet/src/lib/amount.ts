// User-input → number normalization for amount fields.
//
// iOS shows the decimal keypad with the locale's separator (comma in hr),
// but viem's parseUnits expects "1.5" form and chokes on leading zeros.
// This helper bridges the gap: accept either separator, strip leading
// zeros, validate, return both a normalized parseUnits-ready string and
// a numeric value for comparisons.

export type AmountParse =
  | { ok: true; normalized: string; numeric: number }
  | { ok: false; reason: 'empty' | 'invalid' | 'zero' | 'decimals' };

// EURe has 18 decimals; more than that would make parseUnits throw downstream.
const DEFAULT_MAX_DECIMALS = 18;

export function parseAmount(raw: string, maxDecimals = DEFAULT_MAX_DECIMALS): AmountParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  // Normalize comma → dot. Reject if more than one separator was used.
  const dotted = trimmed.replace(/,/g, '.');
  if ((dotted.match(/\./g) ?? []).length > 1) return { ok: false, reason: 'invalid' };

  // Strip leading zeros (but keep a leading 0 before a decimal point).
  let cleaned = dotted.replace(/^0+(?=\d)/, '');
  if (cleaned.startsWith('.')) cleaned = '0' + cleaned;
  if (cleaned === '' || cleaned === '.') return { ok: false, reason: 'invalid' };

  // Must be: digits, optional dot + digits.
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { ok: false, reason: 'invalid' };

  // Bound fractional digits so parseUnits(normalized, 18) downstream can't throw
  // a raw viem error the UI then leaks.
  const frac = cleaned.split('.')[1];
  if (frac && frac.length > maxDecimals) return { ok: false, reason: 'decimals' };

  const numeric = Number(cleaned);
  if (!isFinite(numeric)) return { ok: false, reason: 'invalid' };
  if (numeric <= 0) return { ok: false, reason: 'zero' };

  return { ok: true, normalized: cleaned, numeric };
}

// True for inputs that are obviously broken so we can paint the error inline
// without bothering the user mid-typing. Empty input is NOT considered
// invalid (placeholder still showing).
export function isAmountInvalidForDisplay(raw: string): boolean {
  if (raw.trim().length === 0) return false;
  return !parseAmount(raw).ok;
}
