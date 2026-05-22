import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ExternalLink, Wallet as WalletIcon, AlertCircle } from 'lucide-react';
import type { Address } from 'viem';
import { Card, EmptyState, Skeleton } from '../ui';
import { fetchActivity, formatAmount, timeAgo, type ActivityItem } from '../lib/activity';

type Props = {
  safeAddress: Address;
  /** Re-fetch tick (eg. balance polling clock). When this changes, refetch. */
  refetchKey?: number;
};

export function ActivityFeed({ safeAddress, refetchKey = 0 }: Props) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchActivity(safeAddress)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [safeAddress, refetchKey]);

  if (error) {
    return (
      <Card padding="md" className="border-brand-red-500/30">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-brand-red-700 shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1 min-w-0">
            <p className="text-sm font-medium text-ink-primary">Ne mogu učitati aktivnost</p>
            <p className="text-xs text-ink-secondary break-all">{error}</p>
          </div>
        </div>
      </Card>
    );
  }

  if (items === null) {
    return (
      <Card padding="sm" className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 py-2">
            <Skeleton className="h-10 w-10 rounded-xl" />
            <div className="flex-1 flex flex-col gap-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </Card>
    );
  }

  if (items.length === 0) {
    return (
      <Card padding="none">
        <EmptyState
          icon={<WalletIcon />}
          title="Još nema transakcija"
          description="Tvoje uplate i isplate prikazat će se ovdje čim se dogode."
        />
      </Card>
    );
  }

  return (
    <Card padding="sm" className="flex flex-col divide-y divide-surface-border">
      {items.map((item) => (
        <ActivityRow key={`${item.txHash}-${item.direction}`} item={item} />
      ))}
    </Card>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const incoming = item.direction === 'in';
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const sign = incoming ? '+' : '−';
  const amountColor = incoming ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-primary';

  return (
    <a
      href={`https://gnosisscan.io/tx/${item.txHash}`}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 py-3 first:pt-1 last:pb-1 hover:bg-surface-sunken -mx-1 px-1 rounded-lg transition group"
    >
      <div
        className={
          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ' +
          (incoming
            ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
            : 'bg-surface-sunken text-ink-secondary')
        }
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="flex flex-col leading-tight min-w-0 flex-1">
        <span className="text-sm font-medium text-ink-primary">
          {incoming ? 'Primljeno' : 'Poslano'}
        </span>
        <span className="font-mono text-[11px] text-ink-muted truncate">
          {shortAddr(item.counterparty)}
        </span>
      </div>
      <div className="flex flex-col items-end leading-tight shrink-0">
        <span className={`text-sm font-semibold tabular ${amountColor}`}>
          {sign}
          {formatAmount(item.amount)}
        </span>
        <span className="text-[11px] text-ink-muted">{timeAgo(item.timestamp)}</span>
      </div>
      <ExternalLink className="h-3.5 w-3.5 text-ink-muted shrink-0 opacity-0 group-hover:opacity-100 transition" />
    </a>
  );
}

function shortAddr(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
