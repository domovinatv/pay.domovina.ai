import { describe, expect, it } from 'vitest';

import { changeKey, formatEvent, MAX_SINKS_PER_SID, StreamHub, type Sink, type StreamPayload } from '../src/intents/stream';
import type { PaymentStage, StageResult } from '../src/intents/stage';

function payload(stage: PaymentStage, over: Partial<StageResult> = {}, state = 'pending'): StreamPayload {
  return {
    sid: 'abc123def456',
    state,
    status: {
      stage,
      steps: [],
      elapsed_seconds: 0,
      seconds_in_stage: 0,
      forward_expected: true,
      order_id: null,
      order_state: null,
      mint_tx_hashes: [],
      forward_status: null,
      forward_tx_hash: null,
      forward_error: null,
      rejected_reason: null,
      review_expected: null,
      ...over,
    },
  };
}

class FakeSink implements Sink {
  frames: string[] = [];
  closed = false;
  gone = false;
  async send(text: string): Promise<void> {
    if (this.gone) throw new Error('client gone');
    this.frames.push(text);
  }
  close(): void {
    this.closed = true;
  }
  stages(): string[] {
    return this.frames
      .filter((f) => f.includes('event: stage'))
      .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6).trim()).status.stage);
  }
}

/// A controllable "D1": set `current` to what the next read returns.
function source(initial: StreamPayload | null) {
  const s = { current: initial, reads: 0 };
  return { s, load: async () => { s.reads++; return s.current; } };
}

describe('SSE frames', () => {
  it('formats a named, numbered stage event with the polling status object', () => {
    const p = payload('received_processing');
    const f = formatEvent(7, p);
    expect(f.startsWith('event: stage\nid: 7\ndata: ')).toBe(true);
    expect(f.endsWith('\n\n')).toBe(true);
    expect(JSON.parse(f.split('data: ')[1])).toEqual(p);
  });

  it('change key ignores clocks but sees forward/order/state transitions', () => {
    const a = payload('minted', { elapsed_seconds: 5, forward_status: 'failed' });
    expect(changeKey(a)).toBe(changeKey(payload('minted', { elapsed_seconds: 99, forward_status: 'failed' })));
    expect(changeKey(a)).not.toBe(changeKey(payload('minted', { forward_status: 'blocked' })));
    expect(changeKey(payload('settled'))).not.toBe(changeKey(payload('settled', {}, 'paid')));
  });
});

describe('StreamHub', () => {
  it('MT-09: refuses a stream beyond MAX_SINKS_PER_SID', async () => {
    const { load } = source(payload('awaiting_payment'));
    const hub = new StreamHub(load);
    for (let i = 0; i < MAX_SINKS_PER_SID; i++) await hub.subscribe(new FakeSink());
    expect(hub.full).toBe(true);
    const extra = new FakeSink();
    await hub.subscribe(extra);
    expect(hub.size).toBe(MAX_SINKS_PER_SID);
    expect(extra.frames).toHaveLength(0);
  });

  it('opens with a retry hint and the current snapshot', async () => {
    const { load } = source(payload('awaiting_payment'));
    const hub = new StreamHub(load);
    const sink = new FakeSink();
    expect(await hub.subscribe(sink)).toBe(true);
    expect(sink.frames[0].startsWith('retry: 3000\n\n')).toBe(true);
    expect(sink.stages()).toEqual(['awaiting_payment']);
    expect(hub.size).toBe(1);
  });

  it('pushes the full happy path in order and closes on settled', async () => {
    const { s, load } = source(payload('awaiting_payment'));
    const hub = new StreamHub(load);
    const sink = new FakeSink();
    await hub.subscribe(sink);
    for (const stage of ['received_processing', 'minted', 'forwarding', 'settled'] as PaymentStage[]) {
      s.current = payload(stage, { forward_status: stage === 'forwarding' ? 'submitted' : null }, stage === 'settled' ? 'paid' : 'pending');
      await hub.refresh();
    }
    expect(sink.stages()).toEqual(['awaiting_payment', 'received_processing', 'minted', 'forwarding', 'settled']);
    expect(sink.closed).toBe(true);
    expect(hub.size).toBe(0);
  });

  it.each(['rejected', 'expired'] as PaymentStage[])('closes on %s', async (terminal) => {
    const { s, load } = source(payload('received_processing'));
    const hub = new StreamHub(load);
    const sink = new FakeSink();
    await hub.subscribe(sink);
    s.current = payload(terminal);
    await hub.refresh();
    expect(sink.stages()).toEqual(['received_processing', terminal]);
    expect(sink.closed).toBe(true);
  });

  it('does not repeat an unchanged status (poke + heartbeat both re-read)', async () => {
    const { s, load } = source(payload('received_processing'));
    const hub = new StreamHub(load);
    const sink = new FakeSink();
    await hub.subscribe(sink);
    await hub.refresh();
    s.current = payload('received_processing', { elapsed_seconds: 40 });
    await hub.refresh();
    expect(sink.stages()).toEqual(['received_processing']);
  });

  it('sends a terminal snapshot once and closes immediately', async () => {
    const { load } = source(payload('settled', {}, 'paid'));
    const hub = new StreamHub(load);
    const sink = new FakeSink();
    await hub.subscribe(sink);
    expect(sink.stages()).toEqual(['settled']);
    expect(sink.closed).toBe(true);
    expect(hub.size).toBe(0);
  });

  it('returns false for an unknown intent', async () => {
    const hub = new StreamHub(source(null).load);
    const sink = new FakeSink();
    expect(await hub.subscribe(sink)).toBe(false);
    expect(sink.closed).toBe(true);
  });

  it('fans out to every subscriber and drops a client that went away', async () => {
    const { s, load } = source(payload('awaiting_payment'));
    const hub = new StreamHub(load);
    const a = new FakeSink();
    const b = new FakeSink();
    await hub.subscribe(a);
    await hub.subscribe(b);
    b.gone = true;
    s.current = payload('received_processing');
    await hub.refresh();
    expect(a.stages()).toEqual(['awaiting_payment', 'received_processing']);
    expect(b.closed).toBe(true);
    expect(hub.size).toBe(1);
  });

  it('a late subscriber with a newer read updates the earlier ones too', async () => {
    const { s, load } = source(payload('awaiting_payment'));
    const hub = new StreamHub(load);
    const early = new FakeSink();
    await hub.subscribe(early);
    s.current = payload('received_processing');
    const late = new FakeSink();
    await hub.subscribe(late);
    expect(early.stages()).toEqual(['awaiting_payment', 'received_processing']);
    expect(late.stages()).toEqual(['received_processing']);
  });

  it('skips the D1 read when nobody is listening', async () => {
    const { s, load } = source(payload('awaiting_payment'));
    const hub = new StreamHub(load);
    await hub.refresh();
    expect(s.reads).toBe(0);
  });

  it('pings keep-alive comments', async () => {
    const hub = new StreamHub(source(payload('awaiting_payment')).load);
    const sink = new FakeSink();
    await hub.subscribe(sink);
    await hub.ping();
    expect(sink.frames.at(-1)).toBe(': ping\n\n');
  });
});

describe('GET /api/intents/:sid/stream while INTENT_SSE is off', () => {
  it('keeps the historical 404 so EventSource clients fall back to polling', async () => {
    const { default: worker } = await import('../src/index');
    const res = await worker.fetch(
      new Request('https://mpt.domovina.ai/api/intents/abc123def456/stream'),
      { ALLOWED_ORIGINS: 'https://energy.domovina.ai', INTENT_SSE: '0' } as never,
      { waitUntil: () => {}, passThroughOnException: () => {} } as never,
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'sse_not_yet_implemented_use_polling' });
  });
});
