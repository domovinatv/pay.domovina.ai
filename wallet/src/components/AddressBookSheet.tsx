import { useEffect, useState } from 'react';
import { Trash2, Check, X } from 'lucide-react';
import type { Address } from 'viem';
import { Sheet, Button, IconButton, Input, EmptyState } from '../ui';
import { listAllRecipients, removeRecipient, setLabel, type Recipient } from '../lib/recipients';
import { haptic } from '../lib/haptic';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange?: () => void;
};

export function AddressBookSheet({ open, onOpenChange, onChange }: Props) {
  const [items, setItems] = useState<Recipient[]>([]);

  useEffect(() => {
    if (open) setItems(listAllRecipients());
  }, [open]);

  function reload() {
    setItems(listAllRecipients());
    onChange?.();
  }

  function saveLabel(address: Address, label: string | null) {
    setLabel(address, label);
    reload();
  }

  function remove(address: Address) {
    haptic('warning');
    removeRecipient(address);
    reload();
  }

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Adresar"
      description="Daj imena adresama koje koristiš često."
    >
      {items.length === 0 ? (
        <EmptyState
          title="Adresar je prazan"
          description="Adrese se ovdje pojavljuju nakon prvog uspješnog slanja."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((r) => (
            <li key={r.address}>
              <AddressRow recipient={r} onSave={saveLabel} onRemove={remove} />
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

type RowProps = {
  recipient: Recipient;
  onSave: (address: Address, label: string | null) => void;
  onRemove: (address: Address) => void;
};

function AddressRow({ recipient, onSave, onRemove }: RowProps) {
  const [label, setLocalLabel] = useState(recipient.label ?? '');
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Reset draft when the underlying record changes (e.g. parent reload).
  useEffect(() => {
    setLocalLabel(recipient.label ?? '');
  }, [recipient.label, recipient.address]);

  const dirty = (label.trim() || '') !== (recipient.label ?? '');

  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-surface-sunken border border-surface-border p-3">
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="h-10 w-10 rounded-xl shrink-0 ring-1 ring-black/5"
          style={{ background: gradientFor(recipient.address) }}
        />
        <div className="flex flex-col leading-tight min-w-0 flex-1">
          <span className="font-mono text-xs text-ink-secondary truncate">
            {recipient.address}
          </span>
          <span className="text-[11px] text-ink-muted">
            {recipient.count > 0
              ? `${recipient.count}× · zadnje ${formatDate(recipient.lastUsedAt)}`
              : 'spremljeno ručno'}
          </span>
        </div>
        {confirmRemove ? (
          <div className="flex gap-1">
            <IconButton
              aria-label="Potvrdi brisanje"
              size="sm"
              variant="ghost"
              onClick={() => onRemove(recipient.address)}
              className="text-brand-red-700"
            >
              <Check />
            </IconButton>
            <IconButton
              aria-label="Odustani"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemove(false)}
            >
              <X />
            </IconButton>
          </div>
        ) : (
          <IconButton
            aria-label="Ukloni"
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 />
          </IconButton>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          value={label}
          onChange={(e) => setLocalLabel(e.target.value)}
          placeholder="Daj ime (npr. Mama, kafić, Marko)"
          className="flex-1"
          maxLength={48}
        />
        <Button
          size="sm"
          variant={dirty ? 'primary' : 'ghost'}
          disabled={!dirty}
          onClick={() => onSave(recipient.address, label.trim() || null)}
        >
          Spremi
        </Button>
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}

function gradientFor(addr: string): string {
  const seed = addr.toLowerCase();
  const h1 = parseInt(seed.slice(2, 6) || '0', 16) % 360;
  const h2 = (h1 + 60 + (parseInt(seed.slice(6, 8) || '0', 16) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${h1} 70% 55%), hsl(${h2} 70% 45%))`;
}
