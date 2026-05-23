import { useEffect, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, RefreshCw } from 'lucide-react';
import { cn } from './cn';
import { Skeleton } from './Feedback';

export type BalanceDisplayProps = {
  /** Raw numeric balance. null while loading. */
  amount?: number | null;
  /** Currency suffix shown next to the number (e.g. "EURe"). */
  currency?: string;
  /** Section caption above the number (default "Balance"). */
  label?: string;
  /** Human relative timestamp shown below (e.g. "prije 3 s"). */
  lastUpdatedAgo?: string | null;
  /** Spinner state while the next poll is in flight. */
  refreshing?: boolean;
  /** Locale used to format the number. Default hr-HR (1 234,56). */
  locale?: string;
  /** Tween duration in ms when the amount changes. 0 disables animation. */
  animateMs?: number;
  className?: string;
};

export function BalanceDisplay({
  amount,
  currency = 'EURe',
  label = 'Balance',
  lastUpdatedAgo,
  refreshing,
  locale = 'hr-HR',
  animateMs = 800,
  className,
}: BalanceDisplayProps) {
  const loading = amount === null || amount === undefined;
  const shown = useAnimatedNumber(loading ? 0 : amount, animateMs);
  const delta = useBalanceDelta(loading ? null : amount);
  const formatter = formatterFor(locale);

  return (
    <div className={cn('flex flex-col items-center gap-2 text-center', className)}>
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-14 w-48" />
      ) : (
        <div className="flex items-baseline gap-2">
          <span
            // key bound to the integer part so a whole-unit roll re-mounts and
            // the underlying animation feels punchier. Sub-unit tweens stay
            // smooth on the same DOM node.
            className="text-6xl font-semibold tabular tracking-tight text-ink-primary leading-none transition-colors duration-300"
          >
            {formatter.format(shown)}
          </span>
          <span className="text-lg font-medium text-ink-muted tabular">{currency}</span>
        </div>
      )}

      {/* Delta pill — appears briefly when the balance changes, then fades. */}
      <div className="h-5 mt-1">
        {delta && (
          <span
            key={delta.id}
            className={cn(
              'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-semibold tabular animate-fade-in',
              delta.direction === 'in'
                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
                : 'bg-brand-red-50 text-brand-red-700 dark:bg-brand-red-700/15 dark:text-brand-red-300',
            )}
            aria-live="polite"
          >
            {delta.direction === 'in' ? (
              <ArrowDownLeft className="h-3 w-3" />
            ) : (
              <ArrowUpRight className="h-3 w-3" />
            )}
            {delta.direction === 'in' ? '+' : '−'}
            {formatter.format(Math.abs(delta.value))} {currency}
          </span>
        )}
      </div>

      {(lastUpdatedAgo || refreshing) && (
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          {refreshing ? 'osvježavam…' : lastUpdatedAgo}
        </span>
      )}
    </div>
  );
}

// ───────── Animation hooks ─────────

function useAnimatedNumber(target: number, durationMs: number): number {
  const [shown, setShown] = useState(target);
  // start = current shown value when a new target lands; target = where we are tweening to
  const stateRef = useRef({ start: target, target, t0: 0, raf: 0 });

  useEffect(() => {
    // No tween: snap.
    if (durationMs === 0) {
      setShown(target);
      stateRef.current.target = target;
      return;
    }
    // Same target — nothing to do.
    if (stateRef.current.target === target) return;

    stateRef.current.start = shown;
    stateRef.current.target = target;
    stateRef.current.t0 = performance.now();

    if (stateRef.current.raf) cancelAnimationFrame(stateRef.current.raf);

    function tick(now: number) {
      const elapsed = now - stateRef.current.t0;
      const progress = Math.min(1, elapsed / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3); // cubic-out
      const value =
        stateRef.current.start +
        (stateRef.current.target - stateRef.current.start) * eased;
      setShown(value);
      if (progress < 1) {
        stateRef.current.raf = requestAnimationFrame(tick);
      }
    }
    stateRef.current.raf = requestAnimationFrame(tick);
    return () => {
      if (stateRef.current.raf) cancelAnimationFrame(stateRef.current.raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return shown;
}

type DeltaState = {
  id: number;            // monotonic so React can key off it for re-mount + re-animate
  value: number;         // signed delta
  direction: 'in' | 'out';
};

function useBalanceDelta(target: number | null): DeltaState | null {
  const prevRef = useRef<number | null>(null);
  const [delta, setDelta] = useState<DeltaState | null>(null);

  useEffect(() => {
    if (target === null) return;
    const prev = prevRef.current;
    prevRef.current = target;
    if (prev === null) return; // first observation — no delta to show
    const diff = target - prev;
    // 1e-4 dampens floating-point jitter from balance polls that come back
    // with sub-cent rounding differences.
    if (Math.abs(diff) < 0.0001) return;

    setDelta({
      id: Date.now(),
      value: diff,
      direction: diff > 0 ? 'in' : 'out',
    });
    const id = setTimeout(() => setDelta(null), 4000);
    return () => clearTimeout(id);
  }, [target]);

  return delta;
}

// Cached Intl formatters keyed by locale — Intl construction is non-trivial.
const formatterCache = new Map<string, Intl.NumberFormat>();
function formatterFor(locale: string): Intl.NumberFormat {
  const cached = formatterCache.get(locale);
  if (cached) return cached;
  const fresh = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  formatterCache.set(locale, fresh);
  return fresh;
}
