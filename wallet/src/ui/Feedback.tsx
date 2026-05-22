import type { HTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        'rounded-xl bg-gradient-to-r from-surface-sunken via-surface-muted to-surface-sunken',
        'bg-[length:200%_100%] animate-shimmer',
        className,
      )}
      {...props}
    />
  );
}

export type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center gap-3 py-10 px-6', className)}>
      {icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-sunken text-ink-muted [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </div>
      )}
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-ink-primary">{title}</p>
        {description && <p className="text-sm text-ink-secondary max-w-xs">{description}</p>}
      </div>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

const pillVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-sunken text-ink-secondary',
        info: 'bg-brand-navy-50 text-brand-navy-700 dark:bg-brand-navy-900/40 dark:text-brand-navy-200',
        success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
        warning: 'bg-amber-50 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
        danger: 'bg-brand-red-50 text-brand-red-700 dark:bg-brand-red-700/20 dark:text-brand-red-300',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type StatusPillProps = HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof pillVariants> & {
    dot?: boolean;
    pulse?: boolean;
  };

export function StatusPill({ className, tone, dot, pulse, children, ...props }: StatusPillProps) {
  return (
    <span className={cn(pillVariants({ tone }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            'inline-block h-1.5 w-1.5 rounded-full bg-current',
            pulse && 'animate-pulse',
          )}
        />
      )}
      {children}
    </span>
  );
}

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof pillVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(pillVariants({ tone }), className)} {...props} />;
}
