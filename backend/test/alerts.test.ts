import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendAlert, trySendAlert } from '../src/alerts';
import type { Env } from '../src/types';

/// Alerting is fail-open: a broken channel must never break a forward. That
/// makes silent breakage the real risk, so `trySendAlert` has to report the
/// truth precisely — it is what the admin alert-test endpoint renders.

const CONFIGURED = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '-5296807694' } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<Response> | Response): () => unknown[][] {
  const calls: unknown[][] = [];
  vi.stubGlobal('fetch', (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(impl());
  });
  return () => calls;
}

describe('trySendAlert', () => {
  it('reports not-configured without touching the network', async () => {
    const calls = stubFetch(() => new Response('{}'));
    expect(await trySendAlert({} as Env, 'x')).toEqual({ configured: false, ok: false });
    expect(await trySendAlert({ TELEGRAM_BOT_TOKEN: '123:abc' } as Env, 'x'))
      .toEqual({ configured: false, ok: false });
    expect(calls()).toHaveLength(0);
  });

  it('posts to the Telegram sendMessage endpoint with HTML parse mode', async () => {
    const calls = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const r = await trySendAlert(CONFIGURED, '<b>test</b>');
    expect(r).toEqual({ configured: true, ok: true, status: 200 });

    const [url, init] = calls()[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      chat_id: '-5296807694',
      text: '<b>test</b>',
      parse_mode: 'HTML',
    });
  });

  it('surfaces Telegram’s description — this is how a stale chat id shows up', async () => {
    // The exact failure after a group → supergroup migration changes the id.
    stubFetch(() => new Response('{"ok":false,"description":"Bad Request: chat not found"}', { status: 400 }));
    const r = await trySendAlert(CONFIGURED, 'x');
    expect(r).toEqual({
      configured: true, ok: false, status: 400,
      error: 'Bad Request: chat not found',
    });
  });

  it('still reports a status when the error body is not JSON', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));
    const r = await trySendAlert(CONFIGURED, 'x');
    expect(r.configured).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
  });

  it('reports a thrown network error instead of propagating it', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('connect ECONNREFUSED')));
    const r = await trySendAlert(CONFIGURED, 'x');
    expect(r).toEqual({ configured: true, ok: false, error: 'connect ECONNREFUSED' });
  });

  it('never leaks the bot token into the reported error', async () => {
    stubFetch(() => new Response('{"ok":false,"description":"Unauthorized"}', { status: 401 }));
    const r = await trySendAlert(CONFIGURED, 'x');
    expect(JSON.stringify(r)).not.toContain('123:abc');
  });
});

describe('sendAlert — the money-path wrapper', () => {
  it('never throws when the channel is down', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('down')));
    await expect(sendAlert(CONFIGURED, 'forward blocked')).resolves.toBeUndefined();
  });

  it('never throws when alerting is not configured', async () => {
    await expect(sendAlert({} as Env, 'forward blocked')).resolves.toBeUndefined();
  });
});
