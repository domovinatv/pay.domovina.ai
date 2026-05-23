// GET /api/relay/status?signerAddress=0x…
//
// Returns the current free-tier usage for the given signer (= the Safe
// passkey signer address) so the wallet can render X/5 + a countdown to
// the UTC midnight reset without having to attempt a send first.
//
// Read-only; safe to call on every Send screen mount + on a 1-minute tick.

import { isAddress } from 'viem';

const FREE_DAILY_LIMIT = 5;

type Env = {
  RELAY_KV: KVNamespace;
};

type StatusResponse = {
  signerAddress: string;
  used: number;
  remaining: number;
  limit: number;
  /** UTC midnight at which the counter resets. ISO 8601. */
  resetsAt: string;
  /** Seconds until the reset. Negative is clamped to 0. */
  resetsInSec: number;
};

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const signerAddress = (url.searchParams.get('signerAddress') ?? '').trim();
  if (!signerAddress || !isAddress(signerAddress)) {
    return json({ error: 'Missing or invalid signerAddress' }, 400);
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const rateKey = `relay:${signerAddress.toLowerCase()}:${today}`;
  const used = Math.max(0, Number((await env.RELAY_KV.get(rateKey)) ?? 0));
  const cappedUsed = Math.min(used, FREE_DAILY_LIMIT);

  // Next UTC midnight.
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const resetsInSec = Math.max(0, Math.floor((tomorrow.getTime() - now.getTime()) / 1000));

  const body: StatusResponse = {
    signerAddress,
    used: cappedUsed,
    remaining: Math.max(0, FREE_DAILY_LIMIT - cappedUsed),
    limit: FREE_DAILY_LIMIT,
    resetsAt: tomorrow.toISOString(),
    resetsInSec,
  };

  return json(body, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      // Hot path on Send screen — same-origin only, no preflight needed in
      // production, but Pages may add the header anyway. Keep it explicit.
      'access-control-allow-origin': '*',
    },
  });
}
