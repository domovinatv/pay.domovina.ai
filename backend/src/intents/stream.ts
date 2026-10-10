import type { Env } from '../types';
import { getIntent } from './db';
import { computeStage, loadStageContext, type PaymentStage, type StageResult } from './stage';

/// SSE for payment intents — `GET /api/intents/:sid/stream` (ADR 0017 §SSE).
///
/// A plain Worker cannot push a webhook's effect into a connection held by a
/// different request, so every sid gets one Durable Object (`IntentStream`,
/// `idFromName(sid)`) that holds that intent's open streams.
///
/// The DO computes the status ITSELF, from D1, with the same code as the
/// polling endpoint (`loadStageContext` + `computeStage`), so the `status`
/// object in an SSE event is byte-for-byte what `GET status_url` returns.
/// Writers on the money path only "poke" the DO (`publishIntentChange`);
/// they never compute or format anything for it. On top of that the DO
/// re-reads D1 on every heartbeat, so a missed poke delays an update by at
/// most one heartbeat instead of losing it.
///
/// Wire format:
///   retry: 3000
///   event: stage · id: <n> · data: {"sid","state","status"}
///   : ping            every HEARTBEAT_MS
/// The stream closes after a terminal stage or MAX_STREAM_MS; the client then
/// falls back to polling, which never went away.

export const HEARTBEAT_MS = 15_000;
export const MAX_STREAM_MS = 30 * 60_000;
export const RETRY_MS = 3_000;

const TERMINAL: ReadonlySet<PaymentStage> = new Set(['settled', 'rejected', 'expired']);

export interface StreamPayload {
  sid: string;
  state: string;
  status: StageResult;
}

export function isTerminalStage(stage: PaymentStage): boolean {
  return TERMINAL.has(stage);
}

/// What counts as "changed". Stage alone would hide e.g. a forward going from
/// `failed` to a retried `submitted` (both read `minted`/`forwarding`), so the
/// key also carries the forward and order states. Elapsed counters are left
/// out on purpose — they change every second.
export function changeKey(p: StreamPayload): string {
  const s = p.status;
  return [p.state, s.stage, s.order_state ?? '-', s.forward_status ?? '-', s.forward_tx_hash ?? '-'].join('|');
}

export function formatEvent(id: number, p: StreamPayload): string {
  return `event: stage\nid: ${id}\ndata: ${JSON.stringify(p)}\n\n`;
}

export interface Sink {
  /// Rejects once the client is gone.
  send(text: string): Promise<void>;
  close(): void;
}

/// Fan-out logic, free of Workers APIs (unit-tested directly).
/// Open streams per sid (MT-09). A checkout has one or two tabs; more is
/// someone holding connections open.
export const MAX_SINKS_PER_SID = 8;

export class StreamHub {
  private sinks = new Set<Sink>();
  private lastKey: string | null = null;
  private seq = 0;

  constructor(private load: () => Promise<StreamPayload | null>) {}

  get size(): number {
    return this.sinks.size;
  }

  get full(): boolean {
    return this.sinks.size >= MAX_SINKS_PER_SID;
  }

  /// Opens a stream: retry hint + a fresh snapshot. A terminal snapshot is
  /// sent and the stream closed at once. Returns false when the intent is gone.
  async subscribe(sink: Sink): Promise<boolean> {
    // Re-checked here: concurrent subscribes can all pass the caller's check.
    if (this.full) {
      sink.close();
      return true;
    }
    const p = await this.load();
    if (!p) {
      sink.close();
      return false;
    }
    const key = changeKey(p);
    const changed = key !== this.lastKey;
    this.lastKey = key;
    const frame = formatEvent(++this.seq, p);
    try {
      await sink.send(`retry: ${RETRY_MS}\n\n` + frame);
    } catch {
      sink.close();
      return true;
    }
    if (isTerminalStage(p.status.stage)) {
      sink.close();
    } else {
      this.sinks.add(sink);
    }
    // The fresh read may be newer than what the others last saw.
    if (changed) await this.broadcast(frame, isTerminalStage(p.status.stage), sink);
    return true;
  }

  /// Re-read and push if anything meaningful changed. Called on every poke
  /// from the money path and on every heartbeat.
  async refresh(): Promise<void> {
    if (this.sinks.size === 0) return;
    const p = await this.load();
    if (!p) return;
    const key = changeKey(p);
    if (key === this.lastKey) return;
    this.lastKey = key;
    await this.broadcast(formatEvent(++this.seq, p), isTerminalStage(p.status.stage));
  }

  /// Comment frame that keeps proxies from closing an idle stream, and the
  /// only reliable way to notice a client that went away.
  async ping(): Promise<void> {
    await this.broadcast(': ping\n\n', false);
  }

  closeAll(): void {
    for (const s of this.sinks) s.close();
    this.sinks.clear();
  }

  drop(sink: Sink): void {
    if (this.sinks.delete(sink)) sink.close();
  }

  private async broadcast(text: string, terminal: boolean, except?: Sink): Promise<void> {
    await Promise.all(
      [...this.sinks].map(async (s) => {
        if (s === except) return;
        try {
          await s.send(text);
        } catch {
          this.drop(s);
        }
      }),
    );
    if (terminal) this.closeAll();
  }
}

/// The status read shared by the DO. Same functions as GET /api/intents/:sid,
/// minus the best-effort receipt check (that one stays on the polling path —
/// the heartbeat refresh picks its result up).
export async function loadStreamPayload(env: Env, sid: string): Promise<StreamPayload | null> {
  const intent = await getIntent(env, sid);
  if (!intent) return null;
  const { order, forward, knownPayer } = await loadStageContext(env, intent);
  const status = computeStage({ intent, order, forward, knownPayer, now: Math.floor(Date.now() / 1000) });
  return { sid: intent.sid, state: intent.state, status };
}

export function sseEnabled(env: Env): boolean {
  return (env.INTENT_SSE ?? '').trim() === '1' && Boolean(env.INTENT_STREAM);
}

/// Poke the sid's stream after a state change. Fail-soft and cheap: never
/// throws, never blocks a money path (callers put it in waitUntil), and is a
/// no-op while SSE is off.
export async function publishIntentChange(env: Env, sid: string | null | undefined): Promise<void> {
  if (!sid || !sseEnabled(env)) return;
  try {
    const stub = env.INTENT_STREAM!.get(env.INTENT_STREAM!.idFromName(sid));
    await stub.fetch(`https://intent-stream/poke?sid=${encodeURIComponent(sid)}`, { method: 'POST' });
  } catch (e) {
    console.warn(`intent stream poke ${sid}: ${(e as Error).message}`);
  }
}

/// Open a stream for `sid` through its Durable Object. The response is
/// re-wrapped so the CORS middleware can add its headers.
export async function openIntentStream(env: Env, sid: string): Promise<Response> {
  const stub = env.INTENT_STREAM!.get(env.INTENT_STREAM!.idFromName(sid));
  const res = await stub.fetch(`https://intent-stream/subscribe?sid=${encodeURIComponent(sid)}`);
  return new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
};

/// One instance per sid. Holds the open streams in memory; nothing durable.
export class IntentStream {
  private hub: StreamHub | null = null;
  private sid: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(_state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sid = url.searchParams.get('sid');
    if (!sid) return new Response('sid required', { status: 400 });
    if (!this.hub || this.sid !== sid) {
      this.sid = sid;
      this.hub = new StreamHub(() => loadStreamPayload(this.env, sid));
    }
    const hub = this.hub;

    if (url.pathname === '/poke') {
      await hub.refresh();
      this.stopHeartbeatIfIdle();
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/subscribe') {
      if (hub.full) {
        return new Response(JSON.stringify({ error: 'too_many_streams' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '30' },
        });
      }
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      let closed = false;
      const sink: Sink = {
        send: (text) => writer.write(enc.encode(text)),
        close: () => {
          if (closed) return;
          closed = true;
          writer.close().catch(() => {});
        },
      };
      if (!(await getIntent(this.env, sid))) {
        return new Response(JSON.stringify({ error: 'intent_not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Return the stream FIRST and write the snapshot after: a write into a
      // TransformStream nobody reads yet waits on backpressure, so awaiting
      // it before returning the Response would deadlock the request.
      void hub
        .subscribe(sink)
        .then(() => {
          setTimeout(() => hub.drop(sink), MAX_STREAM_MS);
          this.startHeartbeat();
        })
        .catch((e) => {
          console.warn(`intent stream subscribe ${sid}: ${(e as Error).message}`);
          sink.close();
        });
      return new Response(readable, { status: 200, headers: SSE_HEADERS });
    }

    return new Response('not found', { status: 404 });
  }

  private startHeartbeat(): void {
    if (this.heartbeat || !this.hub || this.hub.size === 0) return;
    this.heartbeat = setInterval(() => {
      const hub = this.hub;
      if (!hub) return;
      void hub
        .ping()
        .then(() => hub.refresh())
        .catch((e) => console.warn(`intent stream heartbeat: ${(e as Error).message}`))
        .finally(() => this.stopHeartbeatIfIdle());
    }, HEARTBEAT_MS);
  }

  private stopHeartbeatIfIdle(): void {
    if (this.heartbeat && (!this.hub || this.hub.size === 0)) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
