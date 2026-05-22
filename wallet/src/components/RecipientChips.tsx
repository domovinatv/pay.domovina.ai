import { Pencil } from 'lucide-react';
import type { Address } from 'viem';
import type { Recipient } from '../lib/recipients';

type Props = {
  recipients: Recipient[];
  onPick: (address: Address) => void;
  onEdit?: () => void;
};

export function RecipientChips({ recipients, onPick, onEdit }: Props) {
  if (recipients.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <p className="text-[11px] uppercase tracking-widest text-ink-muted">
          Nedavno korišteno
        </p>
        {onEdit && (
          <button
            type="button"
            onClick={onEdit}
            className="inline-flex items-center gap-1 text-[11px] uppercase tracking-widest text-ink-secondary hover:text-ink-primary transition"
          >
            <Pencil className="h-3 w-3" />
            Uredi
          </button>
        )}
      </div>
      <div className="-mx-1 px-1 flex gap-2 overflow-x-auto pb-1 snap-x">
        {recipients.map((r) => (
          <button
            key={r.address}
            type="button"
            onClick={() => onPick(r.address)}
            className="snap-start shrink-0 inline-flex items-center gap-2 rounded-pill bg-surface-sunken hover:bg-surface-muted
                       border border-surface-border pl-1.5 pr-3 py-1.5 transition active:scale-[0.97]"
          >
            <span
              aria-hidden
              className="h-6 w-6 rounded-full shrink-0 ring-1 ring-black/5"
              style={{ background: gradientFor(r.address) }}
            />
            <span className="text-sm font-medium tabular text-ink-primary">
              {r.label ?? shorten(r.address)}
            </span>
            {r.count > 1 && (
              <span className="text-[10px] font-semibold text-ink-muted">×{r.count}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function shorten(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function gradientFor(addr: string): string {
  const seed = addr.toLowerCase();
  const h1 = parseInt(seed.slice(2, 6) || '0', 16) % 360;
  const h2 = (h1 + 60 + (parseInt(seed.slice(6, 8) || '0', 16) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}
