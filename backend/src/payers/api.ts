import { Hono } from 'hono';

import type { Env } from '../types';
import { normalizeIban, parseAmountCents } from '../monerium/orderState';

/// Public payer tags for one payout address: who paid, anonymised to initials
/// and the last 4 IBAN characters, so a payer watching any screen recognises
/// their own payment the moment Monerium receives it — before it is on chain.
///
/// Opt-in per tenant (`tenants.public_payer_tags`, migration 0032). The full
/// name and IBAN never leave the rail, and neither does the sid (a capability).

export const PAYERS_LIMIT = 50;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/// Legal-form words are not a person's initials ("ITALK D.O.O." → "I.").
const LEGAL_FORMS = new Set(['doo', 'jdoo', 'dd', 'obrt', 'gmbh', 'ltd', 'llc', 'uab', 'sa', 'srl', 'oü', 'ou', 'as']);

/// "Matija Stepanić" → "M. S."; "STEPANIC MATIJA" → "S. M."; one word → "M.".
/// First and last word only, so a long name does not grow into a fingerprint.
export function initials(name: string | null | undefined): string | null {
  const words = (name ?? '')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 0 && /^\p{L}/u.test(w) && !LEGAL_FORMS.has(w.toLowerCase()));
  if (words.length === 0) return null;
  const pick = words.length === 1 ? [words[0]] : [words[0], words[words.length - 1]];
  return pick.map((w) => `${w[0].toLocaleUpperCase('hr')}.`).join(' ');
}

export function ibanLast4(iban: string | null | undefined): string | null {
  const s = normalizeIban(iban);
  return s && s.length >= 8 ? s.slice(-4) : null;
}

export interface PayerTag {
  initials: string | null;
  iban_last4: string | null;
  amount_cents: number | null;
  /// Monerium `placedAt` (ISO): when the bank transfer reached Monerium.
  received_at: string | null;
  /// 'received' until EURe is minted, then 'minted'.
  state: 'received' | 'minted';
  /// Every on-chain hash of this payment (mint and forward), lowercase — the
  /// client matches its chain rows by any of them.
  tx_hashes: string[];
}

interface Row {
  state: string;
  amount: string;
  placed_at: string | null;
  counterpart_iban: string | null;
  counterpart_name: string | null;
  tx_hashes: string | null;
  intent_tx: string | null;
  forward_txs: string | null;
}

function parseHashes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [];
  } catch {
    return [];
  }
}

export async function listPayerTags(env: Env, address: string): Promise<PayerTag[]> {
  const addr = address.toLowerCase();
  // An order belongs to the address through its intent, a rail forward, or a
  // direct mint. Tenant = the order's (NULL rows are the default tenant).
  const res = await env.DB.prepare(
    `SELECT o.state, o.amount, o.placed_at, o.counterpart_iban, o.counterpart_name, o.tx_hashes,
            (SELECT i.forward_tx_hash FROM payment_intents i WHERE i.monerium_order_id = o.id
              ORDER BY i.paid_at DESC LIMIT 1) AS intent_tx,
            (SELECT json_group_array(f.tx_hash) FROM monerium_forwards f
              WHERE f.order_id = o.id AND f.tx_hash IS NOT NULL) AS forward_txs
       FROM monerium_orders o
       JOIN tenants t ON t.id = COALESCE(o.tenant_id, ?2)
      WHERE o.kind = 'issue' AND o.state IN ('placed', 'pending', 'processed')
        AND t.public_payer_tags = 1
        AND (lower(o.address) = ?1
             OR EXISTS (SELECT 1 FROM payment_intents i
                         WHERE i.monerium_order_id = o.id AND i.target_address = ?1)
             OR EXISTS (SELECT 1 FROM monerium_forwards f
                         WHERE f.order_id = o.id AND f.target_address = ?1
                           AND f.status IN ('pending', 'submitted', 'confirmed')))
      ORDER BY o.placed_at DESC
      LIMIT ?3`,
  )
    .bind(addr, env.DEFAULT_TENANT_ID, PAYERS_LIMIT)
    .all<Row>();
  return res.results.map((r) => {
    const hashes = [...parseHashes(r.tx_hashes), ...parseHashes(r.forward_txs), ...(r.intent_tx ? [r.intent_tx] : [])];
    return {
      initials: initials(r.counterpart_name),
      iban_last4: ibanLast4(r.counterpart_iban),
      amount_cents: parseAmountCents(r.amount),
      received_at: r.placed_at,
      state: r.state === 'processed' ? 'minted' : 'received',
      tx_hashes: [...new Set(hashes.map((h) => h.toLowerCase()))],
    };
  });
}

export function buildPayersApi() {
  const api = new Hono<{ Bindings: Env }>();
  api.get('/:address', async (c) => {
    const address = c.req.param('address');
    if (!ADDR_RE.test(address)) return c.json({ error: 'invalid_address' }, 400);
    const data = await listPayerTags(c.env, address);
    // Polled every few seconds by every open project page.
    c.header('Cache-Control', 'public, max-age=5');
    return c.json({ data });
  });
  return api;
}
