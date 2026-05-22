import { RefreshCw } from 'lucide-react';
import { cn } from './cn';
import { Skeleton } from './Feedback';

export type BalanceDisplayProps = {
  amount?: string | null;          // pre-formatted (e.g. "1 234,56"); null while loading
  currency?: string;
  label?: string;
  lastUpdatedAgo?: string | null;  // e.g. "prije 3 s"
  refreshing?: boolean;
  className?: string;
};

export function BalanceDisplay({
  amount,
  currency = 'EURe',
  label = 'Balance',
  lastUpdatedAgo,
  refreshing,
  className,
}: BalanceDisplayProps) {
  const loading = amount === null || amount === undefined;
  return (
    <div className={cn('flex flex-col items-center gap-2 text-center', className)}>
      <span className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
        {label}
      </span>
      {loading ? (
        <Skeleton className="h-14 w-48" />
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-6xl font-semibold tabular tracking-tight text-ink-primary leading-none">
            {amount}
          </span>
          <span className="text-lg font-medium text-ink-muted tabular">{currency}</span>
        </div>
      )}
      {(lastUpdatedAgo || refreshing) && (
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
          <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />
          {refreshing ? 'osvježavam…' : lastUpdatedAgo}
        </span>
      )}
    </div>
  );
}
