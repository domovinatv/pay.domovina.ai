import type { Hono } from 'hono';

import type { Env } from '../../types';
import { getIntent } from '../../intents/db';
import { getReferenceStyle, intentReference } from '../../tenants/rail';
import { decryptReceivingAccount, listActiveReceivingAccounts, type ReceivingAccount } from '../../inflow/receivingAccounts';
import { SANDBOX_FUND_PAYER } from '../../monerium/sandboxFund';
import { makeSwanClient, type SwanClient } from './client';

/// "Simuliraj uplatu" on the checkout of a tenant with an active Swan SANDBOX
/// account (ADR 0032). Unlike ADR 0024's `/simulate` (synthetic `sim_` order,
/// Swan never sees it), this asks Swan's Testing API for an incoming SEPA
/// Instant credit of the intent's amount, with the checkout reference as the
/// label, into the tenant's Swan account. Everything after it is the real
/// path: Swan books it, the webhook hits /api/swan/webhook/t/:tenantId, the
/// adapter re-reads the transaction, matcher, settleFiatCredit → `paid`.
/// Analog of monerium/sandboxFund.ts.

/// One transfer per intent per minute (KV's minimum TTL is 60 s).
const LOCK_TTL_SECONDS = 60;

/// Cheap check for the checkout page (no secret decryption).
export async function hasSwanSandboxAccount(env: Env, tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  const rows = await listActiveReceivingAccounts(env, tenantId, 'swan');
  return rows.some((r) => r.environment === 'sandbox' && r.external_account_id && r.client_id && r.client_secret_enc);
}

/// Where the simulated credit lands: the IBAN registered on the receiving
/// account, else the account's first enabled virtual IBAN, else its own IBAN.
export function pickCreditorIban(
  registered: string | null,
  swan: { iban: string | null; virtualIbans: string[] } | null,
): string | null {
  return registered ?? swan?.virtualIbans[0] ?? swan?.iban ?? null;
}

export interface SwanSandboxTransferDeps {
  account(tenantId: string): Promise<ReceivingAccount | null>;
  client(account: ReceivingAccount): SwanClient;
}

export function makeSwanSandboxTransferDeps(env: Env): SwanSandboxTransferDeps {
  return {
    account: async (tenantId) => {
      const row = (await listActiveReceivingAccounts(env, tenantId, 'swan')).find(
        (r) => r.environment === 'sandbox' && r.external_account_id && r.client_id && r.client_secret_enc,
      );
      return row ? decryptReceivingAccount(env, row) : null;
    },
    client: (a) =>
      makeSwanClient({ environment: 'sandbox', clientId: a.clientId ?? '', clientSecret: a.clientSecret ?? '' }),
  };
}

/// `POST /api/intents/:sid/swan-sandbox-transfer` — mounted into the intent
/// API. The sid is the capability, as for `/simulate`: only sandbox money can
/// move. An intent whose tenant has no Swan sandbox account answers exactly
/// like a missing one.
export function registerSwanSandboxTransferRoute(
  api: Hono<{ Bindings: Env }>,
  depsFor: (env: Env) => SwanSandboxTransferDeps = makeSwanSandboxTransferDeps,
): void {
  api.post('/:sid/swan-sandbox-transfer', async (c) => {
    const sid = c.req.param('sid');
    const intent = await getIntent(c.env, sid);
    const deps = depsFor(c.env);
    const account = intent?.tenant_id ? await deps.account(intent.tenant_id) : null;
    if (!intent || !account) return c.json({ error: 'intent_not_found' }, 404);
    if (intent.state !== 'pending') return c.json({ error: 'intent_not_pending', state: intent.state }, 409);

    const lockKey = `swan-sandbox-transfer:${sid}`;
    if (await c.env.TOKEN_CACHE.get(lockKey)) {
      return c.json({ error: 'already_sent', retry_after_seconds: LOCK_TTL_SECONDS }, 429);
    }
    await c.env.TOKEN_CACHE.put(lockKey, '1', { expirationTtl: LOCK_TTL_SECONDS });

    const label = intentReference(await getReferenceStyle(c.env, intent.tenant_id), intent);
    const amount = (intent.amount_cents / 100).toFixed(2);
    const client = deps.client(account);
    try {
      const ibans = account.iban ? null : await client.getAccountIbans(account.externalAccountId!);
      const creditorIban = pickCreditorIban(account.iban, ibans);
      if (!creditorIban) {
        await c.env.TOKEN_CACHE.delete(lockKey);
        return c.json({ error: 'swan_account_without_iban' }, 409);
      }
      const transactionId = await client.simulateIncomingSepa({
        amount: { value: amount, currency: 'EUR' },
        creditorIban,
        creditorName: ibans?.holderName ?? intent.tenant_id!,
        debtorIban: SANDBOX_FUND_PAYER.iban,
        debtorName: SANDBOX_FUND_PAYER.name,
        label,
        isInstant: true,
      });
      return c.json({
        ok: true,
        sid,
        amount_eur: amount,
        iban: creditorIban,
        label,
        swan_transaction_id: transactionId,
        status_url: `${new URL(c.req.url).origin}/api/intents/${sid}`,
      });
    } catch (e) {
      await c.env.TOKEN_CACHE.delete(lockKey);
      console.error(`swan sandbox transfer ${sid}: ${(e as Error).message}`);
      return c.json({ error: 'swan_simulate_failed', detail: (e as Error).message }, 502);
    }
  });
}
