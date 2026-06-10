/**
 * Per-account "jednostavni prikaz" preference: when ON for a Safe, the UI
 * collapses to an everyday-wallet surface (balance + Primi/Pošalji +
 * transactions) and hides everything advanced (account picker, security,
 * on-chain status, seed…). Pure display preference — device-local, never
 * synced, no effect on signing or relay paths.
 */
const STORAGE_KEY = 'domovina_simple_mode_v1';

type SimpleModeMap = Record<string, true>;

function load(): SimpleModeMap {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as SimpleModeMap;
  } catch {
    return {};
  }
}

export function isSimpleMode(safeAddress: string): boolean {
  return !!load()[safeAddress.toLowerCase()];
}

export function setSimpleModeFor(safeAddress: string, on: boolean): void {
  const map = load();
  const key = safeAddress.toLowerCase();
  if (on) map[key] = true;
  else delete map[key];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}
