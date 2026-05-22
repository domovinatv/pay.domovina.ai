// Lightweight haptic helper. Wraps navigator.vibrate where available
// (Android Chrome, some PWA contexts). iOS Safari ignores vibrate; that's
// fine — calls are silent no-ops there and we don't pretend otherwise.
// All durations are in ms.

type HapticIntent = 'tap' | 'success' | 'warning' | 'error';

const PATTERNS: Record<HapticIntent, number | number[]> = {
  tap: 10,
  success: [10, 30, 10],
  warning: [20, 30],
  error: [30, 60, 30],
};

let armed = true;

export function haptic(intent: HapticIntent = 'tap'): void {
  if (!armed) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  // Honor system "reduce motion" preference — users who turn off animations
  // tend to also dislike physical feedback.
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return;
  }
  try {
    navigator.vibrate(PATTERNS[intent]);
  } catch {
    // Some browsers throw on cross-origin iframes or restricted contexts.
    armed = false;
  }
}
