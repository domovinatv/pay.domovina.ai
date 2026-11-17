import type { Env } from '../types';
import type { SepaDetails } from '../tenants/db';
import { getSepaDetails } from '../tenants/db';
import { listActiveReceivingAccounts, type ReceivingAccountRow } from './receivingAccounts';

/// Which inflow provider an intent goes through (ADR 0032, migration 0035).
/// Fixed at creation; it decides the checkout (IBAN, reference, timeline,
/// copy) and the API response.
///
///   monerium — SEPA → Monerium → EURe minted on Gnosis (the original rail;
///              also ADR 0024 sandbox tenants without a fiat account)
///   swan     — plain SEPA (Instant) onto the tenant's own Swan account; no
///              EURe, no chain, no target address (fiat_notify)
export type IntentProvider = 'monerium' | 'swan';

export const INTENT_PROVIDERS: readonly IntentProvider[] = ['monerium', 'swan'];

/// fiat_notify providers: the money stays fiat on the tenant's account.
const FIAT: ReadonlySet<string> = new Set(['swan']);

export function isFiatProvider(p: string | null | undefined): boolean {
  return !!p && FIAT.has(p);
}

/// The intent's provider; rows from before migration 0035 are Monerium.
export function intentProvider(intent: { provider?: string | null }): IntentProvider {
  return intent.provider === 'swan' ? 'swan' : 'monerium';
}

/// Stored instead of a target address for a fiat intent: the column is NOT
/// NULL and nothing on a fiat rail is ever sent on-chain.
export const FIAT_TARGET_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

export function parseIntentProvider(v: unknown): IntentProvider | null {
  return typeof v === 'string' && (INTENT_PROVIDERS as readonly string[]).includes(v) ? (v as IntentProvider) : null;
}

/// The tenant's usable fiat account for a provider: active, fiat_notify,
/// with credentials. Sandbox tenants may only use sandbox accounts.
async function fiatAccount(env: Env, tenantId: string, provider: string): Promise<ReceivingAccountRow | null> {
  const rows = await listActiveReceivingAccounts(env, tenantId, provider);
  return rows.find((r) => r.mode === 'fiat_notify' && r.external_account_id && r.client_id && r.client_secret_enc) ?? null;
}

export interface TenantProviders {
  available: IntentProvider[];
  /// What an intent gets when the caller does not say: a fiat account wins
  /// (the tenant set it up to be paid on it), otherwise Monerium.
  default: IntentProvider;
}

/// Monerium is always listed: whether the tenant's rail can actually take
/// the money is the existing rail check's job (tenantRailRefusal).
export async function tenantProviders(env: Env, tenantId: string): Promise<TenantProviders> {
  const swan = await fiatAccount(env, tenantId, 'swan');
  return swan
    ? { available: ['swan', 'monerium'], default: 'swan' }
    : { available: ['monerium'], default: 'monerium' };
}

/// Where the payer sends the money for this intent. Monerium: the tenant's
/// (Monerium) IBAN as before. Fiat: the IBAN registered on the tenant's
/// provider account, under the tenant's beneficiary name.
export async function getPayeeDetails(
  env: Env,
  intent: { tenant_id: string | null; provider?: string | null },
  defaultTenantId: string,
): Promise<SepaDetails> {
  const tenantId = intent.tenant_id ?? defaultTenantId;
  const sepa = await getSepaDetails(env, tenantId);
  const provider = intentProvider(intent);
  if (!isFiatProvider(provider)) return sepa;
  const acc = await fiatAccount(env, tenantId, provider);
  if (!acc?.iban) {
    console.error(`intent provider ${provider} on tenant ${tenantId}: no IBAN on the receiving account`);
    return { ...sepa, iban: '', bic: '' };
  }
  return { beneficiaryName: sepa.beneficiaryName, iban: acc.iban, bic: '' };
}

/// Does the tenant's fiat account carry an IBAN a payer can be shown?
export async function fiatAccountHasIban(env: Env, tenantId: string, provider: IntentProvider): Promise<boolean> {
  return !!(await fiatAccount(env, tenantId, provider))?.iban;
}
