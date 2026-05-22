import * as ToastPrimitive from '@radix-ui/react-toast';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { cn } from './cn';

type ToastVariant = 'success' | 'error' | 'info';

type ToastItem = {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
};

type ToastContextValue = {
  toast: (input: { title: string; description?: string; variant?: ToastVariant }) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastContextValue['toast']>(({ title, description, variant = 'info' }) => {
    setItems((prev) => [...prev, { id: Date.now() + Math.random(), title, description, variant }]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="down" duration={4000}>
        {children}
        {items.map((item) => (
          <ToastPrimitive.Root
            key={item.id}
            onOpenChange={(open) => {
              if (!open) setItems((prev) => prev.filter((i) => i.id !== item.id));
            }}
            className={cn(
              'pointer-events-auto flex items-start gap-3 rounded-2xl bg-surface-raised border border-surface-border shadow-elevated p-4',
              'data-[state=open]:animate-slide-up data-[state=closed]:animate-fade-in',
              'data-[swipe=move]:translate-y-[var(--radix-toast-swipe-move-y)]',
              'data-[swipe=cancel]:translate-y-0 data-[swipe=cancel]:transition-transform',
              'data-[swipe=end]:translate-y-[var(--radix-toast-swipe-end-y)] data-[swipe=end]:transition-transform',
            )}
          >
            <ToastIcon variant={item.variant} />
            <div className="flex-1 min-w-0">
              <ToastPrimitive.Title className="text-sm font-semibold text-ink-primary">
                {item.title}
              </ToastPrimitive.Title>
              {item.description && (
                <ToastPrimitive.Description className="text-sm text-ink-secondary">
                  {item.description}
                </ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="Zatvori"
              className="text-ink-muted hover:text-ink-primary transition"
            >
              <X className="h-4 w-4" />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport
          className="fixed bottom-0 left-0 right-0 z-[60] flex flex-col gap-2 p-4 outline-none
                     sm:left-auto sm:right-4 sm:bottom-4 sm:max-w-sm"
        />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

function ToastIcon({ variant }: { variant: ToastVariant }) {
  const className = 'h-5 w-5 shrink-0 mt-0.5';
  if (variant === 'success') return <CheckCircle2 className={cn(className, 'text-emerald-500')} />;
  if (variant === 'error') return <AlertCircle className={cn(className, 'text-brand-red-500')} />;
  return <Info className={cn(className, 'text-brand-navy-500')} />;
}
