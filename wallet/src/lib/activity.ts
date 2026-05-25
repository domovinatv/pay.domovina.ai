import { formatUnits, parseAbiItem, type Address, type Log } from 'viem';
import { publicClient } from './safe';
import { EURE_ADDRESS, EURE_DECIMALS } from './constants';

export type ActivityItem = {
  txHash: `0x${string}`;
  direction: 'in' | 'out';
  counterparty: Address;
  amount: string;        // pre-formatted decimal, e.g. "1.5"
  blockNumber: bigint;
  timestamp: number;     // unix seconds; 0 when unknown
};

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

// Gnosis Chain produces ~17 blocks/min (~5s/block). 200k blocks ≈ 8.2 days,
// which is a sane page size for the dedicated /activity infinite-scroll view
// AND the home-screen recency window.
export const ACTIVITY_PAGE_BLOCK_RANGE = 200_000n;

type TransferLog = Log<bigint, number, false, typeof TRANSFER_EVENT, true>;

/**
 * Fetch all EURe transfers touching `safeAddress` within an explicit block
 * range, with timestamps resolved. Sorted blockNumber desc. The caller can
 * stitch pages by walking the range cursor downward — see the /activity
 * route for the infinite-scroll wiring.
 *
 * Two indexed-topic queries (one for `from = safe`, one for `to = safe`);
 * the second is filtered for self-transfers so the merged list never
 * double-counts them.
 */
export async function fetchActivityRange(
  safeAddress: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<ActivityItem[]> {
  if (fromBlock > toBlock) return [];

  const [outgoing, incoming] = await Promise.all([
    publicClient.getLogs({
      address: EURE_ADDRESS,
      event: TRANSFER_EVENT,
      args: { from: safeAddress },
      fromBlock,
      toBlock,
    }) as Promise<TransferLog[]>,
    publicClient.getLogs({
      address: EURE_ADDRESS,
      event: TRANSFER_EVENT,
      args: { to: safeAddress },
      fromBlock,
      toBlock,
    }) as Promise<TransferLog[]>,
  ]);

  const merged: ActivityItem[] = [];
  for (const log of outgoing) {
    if (!log.args.to || log.args.value === undefined) continue;
    merged.push({
      txHash: log.transactionHash!,
      direction: 'out',
      counterparty: log.args.to,
      amount: formatUnits(log.args.value, EURE_DECIMALS),
      blockNumber: log.blockNumber!,
      timestamp: 0,
    });
  }
  for (const log of incoming) {
    if (!log.args.from || log.args.value === undefined) continue;
    // Skip self-transfers — would appear twice across the two queries.
    if (log.args.from.toLowerCase() === safeAddress.toLowerCase()) continue;
    merged.push({
      txHash: log.transactionHash!,
      direction: 'in',
      counterparty: log.args.from,
      amount: formatUnits(log.args.value, EURE_DECIMALS),
      blockNumber: log.blockNumber!,
      timestamp: 0,
    });
  }

  merged.sort((a, b) => Number(b.blockNumber - a.blockNumber));

  // Resolve block timestamps for the whole batch — one RPC call per unique
  // block. Bounded cost: dense activity in a 200k window typically maps to
  // at most a few dozen unique blocks.
  const uniqueBlocks = Array.from(new Set(merged.map((i) => i.blockNumber)));
  const blockTimestamps = new Map<bigint, number>();
  await Promise.all(
    uniqueBlocks.map(async (bn) => {
      try {
        const block = await publicClient.getBlock({ blockNumber: bn });
        blockTimestamps.set(bn, Number(block.timestamp));
      } catch {
        /* ignore — row will render without time */
      }
    }),
  );
  for (const item of merged) {
    item.timestamp = blockTimestamps.get(item.blockNumber) ?? 0;
  }

  return merged;
}

/**
 * Recent-activity convenience wrapper used by the home-screen ActivityFeed.
 * Always looks at just the latest page-sized window and trims to `limit`.
 */
export async function fetchActivity(safeAddress: Address, limit = 20): Promise<ActivityItem[]> {
  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest > ACTIVITY_PAGE_BLOCK_RANGE ? latest - ACTIVITY_PAGE_BLOCK_RANGE : 0n;
  const items = await fetchActivityRange(safeAddress, fromBlock, latest);
  return items.slice(0, limit);
}

export function formatAmount(decimalStr: string): string {
  const n = Number(decimalStr);
  if (!isFinite(n)) return decimalStr;
  // Up to 2 fractional digits, hr-locale formatting for thousands grouping.
  return n.toLocaleString('hr-HR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 0.01 ? 6 : 2,
  });
}

export function timeAgo(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!unixSeconds) return '';
  const deltaSec = Math.max(0, Math.floor(nowMs / 1000) - unixSeconds);
  if (deltaSec < 60) return 'sad';
  if (deltaSec < 3600) return `prije ${Math.floor(deltaSec / 60)} min`;
  if (deltaSec < 86400) return `prije ${Math.floor(deltaSec / 3600)} h`;
  if (deltaSec < 7 * 86400) return `prije ${Math.floor(deltaSec / 86400)} d`;
  // Beyond a week show a fixed date.
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/** Same input as timeAgo but always returns a date label, never relative.
 * Used in the /activity day-grouping headers. */
export function dayLabel(unixSeconds: number, nowMs: number = Date.now()): string {
  if (!unixSeconds) return 'Nepoznat datum';
  const d = new Date(unixSeconds * 1000);
  const now = new Date(nowMs);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, now)) return 'Danas';
  const yesterday = new Date(nowMs - 86_400_000);
  if (sameDay(d, yesterday)) return 'Jučer';
  return d.toLocaleDateString('hr-HR', {
    day: 'numeric',
    month: 'long',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}
