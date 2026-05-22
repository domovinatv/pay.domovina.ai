import { forwardRef, type HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const cardVariants = cva(
  'bg-surface-raised text-ink-primary border border-surface-border',
  {
    variants: {
      elevation: {
        flat: 'shadow-none',
        raised: 'shadow-card',
        elevated: 'shadow-elevated',
      },
      radius: {
        md: 'rounded-2xl',
        lg: 'rounded-3xl',
      },
      padding: {
        none: '',
        sm: 'p-4',
        md: 'p-5',
        lg: 'p-6',
      },
    },
    defaultVariants: {
      elevation: 'raised',
      radius: 'lg',
      padding: 'lg',
    },
  },
);

export type CardProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof cardVariants>;

export const Card = forwardRef<HTMLDivElement, CardProps>(
  ({ className, elevation, radius, padding, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(cardVariants({ elevation, radius, padding }), className)}
      {...props}
    />
  ),
);
Card.displayName = 'Card';

export type SectionProps = HTMLAttributes<HTMLElement> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
};

export const Section = forwardRef<HTMLElement, SectionProps>(
  ({ className, title, description, action, children, ...props }, ref) => (
    <section ref={ref} className={cn('flex flex-col gap-3', className)} {...props}>
      {(title || action) && (
        <div className="flex items-end justify-between gap-2 px-1">
          <div className="flex flex-col gap-0.5">
            {title && (
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
                {title}
              </h2>
            )}
            {description && (
              <p className="text-sm text-ink-secondary">{description}</p>
            )}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  ),
);
Section.displayName = 'Section';
