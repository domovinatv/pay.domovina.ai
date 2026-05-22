import type { ReactNode } from 'react';
import { cn } from './cn';

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
};

export type SegmentedControlProps<T extends string> = {
  value: T;
  onChange: (next: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  ariaLabel: string;
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-grid w-full p-1 gap-1 rounded-2xl bg-surface-sunken border border-surface-border',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition',
              'active:scale-[0.97]',
              selected
                ? 'bg-surface-raised text-ink-primary shadow-card'
                : 'text-ink-secondary hover:text-ink-primary',
            )}
          >
            {opt.icon && (
              <span className="[&_svg]:h-4 [&_svg]:w-4 shrink-0">{opt.icon}</span>
            )}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
