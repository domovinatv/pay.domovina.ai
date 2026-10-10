import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';

import worker from '../src/index';
import type { Env } from '../src/types';
import { verifyAccessJwt } from '../src/admin/auth/access';
import { safeNext } from '../src/admin/auth/session';

const HOST = 'https://mpt.domovina.ai';
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

/// D1 stub: answers the admin session lookup only when `session` is given.
function env(session?: { email: string }, over: Partial<Env> = {}): Env {
  const exec = (q: string) => ({
    first: async () =>
      q.includes('FROM admin_sessions') && session
        ? { email: session.email, method: 'passkey', expires_at: '2999-01-01T00:00:00Z' }
        : null,
    all: async () => ({ results: [] }),
    run: async () => ({ meta: { changes: 1 } }),
  });
  return {
    DB: { prepare: (q: string) => ({ bind: () => exec(q), ...exec(q) }), batch: async () => [] },
    ADMIN_EMAILS: 'ops@domovina.ai',
    ADMIN_HOST: 'mpt.domovina.ai',
    ACCESS_TEAM_DOMAIN: 'domovina.cloudflareaccess.com',
    ACCESS_AUD: 'aud-123',
    ALLOWED_ORIGINS: HOST,
    ...over,
  } as unknown as Env;
}

const req = (path: string, init: RequestInit & { cookie?: boolean } = {}, base = HOST) => {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', '__Host-mpt_admin=tok');
  return new Request(base + path, { ...init, headers, redirect: 'manual' });
};

describe('/admin — no session', () => {
  it('a page redirects to login and keeps where you were going', async () => {
    const res = await worker.fetch(req('/admin/forwards?status=failed'), env(), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login?next=%2Fadmin%2Fforwards%3Fstatus%3Dfailed');
  });

  it('the JSON API answers 401, not a redirect', async () => {
    const res = await worker.fetch(req('/admin/api/forwards'), env(), ctx);
    expect(res.status).toBe(401);
  });

  it('Basic Auth credentials are no longer a way in', async () => {
    const res = await worker.fetch(
      req('/admin/api/forwards', { headers: { authorization: 'Basic ' + btoa('u:p') } }), env(), ctx,
    );
    expect(res.status).toBe(401);
  });

  it('the login page is public and offers both ways in', async () => {
    const res = await worker.fetch(req('/admin/login'), env(), ctx);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="passkey-login"');
    expect(html).toContain('/admin/sso?next=');
  });
});

describe('/admin — with session', () => {
  it('a valid session opens the dashboard', async () => {
    const res = await worker.fetch(req('/admin/forwards', { cookie: true }), env({ email: 'ops@domovina.ai' }), ctx);
    expect(res.status).toBe(200);
  });

  it('an e-mail removed from ADMIN_EMAILS loses access immediately', async () => {
    const res = await worker.fetch(req('/admin/api/forwards', { cookie: true }), env({ email: 'former@domovina.ai' }), ctx);
    expect(res.status).toBe(401);
  });

  it('changes need the same Origin (CSRF)', async () => {
    const e = env({ email: 'ops@domovina.ai' });
    const noOrigin = await worker.fetch(req('/admin/api/outbox/x/resend', { method: 'POST', cookie: true }), e, ctx);
    expect(noOrigin.status).toBe(403);
    const foreign = await worker.fetch(
      req('/admin/api/outbox/x/resend', { method: 'POST', cookie: true, headers: { origin: 'https://evil.example' } }), e, ctx,
    );
    expect(foreign.status).toBe(403);
  });
});

describe('/admin — headers and host', () => {
  it('inline scripts get a per-response nonce that the CSP names', async () => {
    const res = await worker.fetch(req('/admin/forwards', { cookie: true }), env({ email: 'ops@domovina.ai' }), ctx);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toContain('onclick=');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('the other hostname redirects GETs to ADMIN_HOST and refuses writes', async () => {
    const e = env();
    const get = await worker.fetch(req('/admin/forwards', {}, 'https://monerium.domovina.ai'), e, ctx);
    expect(get.status).toBe(301);
    expect(get.headers.get('location')).toBe('https://mpt.domovina.ai/admin/forwards');
    const post = await worker.fetch(
      req('/admin/logout', { method: 'POST', headers: { origin: 'https://monerium.domovina.ai' } }, 'https://monerium.domovina.ai'), e, ctx,
    );
    expect(post.status).toBe(421);
  });

  it('the Monerium webhook host keeps working outside /admin', async () => {
    const res = await worker.fetch(req('/api/intents/nepostojeci1', {}, 'https://monerium.domovina.ai'), env(), ctx);
    expect(res.status).not.toBe(301);
  });
});

describe('/admin/sso — Cloudflare Access', () => {
  it('without an Access JWT goes back to login with an error', async () => {
    const res = await worker.fetch(req('/admin/sso'), env(), ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/login?error=access');
  });

  it('503 when Access is not configured (no silent open door)', async () => {
    const res = await worker.fetch(req('/admin/sso'), env(undefined, { ACCESS_AUD: '' }), ctx);
    expect(res.status).toBe(503);
  });
});

describe('verifyAccessJwt', () => {
  const opts = { teamDomain: 'domovina.cloudflareaccess.com', aud: 'aud-123' };
  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const keys = createLocalJWKSet({ keys: [jwk] });
    const sign = (claims: Record<string, unknown>, o: { iss?: string; aud?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(o.iss ?? 'https://domovina.cloudflareaccess.com')
        .setAudience(o.aud ?? 'aud-123')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { keys, sign };
  }

  it('accepts a correctly signed token and lowercases the e-mail', async () => {
    const { keys, sign } = await setup();
    expect(await verifyAccessJwt(await sign({ email: 'Ops@Domovina.ai' }), opts, keys)).toEqual({ email: 'ops@domovina.ai' });
  });

  it('rejects another Access application (AUD) and another team (issuer)', async () => {
    const { keys, sign } = await setup();
    expect(await verifyAccessJwt(await sign({ email: 'ops@domovina.ai' }, { aud: 'other-app' }), opts, keys)).toBeNull();
    expect(await verifyAccessJwt(await sign({ email: 'ops@domovina.ai' }, { iss: 'https://evil.cloudflareaccess.com' }), opts, keys)).toBeNull();
  });

  it('rejects a token signed with a foreign key', async () => {
    const { sign } = await setup();
    const { keys: otherKeys } = await setup();
    expect(await verifyAccessJwt(await sign({ email: 'ops@domovina.ai' }), opts, otherKeys)).toBeNull();
  });
});

describe('safeNext', () => {
  it('only allows relative /admin paths (no open redirect)', () => {
    expect(safeNext('/admin/forwards')).toBe('/admin/forwards');
    expect(safeNext('https://evil.example')).toBe('/admin');
    expect(safeNext('//evil.example/admin')).toBe('/admin');
    expect(safeNext('/admin\\@evil')).toBe('/admin');
    expect(safeNext(null)).toBe('/admin');
  });
});

describe('audit actor (AD-01)', () => {
  it('is the session e-mail, not a header the caller controls', async () => {
    const binds: Array<{ q: string; args: unknown[] }> = [];
    const exec = (q: string, args: unknown[] = []) => ({
      first: async () => {
        if (q.includes('FROM admin_sessions')) return { email: 'ops@domovina.ai', method: 'passkey', expires_at: '2999-01-01T00:00:00Z' };
        if (q.includes('FROM tenants')) return { id: 'italk', name: 'ITalk', status: 'active' };
        return null;
      },
      all: async () => ({ results: [] }),
      run: async () => { binds.push({ q, args }); return { meta: { changes: 1 } }; },
    });
    const e = env(undefined, {
      DB: {
        prepare: (q: string) => ({ bind: (...args: unknown[]) => exec(q, args), ...exec(q) }),
        batch: async () => [],
      } as unknown as Env['DB'],
    });
    const res = await worker.fetch(
      req('/admin/api/tenants/italk/addresses', {
        method: 'POST',
        cookie: true,
        headers: {
          origin: HOST,
          'content-type': 'application/json',
          authorization: 'Basic ' + btoa('attacker:x'),
        },
        body: JSON.stringify({ address: '0x' + 'ab'.repeat(20), label: 'test' }),
      }),
      e,
      ctx,
    );
    expect(res.status).toBe(200);
    const audit = binds.find((b) => b.q.includes('INSERT INTO tenant_audit_log'));
    expect(audit?.args[4]).toBe('ops@domovina.ai');
  });
});
