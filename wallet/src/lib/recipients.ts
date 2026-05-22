import { getAddress, isAddress, type Address } from 'viem';

// Per-device "recent recipients" cache. Populated after every successful Send
// so the next transfer to the same address is a single tap. Survives sign-out
// (we keep the local registry); only "Odjavi se s ovog uređaja" + reinstall
// wipes it.

const STORAGE_KEY = 'domovina_wallet_recipients_v1';
const MAX_STORED = 20;

export type Recipient = {
  address: Address;
  lastUsedAt: string;   // ISO timestamp
  count: number;
  label?: string;       // reserved for future address-book labelling
};

function read(): Recipient[] {
  if (typeof localStorage === 'undefined') return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Recipient[];
    if (!Array.isArray(parsed)) return [];
    // Defensive — filter out anything obviously malformed.
    return parsed.filter(
      (r) =>
        r &&
        typeof r.address === 'string' &&
        isAddress(r.address) &&
        typeof r.lastUsedAt === 'string' &&
        typeof r.count === 'number',
    );
  } catch {
    return [];
  }
}

function write(items: Recipient[]): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_STORED)));
}

export function addRecipient(rawAddress: string, label?: string): void {
  if (!isAddress(rawAddress)) return;
  const address = getAddress(rawAddress);
  const items = read();
  const idx = items.findIndex((r) => r.address.toLowerCase() === address.toLowerCase());
  const now = new Date().toISOString();
  if (idx >= 0) {
    items[idx] = {
      ...items[idx],
      address,
      lastUsedAt: now,
      count: items[idx].count + 1,
      label: label ?? items[idx].label,
    };
  } else {
    items.push({ address, lastUsedAt: now, count: 1, label });
  }
  // Sort newest-first so list returns are already in display order.
  items.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  write(items);
}

export function listRecentRecipients(limit = 5): Recipient[] {
  return read().slice(0, limit);
}

export function listAllRecipients(): Recipient[] {
  return read();
}

export function removeRecipient(address: Address): void {
  const items = read().filter((r) => r.address.toLowerCase() !== address.toLowerCase());
  write(items);
}

/**
 * Set or clear the user-chosen label for a recipient. Adds a stub entry if
 * the address has never been seen before (so the address book also supports
 * "save someone before sending").
 */
export function setLabel(rawAddress: string, label: string | null): void {
  if (!isAddress(rawAddress)) return;
  const address = getAddress(rawAddress);
  const items = read();
  const idx = items.findIndex((r) => r.address.toLowerCase() === address.toLowerCase());
  const trimmed = label?.trim();
  if (idx >= 0) {
    items[idx] = { ...items[idx], label: trimmed && trimmed.length > 0 ? trimmed : undefined };
  } else {
    items.push({
      address,
      lastUsedAt: new Date().toISOString(),
      count: 0,
      label: trimmed && trimmed.length > 0 ? trimmed : undefined,
    });
    items.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }
  write(items);
}

/**
 * Look up the saved label for an address. Case-insensitive. Returns undefined
 * for unknown addresses or those without a label.
 */
export function getLabel(rawAddress: string): string | undefined {
  if (!isAddress(rawAddress)) return undefined;
  const target = rawAddress.toLowerCase();
  const items = read();
  return items.find((r) => r.address.toLowerCase() === target)?.label;
}

export function clearRecipients(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
