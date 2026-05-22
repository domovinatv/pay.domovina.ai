import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 font-semibold whitespace-nowrap select-none ' +
    'transition-[transform,background-color,border-color,color,box-shadow] duration-150 ease-spring ' +
    'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-brand-navy-700 text-white shadow-card hover:bg-brand-navy-600 ' +
          'dark:bg-brand-navy-400 dark:text-brand-navy-900 dark:hover:bg-brand-navy-300',
        secondary:
          'bg-surface-raised text-ink-primary border border-surface-border ' +
          'hover:bg-surface-sunken',
        ghost:
          'bg-transparent text-ink-secondary hover:bg-surface-sunken hover:text-ink-primary',
        danger:
          'bg-brand-red-500 text-white shadow-card hover:bg-brand-red-700',
      },
      size: {
        sm: 'h-9 px-3 text-sm rounded-xl',
        md: 'h-11 px-4 text-base rounded-2xl',
        lg: 'h-13 px-5 text-base rounded-2xl',
        xl: 'h-16 px-6 text-lg rounded-2xl',
      },
      block: {
        true: 'w-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'lg',
      block: false,
    },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, block, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

const iconButtonVariants = cva(
  'inline-flex items-center justify-center select-none transition ' +
    'active:scale-[0.93] disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        solid: 'bg-brand-navy-700 text-white hover:bg-brand-navy-600',
        soft: 'bg-surface-sunken text-ink-primary hover:bg-surface-muted',
        ghost: 'bg-transparent text-ink-secondary hover:bg-surface-sunken hover:text-ink-primary',
      },
      size: {
        sm: 'h-8 w-8 rounded-xl [&_svg]:h-4 [&_svg]:w-4',
        md: 'h-10 w-10 rounded-2xl [&_svg]:h-5 [&_svg]:w-5',
        lg: 'h-12 w-12 rounded-2xl [&_svg]:h-6 [&_svg]:w-6',
      },
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'md',
    },
  },
);

export type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof iconButtonVariants> & {
    'aria-label': string;
  };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
IconButton.displayName = 'IconButton';
