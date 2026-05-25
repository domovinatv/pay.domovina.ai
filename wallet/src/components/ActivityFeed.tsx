import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { Wallet as WalletIcon, AlertCircle, ChevronRight } from 'lucide-react';
import type { Address } from 'viem';
import { Card, EmptyState, Skeleton } from '../ui';
import { fetchActivity, type ActivityItem } from '../lib/activity';
import { ActivityRow } from './ActivityRow';

type Props = {
  safeAddress: Address;
  /** Re-fetch tick (eg. balance polling clock). When this changes, refetch. */
  refetchKey?: number;
};

const HOME_FEED_LIMIT = 8;

export function ActivityFeed({ safeAddress, refetchKey = 0 }: Props) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setLocation] = useLocation();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchActivity(safeAddress, HOME_FEED_LIMIT)
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
    <div className="flex flex-col gap-2">
      <Card padding="sm" className="flex flex-col divide-y divide-surface-border">
        {items.map((item) => (
          <ActivityRow key={`${item.txHash}-${item.direction}`} item={item} />
        ))}
      </Card>
      <button
        type="button"
        onClick={() => setLocation('/activity')}
        className="self-stretch text-sm text-ink-secondary hover:text-ink-primary transition flex items-center justify-center gap-1 py-2 rounded-2xl hover:bg-surface-sunken"
      >
        Pokaži sve transakcije
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
