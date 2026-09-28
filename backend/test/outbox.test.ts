import { describe, expect, it } from 'vitest';

import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_S,
  attemptDelivery,
  classifyResponse,
  deliverDue,
  enqueueAndDeliver,
  nextAttemptAt,
} from '../src/intents/outbox';
import type { OutboxDeps, OutboxRow, SendResult } from '../src/intents/outbox';

const NOW = 1_800_000_000;

/// In-memory outbox mirroring the D1 semantics (PK dedup, due filter).
function makeDeps(responses: SendResult[]) {
  const rows = new Map<string, OutboxRow>();
  const sent: string[] = [];
  const alerts: string[] = [];
  let call = 0;
  const deps: OutboxDeps = {
    async insert(row) {
      if (rows.has(row.id)) return false;
      rows.set(row.id, { ...row });
      return true;
    },
    async listDue(now, limit) {
      return [...rows.values()]
        .filter((r) => r.status === 'pending' && r.next_attempt_at <= now)
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },
    async markDelivered(id, attempts, status, now) {
      Object.assign(rows.get(id)!, { status: 'delivered', attempts, last_status: status, delivered_at: now });
    },
    async markRetry(id, attempts, nextAt, status, error) {
      Object.assign(rows.get(id)!, { attempts, next_attempt_at: nextAt, last_status: status, last_error: error });
    },
    async markFailed(id, attempts, status, error) {
      Object.assign(rows.get(id)!, { status: 'failed', attempts, last_status: status, last_error: error });
    },
    async send(id) {
      sent.push(id);
      return responses[Math.min(call++, responses.length - 1)];
    },
    async alert(text) {
      alerts.push(text);
    },
  };
  return { deps, rows, sent, alerts };
}

const EVT = { id: 'rcv_ord-1', type: 'payment.received', payload: { a: 1 } };

describe('classifyResponse', () => {
  it('2xx delivered; 408/429/5xx/network retry; other 4xx permanent', () => {
    expect(classifyResponse(200)).toBe('delivered');
    expect(classifyResponse(204)).toBe('delivered');
    expect(classifyResponse(null)).toBe('retry');
    expect(classifyResponse(408)).toBe('retry');
    expect(classifyResponse(429)).toBe('retry');
    expect(classifyResponse(502)).toBe('retry');
    expect(classifyResponse(400)).toBe('permanent');
    expect(classifyResponse(401)).toBe('permanent');
  });
});

describe('nextAttemptAt', () => {
  it('follows the backoff table and stops at MAX_ATTEMPTS', () => {
    expect(nextAttemptAt(1, NOW)).toBe(NOW + RETRY_DELAYS_S[0]);
    expect(nextAttemptAt(2, NOW)).toBe(NOW + RETRY_DELAYS_S[1]);
    expect(nextAttemptAt(MAX_ATTEMPTS - 1, NOW)).toBe(NOW + RETRY_DELAYS_S[RETRY_DELAYS_S.length - 1]);
    expect(nextAttemptAt(MAX_ATTEMPTS, NOW)).toBeNull();
  });
});

describe('enqueueAndDeliver', () => {
  it('persists then delivers immediately on 2xx', async () => {
    const h = makeDeps([{ status: 200 }]);
    expect(await enqueueAndDeliver(h.deps, EVT, NOW)).toBe('delivered');
    const row = h.rows.get('rcv_ord-1')!;
    expect(row.status).toBe('delivered');
    expect(row.attempts).toBe(1);
    expect(JSON.parse(row.payload)).toEqual({ a: 1 });
  });

  it('same event id twice → second call is a no-op (no second send)', async () => {
    const h = makeDeps([{ status: 200 }]);
    await enqueueAndDeliver(h.deps, EVT, NOW);
    expect(await enqueueAndDeliver(h.deps, EVT, NOW + 5)).toBe('duplicate');
    expect(h.sent).toEqual(['rcv_ord-1']);
  });

  it('5xx on first attempt → stays pending for the cron, not picked up while in flight', async () => {
    const h = makeDeps([{ status: 503, error: 'down' }]);
    expect(await enqueueAndDeliver(h.deps, EVT, NOW)).toBe('retry');
    const row = h.rows.get('rcv_ord-1')!;
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at).toBe(NOW + RETRY_DELAYS_S[0]);
    expect(await h.deps.listDue(NOW, 10)).toHaveLength(0);
  });

  it('4xx → failed at once + operator alert', async () => {
    const h = makeDeps([{ status: 400, error: 'missing_sid' }]);
    expect(await enqueueAndDeliver(h.deps, EVT, NOW)).toBe('failed');
    expect(h.rows.get('rcv_ord-1')!.status).toBe('failed');
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0]).toContain('rcv_ord-1');
  });
});

describe('deliverDue (cron)', () => {
  it('retries due rows until delivered', async () => {
    const h = makeDeps([{ status: null, error: 'timeout' }, { status: 500 }, { status: 200 }]);
    await enqueueAndDeliver(h.deps, EVT, NOW);
    let t = NOW + RETRY_DELAYS_S[0];
    expect(await deliverDue(h.deps, t)).toEqual({ due: 1, delivered: 0, failed: 0 });
    t += RETRY_DELAYS_S[1];
    expect(await deliverDue(h.deps, t)).toEqual({ due: 1, delivered: 1, failed: 0 });
    expect(h.rows.get('rcv_ord-1')!.attempts).toBe(3);
    expect(await deliverDue(h.deps, t + 100_000)).toEqual({ due: 0, delivered: 0, failed: 0 });
  });

  it('exhausted retries → failed + exactly one alert', async () => {
    const h = makeDeps([{ status: 502 }]);
    await enqueueAndDeliver(h.deps, EVT, NOW);
    let t = NOW;
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
      t += 2 * 86_400;
      await deliverDue(h.deps, t);
    }
    const row = h.rows.get('rcv_ord-1')!;
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(h.alerts).toHaveLength(1);
  });

  it('attemptDelivery counts from the stored attempts', async () => {
    const h = makeDeps([{ status: 200 }]);
    await h.deps.insert({
      id: 'x', type: 't', payload: '{}', tenant_id: null, status: 'pending',
      attempts: 4, next_attempt_at: NOW, last_status: null, last_error: null,
      created_at: NOW, delivered_at: null,
    });
    await attemptDelivery(h.deps, (await h.deps.listDue(NOW, 1))[0], NOW);
    expect(h.rows.get('x')!.attempts).toBe(5);
  });
});
