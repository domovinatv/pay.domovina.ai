import { Copy, Check } from 'lucide-react';
import { useState, type HTMLAttributes } from 'react';
import { cn } from './cn';
import { haptic } from '../lib/haptic';

export type AddressChipProps = HTMLAttributes<HTMLButtonElement> & {
  address: string;
  label?: string;
  truncate?: boolean;
};

function shorten(addr: string): string {
  if (!addr.startsWith('0x') || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Tiny deterministic gradient avatar derived from the address — premium feel without an external blockie lib.
function gradientFor(addr: string): string {
  const seed = addr.toLowerCase();
  const h1 = parseInt(seed.slice(2, 6) || '0', 16) % 360;
  const h2 = (h1 + 60 + (parseInt(seed.slice(6, 8) || '0', 16) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}

export function AddressChip({
  address,
  label,
  truncate = true,
  className,
  ...props
}: AddressChipProps) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      haptic('tap');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may not be available — silent */
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      className={cn(
        'group inline-flex items-center gap-2 rounded-pill bg-surface-sunken hover:bg-surface-muted',
        'pl-1.5 pr-3 py-1.5 transition-colors',
        className,
      )}
      aria-label={`Kopiraj adresu ${address}`}
      {...props}
    >
      <span
        aria-hidden
        className="h-6 w-6 rounded-full shrink-0 ring-1 ring-black/5"
        style={{ background: gradientFor(address) }}
      />
      <span className="flex flex-col items-start min-w-0 leading-tight">
        {label && (
          <span className="text-[11px] text-ink-muted truncate max-w-[140px]">{label}</span>
        )}
        <span className="text-sm font-medium text-ink-primary tabular">
          {truncate ? shorten(address) : address}
        </span>
      </span>
      <span className="text-ink-muted group-hover:text-ink-primary transition-colors">
        {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
      </span>
    </button>
  );
}
