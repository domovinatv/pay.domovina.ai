import type { Hono } from 'hono';

import type { Env } from '../types';
import { getIntent } from '../intents/db';
import { getSepaDetails } from '../tenants/db';
import { getReferenceStyle, getTenantRail, getTenantRailRow, intentReference } from '../tenants/rail';
import { MONERIUM_SANDBOX_API, MoneriumClient } from './client';

/// "Simuliraj SEPA uplatu" on the checkout of a rail tenant on Monerium's
/// sandbox. Unlike ADR 0024's `/simulate` (no Monerium at all), this asks
/// Monerium to fake the BANK leg only: a SEPA transfer of the intent's amount
/// with the intent's reference into the tenant's sandbox IBAN. Everything
/// after it is the real path — Monerium order, webhook, mint on Chiado,
/// forward or direct settle.
///
/// The call is the one behind "Simulate bank transfer" in sandbox.monerium.dev
/// (`POST /api/treasury/fund`). That is the web UI's endpoint, not the public
/// API (api.monerium.dev answers 404), but it accepts the Private app's Bearer
/// token (verified 2026-10-12, tools/funding/simulate-payment.mjs). The memo is
/// the checkout reference, so a direct-mode `chiado:<Safe> sid:<sid>` routes
/// the mint to the project Safe without moving the IBAN.

export const SANDBOX_FUND_PAYER = { name: 'Ivan Horvat', iban: 'HR1210010051863000160' } as const;
/// One transfer per intent per minute: a double click must not mint twice.
/// (KV's minimum TTL is 60 s.)
const LOCK_TTL_SECONDS = 60;

/// Cheap check for the page (no secret decryption).
export async function isMoneriumSandboxTenant(env: Env, tenantId: string | null): Promise<boolean> {
  if (!tenantId) return false;
  return (await getTenantRailRow(env, tenantId))?.monerium_env === 'sandbox';
}

export function sandboxFundBody(args: { amountCents: number; iban: string; memo: string }): Record<string, unknown> {
  return {
    currency: 'EUR',
    amount: (args.amountCents / 100).toFixed(2),
    iban: args.iban.replace(/\s+/g, ''),
    memo: args.memo,
    counterpart: {
      identifier: { standard: 'iban', iban: SANDBOX_FUND_PAYER.iban },
      details: { name: SANDBOX_FUND_PAYER.name },
    },
  };
}

/// `POST /api/intents/:sid/monerium-sandbox-transfer` — mounted into the
/// intent API. The sid is the capability, as for status and `/simulate`: only
/// sandbox money can move. Any intent that is not on a Monerium-sandbox rail
/// answers exactly like a missing one.
export function registerMoneriumSandboxFundRoute(api: Hono<{ Bindings: Env }>): void {
  api.post('/:sid/monerium-sandbox-transfer', async (c) => {
    const sid = c.req.param('sid');
    const intent = await getIntent(c.env, sid);
    if (!intent || !(await isMoneriumSandboxTenant(c.env, intent.tenant_id))) {
      return c.json({ error: 'intent_not_found' }, 404);
    }
    const rail = await getTenantRail(c.env, intent.tenant_id!);
    if (!rail || rail.monerium.baseUrl !== MONERIUM_SANDBOX_API) {
      return c.json({ error: 'intent_not_found' }, 404);
    }
    if (intent.state !== 'pending') return c.json({ error: 'intent_not_pending', state: intent.state }, 409);

    const lockKey = `sandbox-fund:${sid}`;
    if (await c.env.TOKEN_CACHE.get(lockKey)) {
      return c.json({ error: 'already_sent', retry_after_seconds: LOCK_TTL_SECONDS }, 429);
    }
    await c.env.TOKEN_CACHE.put(lockKey, '1', { expirationTtl: LOCK_TTL_SECONDS });

    const sepa = await getSepaDetails(c.env, intent.tenant_id!);
    const memo = intentReference(await getReferenceStyle(c.env, intent.tenant_id), intent);
    const body = sandboxFundBody({ amountCents: intent.amount_cents, iban: sepa.iban, memo });
    let r: { status: number; text: string };
    try {
      r = await new MoneriumClient(c.env, rail.monerium).sandboxFund(body);
    } catch (e) {
      r = { status: 0, text: (e as Error).message };
    }
    if (r.status < 200 || r.status >= 300) {
      await c.env.TOKEN_CACHE.delete(lockKey);
      console.error(`monerium sandbox fund ${sid}: ${r.status} ${r.text}`);
      return c.json({ error: 'monerium_fund_failed', monerium_status: r.status }, 502);
    }
    return c.json({
      ok: true,
      sid,
      amount_eur: body.amount,
      iban: body.iban,
      memo,
      status_url: `${new URL(c.req.url).origin}/api/intents/${sid}`,
    });
  });
}
