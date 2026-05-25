import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { AlertCircle, ArrowLeft, Loader2, Wallet as WalletIcon } from 'lucide-react';
import { Card, EmptyState, Skeleton } from '../ui';
import { ActivityRow } from '../components/ActivityRow';
import { useWalletStore } from '../state/store';
import { publicClient } from '../lib/safe';
import {
  ACTIVITY_PAGE_BLOCK_RANGE,
  dayLabel,
  fetchActivityRange,
  type ActivityItem,
} from '../lib/activity';

/**
 * Full transaction history page. Walks the chain backwards in
 * ACTIVITY_PAGE_BLOCK_RANGE (200k blocks ≈ 8 days) windows, triggered by an
 * IntersectionObserver on a bottom sentinel. Each window resolves block
 * timestamps lazily, so going further back costs proportional time but
 * never blocks the first paint.
 *
 * The user reported the home-screen feed only shows "a few" — that one is
 * intentionally capped at the most recent 8 items in the latest 200k
 * blocks so the home stays fast. This route is where you go to actually
 * audit the full ledger.
 */
export function Activity() {
  const [, setLocation] = useLocation();
  const safeAddress = useWalletStore((s) => s.safeAddress);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursorBlock, setCursorBlock] = useState<bigint | null>(null);
  const [windowRange, setWindowRange] = useState<{ from: bigint; to: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Stable ref to the latest load function so the IntersectionObserver
  // effect can call it without re-subscribing on every render.
  const loadMoreRef = useRef<() => void>(() => {});

  // Initial page — most recent ACTIVITY_PAGE_BLOCK_RANGE blocks.
  useEffect(() => {
    if (!safeAddress) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const latest = await publicClient.getBlockNumber();
        const from = latest > ACTIVITY_PAGE_BLOCK_RANGE ? latest - ACTIVITY_PAGE_BLOCK_RANGE : 0n;
        const batch = await fetchActivityRange(safeAddress, from, latest);
        if (cancelled) return;
        setItems(batch);
        setWindowRange({ from, to: latest });
        if (from === 0n) {
          setDone(true);
          setCursorBlock(null);
        } else {
          setCursorBlock(from - 1n);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [safeAddress]);

  const loadMore = useCallback(async () => {
    if (!safeAddress || loading || done || error || cursorBlock === null) return;
    setLoading(true);
    try {
      const to = cursorBlock;
      const from = to > ACTIVITY_PAGE_BLOCK_RANGE ? to - ACTIVITY_PAGE_BLOCK_RANGE : 0n;
      const batch = await fetchActivityRange(safeAddress, from, to);
      setItems((prev) => [...prev, ...batch]);
      setWindowRange({ from, to });
      if (from === 0n) {
        setDone(true);
        setCursorBlock(null);
      } else {
        setCursorBlock(from - 1n);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [safeAddress, loading, done, error, cursorBlock]);

  loadMoreRef.current = loadMore;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || done || error) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) loadMoreRef.current();
      },
      { rootMargin: '300px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [done, error]);

  // Group items by day. Items already arrive sorted block desc, which
  // implies timestamp desc with the only edge case being two transactions
  // in the same block (same timestamp, OK to group together).
  const grouped = useMemo(() => {
    const groups: { day: string; rows: ActivityItem[] }[] = [];
    for (const item of items) {
      const day = dayLabel(item.timestamp);
      const last = groups[groups.length - 1];
      if (last && last.day === day) {
        last.rows.push(item);
      } else {
        groups.push({ day, rows: [item] });
      }
    }
    return groups;
  }, [items]);

  if (!safeAddress) return null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center gap-3 -ml-1">
        <button
          type="button"
          onClick={() => setLocation('/')}
          aria-label="Natrag"
          className="h-9 w-9 inline-flex items-center justify-center rounded-full text-ink-secondary hover:text-ink-primary hover:bg-surface-sunken active:scale-95 transition"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex flex-col leading-tight">
          <h1 className="text-xl font-semibold text-ink-primary">Sve transakcije</h1>
          <p className="text-xs text-ink-muted">
            EURe uplate i isplate s ovog walleta · kronološki desc
          </p>
        </div>
      </header>

      {error && (
        <Card padding="md" className="border-brand-red-500/30">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-brand-red-700 shrink-0 mt-0.5" />
            <div className="flex flex-col gap-1 min-w-0">
              <p className="text-sm font-medium text-ink-primary">Ne mogu učitati aktivnost</p>
              <p className="text-xs text-ink-secondary break-all">{error}</p>
            </div>
          </div>
        </Card>
      )}

      {!error && items.length === 0 && !loading && (
        <Card padding="none">
          <EmptyState
            icon={<WalletIcon />}
            title="Još nema transakcija"
            description="Tvoje uplate i isplate prikazat će se ovdje čim se dogode."
          />
        </Card>
      )}

      {grouped.map((group) => (
        <section key={group.day} className="flex flex-col gap-2">
          <h2 className="text-[11px] uppercase tracking-widest text-ink-muted px-1">
            {group.day}
          </h2>
          <Card padding="sm" className="flex flex-col divide-y divide-surface-border">
            {group.rows.map((item) => (
              <ActivityRow key={`${item.txHash}-${item.direction}`} item={item} />
            ))}
          </Card>
        </section>
      ))}

      {loading && (
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
      )}

      {!done && !loading && !error && cursorBlock !== null && (
        <div ref={sentinelRef} aria-hidden className="h-1" />
      )}

      {loading && items.length > 0 && (
        <p className="text-center text-xs text-ink-muted py-2 inline-flex items-center justify-center gap-1.5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Učitavam stariji period…
        </p>
      )}

      {done && items.length > 0 && (
        <p className="text-center text-xs text-ink-muted py-4">
          Kraj — sve transakcije od početka.
        </p>
      )}

      {done && items.length === 0 && (
        <p className="text-center text-xs text-ink-muted py-4">
          Pretraženo cijela povijest, nema transakcija.
        </p>
      )}

      {windowRange && !done && !loading && (
        <p className="text-center text-[10px] text-ink-muted">
          Sljedeći period: blokovi {(windowRange.from - ACTIVITY_PAGE_BLOCK_RANGE > 0n
            ? windowRange.from - ACTIVITY_PAGE_BLOCK_RANGE
            : 0n).toString()} – {(windowRange.from - 1n).toString()}
        </p>
      )}
    </div>
  );
}
