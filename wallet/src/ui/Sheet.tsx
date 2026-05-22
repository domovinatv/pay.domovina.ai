import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { IconButton } from './Button';

export type SheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  side?: 'bottom' | 'right';
};

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  side = 'bottom',
}: SheetProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm animate-fade-in"
        />
        <Dialog.Content
          className={cn(
            'fixed z-50 flex flex-col bg-surface-raised text-ink-primary shadow-elevated',
            // Mobile: bottom sheet, full width
            side === 'bottom' &&
              'left-0 right-0 bottom-0 rounded-t-3xl max-h-[92dvh] animate-slide-up ' +
                // Desktop: centered card
                'sm:left-1/2 sm:bottom-auto sm:top-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 ' +
                'sm:max-w-md sm:w-full sm:rounded-3xl',
            side === 'right' &&
              'right-0 top-0 bottom-0 w-full sm:max-w-md sm:rounded-l-3xl animate-slide-up',
          )}
        >
          {/* Drag handle (mobile, decorative) */}
          {side === 'bottom' && (
            <div className="sm:hidden flex justify-center pt-2 pb-1">
              <div className="w-10 h-1 rounded-pill bg-surface-border" />
            </div>
          )}
          <header className="flex items-start justify-between gap-4 px-6 pt-4 pb-2">
            <div className="flex flex-col gap-1 min-w-0">
              {title && (
                <Dialog.Title className="text-xl font-semibold text-ink-primary">
                  {title}
                </Dialog.Title>
              )}
              {description && (
                <Dialog.Description className="text-sm text-ink-secondary">
                  {description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <IconButton aria-label="Zatvori" size="sm" variant="ghost">
                <X />
              </IconButton>
            </Dialog.Close>
          </header>
          <div className="flex-1 overflow-y-auto px-6 pb-6 pt-2">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
