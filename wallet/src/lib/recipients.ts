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

export function removeRecipient(address: Address): void {
  const items = read().filter((r) => r.address.toLowerCase() !== address.toLowerCase());
  write(items);
}

export function clearRecipients(): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
