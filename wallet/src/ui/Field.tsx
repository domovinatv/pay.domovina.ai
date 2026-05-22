import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export type FieldProps = {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
};

export function Field({ label, hint, error, optional, children, className }: FieldProps) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <label htmlFor={id} className="text-sm font-medium text-ink-secondary px-1">
          {label}
          {optional && <span className="ml-1 text-ink-muted font-normal">(neobavezno)</span>}
        </label>
      )}
      {children(id)}
      {error ? (
        <p className="text-sm text-brand-red-700 px-1" role="alert">{error}</p>
      ) : hint ? (
        <p className="text-sm text-ink-muted px-1">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  'w-full bg-surface-sunken text-ink-primary border border-surface-border rounded-2xl ' +
  'px-4 py-3 text-base placeholder:text-ink-muted ' +
  'transition-colors duration-150 ' +
  'focus:bg-surface-raised focus:border-brand-navy-400 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        inputBase,
        invalid && 'border-brand-red-500 focus:border-brand-red-500',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export type AmountInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'inputMode'> & {
  currency?: string;
  invalid?: boolean;
};

export const AmountInput = forwardRef<HTMLInputElement, AmountInputProps>(
  ({ className, currency = 'EURe', invalid, ...props }, ref) => (
    <div
      className={cn(
        'relative flex items-baseline justify-center gap-2 rounded-3xl bg-surface-sunken border border-surface-border py-6 px-4',
        'focus-within:bg-surface-raised focus-within:border-brand-navy-400',
        invalid && 'border-brand-red-500 focus-within:border-brand-red-500',
        className,
      )}
    >
      <input
        ref={ref}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={cn(
          'flex-1 min-w-0 bg-transparent text-center text-5xl font-semibold tabular text-ink-primary',
          'placeholder:text-ink-muted/60 focus:outline-none',
        )}
        placeholder="0,00"
        {...props}
      />
      <span className="text-base font-medium text-ink-muted tabular">{currency}</span>
    </div>
  ),
);
AmountInput.displayName = 'AmountInput';

export type AddressInputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  trailing?: ReactNode;
};

export const AddressInput = forwardRef<HTMLInputElement, AddressInputProps>(
  ({ className, invalid, trailing, ...props }, ref) => (
    <div
      className={cn(
        'flex items-center gap-2 bg-surface-sunken border border-surface-border rounded-2xl pr-2',
        'focus-within:bg-surface-raised focus-within:border-brand-navy-400',
        invalid && 'border-brand-red-500 focus-within:border-brand-red-500',
        className,
      )}
    >
      <input
        ref={ref}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="0x…"
        className="flex-1 min-w-0 bg-transparent px-4 py-3 font-mono text-sm text-ink-primary placeholder:text-ink-muted focus:outline-none"
        {...props}
      />
      {trailing}
    </div>
  ),
);
AddressInput.displayName = 'AddressInput';
