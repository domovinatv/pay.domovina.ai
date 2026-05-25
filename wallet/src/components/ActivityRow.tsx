import { ArrowDownLeft, ArrowUpRight, ExternalLink } from 'lucide-react';
import { formatAmount, timeAgo, type ActivityItem } from '../lib/activity';
import { getLabel } from '../lib/recipients';

/**
 * Single transaction row used by both the home-screen ActivityFeed and the
 * dedicated /activity infinite-scroll list. Linked to the on-chain tx on
 * Gnosisscan so the user always has an authoritative receipt one tap away.
 */
export function ActivityRow({ item }: { item: ActivityItem }) {
  const incoming = item.direction === 'in';
  const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
  const sign = incoming ? '+' : '−';
  const amountColor = incoming ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-primary';
  const label = getLabel(item.counterparty);

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
        <span className="text-sm font-medium text-ink-primary truncate">
          {label
            ? `${incoming ? 'Od' : 'Za'} ${label}`
            : incoming
              ? 'Primljeno'
              : 'Poslano'}
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
