import { Hono } from 'hono';

import type { Env } from '../types';
import { sendAlert } from '../alerts';
import { anchorPendingLeaves } from './anchor';
import { registerReceiptAnchorRoutes } from './api';
import { linkReceipts } from './link';

/// ADR 0022 is on unless RECEIPTS is explicitly "0" in wrangler.toml.
export function receiptsEnabled(env: Env): boolean {
  return env.RECEIPTS !== '0';
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// Mounted at /api/receipts.
export function buildReceiptAnchorApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  // Operator trigger for what the 00:00 UTC cron does (link + one chained
  // anchor + OpenTimestamps), so a fresh state need not wait for midnight.
  // An extra anchor is harmless: it is just the next link of the chain.
  // Without RECEIPT_ANCHOR_KEY set the route does not exist.
  api.post('/anchors/now', async (c) => {
    const secret = (c.env.RECEIPT_ANCHOR_KEY ?? '').trim();
    if (!secret || !receiptsEnabled(c.env)) return c.json({ error: 'not_found' }, 404);
    if (!sameSecret(c.req.header('x-anchor-key') ?? '', secret)) return c.json({ error: 'unauthorized' }, 401);
    const linked = await linkReceipts(c.env, { alert: (t) => sendAlert(c.env, t) });
    const anchor = await anchorPendingLeaves(c.env, { heartbeat: true });
    return c.json({ ok: true, linked, anchor });
  });

  registerReceiptAnchorRoutes(api);
  return api;
}
