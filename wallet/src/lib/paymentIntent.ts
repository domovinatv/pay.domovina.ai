import type { Address } from 'viem';
import { PAYMENT_INTENT_API_BASE } from './constants';

export type CreatePaymentIntentInput = {
  destination: Address;
  amountEur: number;
  label?: string;
  metadata?: Record<string, unknown>;
  expiresInSeconds?: number;
};

export type IntentState = 'pending' | 'paid' | 'expired';

export type PaymentIntent = {
  sid: string;
  state: IntentState;
  amount_eur: string;
  amount_cents: number;
  currency: string;
  target_address: Address;
  label: string | null;
  metadata: Record<string, unknown> | null;
  memo: string;
  iban: string;
  beneficiary_name: string;
  bic: string;
  epc_qr_data: string;
  checkout_url: string;
  status_url: string;
  status_stream_url: string;
  created_at: string;
  expires_at: string;
  paid_at: string | null;
  monerium_order_id: string | null;
  forward_tx_hash: string | null;
  amount_received_cents: number | null;
};

/**
 * Create a payment intent on pay.domovina.ai.
 * Backend accepts arbitrary destination address — Zodiac Roles routing on
 * the MPT Safe forwards EURe to it after Monerium mint.
 * See memory: project_payment_intent_arbitrary_destination.md
 */
export async function createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent> {
  const res = await fetch(`${PAYMENT_INTENT_API_BASE}/api/intents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target_address: input.destination,
      amount_eur: input.amountEur,
      label: input.label,
      metadata: { source: 'wallet.domovina.ai', ...(input.metadata ?? {}) },
      expires_in_seconds: input.expiresInSeconds,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Payment intent creation failed (${res.status}): ${err || res.statusText}`);
  }
  return (await res.json()) as PaymentIntent;
}

export async function getPaymentIntent(sid: string): Promise<PaymentIntent> {
  const res = await fetch(`${PAYMENT_INTENT_API_BASE}/api/intents/${sid}`);
  if (!res.ok) throw new Error(`getPaymentIntent ${res.status}`);
  return (await res.json()) as PaymentIntent;
}

/**
 * Subscribe to payment intent state. Backend SSE is not yet implemented
 * (returns 404), so we poll the status endpoint every 5 seconds.
 * See memory: feedback_sse_workers_durable_objects.md
 */
export function subscribePaymentIntent(
  sid: string,
  onUpdate: (intent: PaymentIntent) => void,
): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    if (cancelled) return;
    try {
      const intent = await getPaymentIntent(sid);
      if (!cancelled) onUpdate(intent);
      if (intent.state === 'paid' || intent.state === 'expired') return;
    } catch {
      /* swallow transient errors, keep polling */
    }
    if (!cancelled) timeoutId = setTimeout(tick, 5_000);
  }
  tick();

  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
}
