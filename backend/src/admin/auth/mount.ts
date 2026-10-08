// /admin prijava — isti model kao bank-push-gateway (docs/admin.md tamo,
// docs/admin-auth.md ovdje). Zamjenjuje Basic Auth.
//
// Dva puta ulaska, jedna sesija:
//   1. passkey (WebAuthn, discoverable, userVerification: required)
//   2. Cloudflare Access na /admin/sso — OTP na e-mail, samo e-mailovi iz
//      Access politike; Worker dodatno provjerava JWT (potpis, issuer, AUD)
//      i da je e-mail u ADMIN_EMAILS
// Prvi passkey se upisuje nakon ulaska preko Accessa; Access je ujedno oporavak
// (nema break-glass tokena ni lozinke).

import type { Context, Hono } from 'hono';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

import type { Env } from '../../types';
import { renderLoginPage, renderPasskeysPage } from '../views';
import { verifyAccessJwt } from './access';
import { accessConfigured, adminEmails } from './env';
import { loginOptions, registrationOptions, verifyLogin, verifyRegistration } from './passkey';
import {
  createSession,
  deleteSession,
  getSession,
  readCookie,
  safeNext,
  SESSION_TTL_SECONDS,
  sessionCookie,
  type Session,
} from './session';
import { PASSKEY_JS } from './static';

type AppEnv = { Bindings: Env; Variables: { adminSession: Session } };
type Ctx = Context<AppEnv>;

const PUBLIC_PATHS = new Set([
  '/admin/login',
  '/admin/sso',
  '/admin/passkey/login/options',
  '/admin/passkey/login/verify',
  '/admin/static/passkey.js',
  // Odjava bez (važeće) sesije samo vodi na prijavu umjesto sirovog 401.
  '/admin/logout',
]);

const isAdminPath = (path: string) => path === '/admin' || path.startsWith('/admin/');

/// Sesija prijavljenog admina, ili null izvan /admin.
export function adminSession(c: Context): Session | null {
  return (c.get('adminSession') as Session | undefined) ?? null;
}

/// Mora se pozvati PRIJE registracije ijedne /admin rute.
export function mountAdminAuth(app: Hono<{ Bindings: Env }>): void {
  const a = app as unknown as Hono<AppEnv>;

  // 1. Jedan host za admin. rpID passkeya = hostname, pa bi passkey upisan na
  //    jednom hostu bio beskoristan na drugom; Access aplikacija štiti samo
  //    ADMIN_HOST/admin/sso.
  a.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    const host = (c.env.ADMIN_HOST ?? '').trim();
    if (!isAdminPath(url.pathname) || !host || url.hostname === host || isLocal(url.hostname)) return next();
    if (c.req.method !== 'GET') return c.json({ error: 'wrong_admin_host', admin_host: host }, 421);
    return c.redirect(`https://${host}${url.pathname}${url.search}`, 301);
  });

  // 2. Sigurnosna zaglavlja. Stari admin ekrani imaju inline <script> blokove:
  //    dobivaju nonce, pa CSP i dalje ne pušta ubačene skripte ni inline
  //    handlere (onclick=…).
  a.use('*', async (c, next) => {
    if (!isAdminPath(new URL(c.req.url).pathname)) return next();
    await next();
    const nonce = randomNonce();
    const h = c.res.headers;
    if ((h.get('content-type') ?? '').startsWith('text/html')) {
      const html = await c.res.text();
      c.res = new Response(html.replace(/<script(?![^>]*\bsrc=)/g, `<script nonce="${nonce}"`), c.res);
    }
    const out = c.res.headers;
    out.set(
      'content-security-policy',
      `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    );
    out.set('x-content-type-options', 'nosniff');
    // Ne "no-referrer": uz nju preglednik na <form> POST šalje `Origin: null`
    // i CSRF provjera ispod odbije vlastitu odjavu.
    out.set('referrer-policy', 'same-origin');
    out.set('x-frame-options', 'DENY');
    if (!out.has('cache-control')) out.set('cache-control', 'no-store');
  });

  // 3. CSRF: svaka promjena mora doći s istog origina (kolačić je SameSite=Lax).
  a.use('*', async (c, next) => {
    if (!isAdminPath(new URL(c.req.url).pathname)) return next();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if (!origin || origin !== new URL(c.req.url).origin) return c.json({ error: 'bad_origin' }, 403);
    }
    await next();
  });

  // 4. Sesija: sve pod /admin osim javnih putanja.
  a.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (!isAdminPath(url.pathname) || PUBLIC_PATHS.has(url.pathname)) return next();
    const session = await getSession(c.env, c.req.header('cookie') ?? null);
    if (!session) {
      if (c.req.method !== 'GET' || url.pathname.startsWith('/admin/api/')) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      return c.redirect(`/admin/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
    }
    c.set('adminSession', session);
    await next();
  });

  a.get('/admin/static/passkey.js', (c) =>
    c.body(PASSKEY_JS, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300',
    }),
  );

  a.get('/admin/login', async (c) => {
    const next = safeNext(c.req.query('next'));
    if (await getSession(c.env, c.req.header('cookie') ?? null)) return c.redirect(next, 302);
    const error = c.req.query('error') === 'access' ? 'Access prijava nije prihvaćena za ovaj admin.' : undefined;
    return c.html(renderLoginPage({ next, error, accessConfigured: accessConfigured(c.env) }));
  });

  // Access na rubu štiti samo ovu putanju. Ovdje se JWT pretvara u našu sesiju.
  a.get('/admin/sso', async (c) => {
    if (!accessConfigured(c.env)) return c.text('Cloudflare Access nije konfiguriran.', 503);
    const token =
      c.req.header('cf-access-jwt-assertion') ?? readCookie(c.req.header('cookie') ?? null, 'CF_Authorization');
    const claims = token
      ? await verifyAccessJwt(token, { teamDomain: c.env.ACCESS_TEAM_DOMAIN!, aud: c.env.ACCESS_AUD! })
      : null;
    if (!claims || !adminEmails(c.env).has(claims.email)) {
      console.warn(JSON.stringify({ msg: 'access_login_rejected', email: claims?.email ?? null }));
      return c.redirect('/admin/login?error=access', 302);
    }
    return startSession(c, claims.email, 'access', safeNext(c.req.query('next')));
  });

  a.post('/admin/passkey/login/options', async (c) => c.json(await loginOptions(c.env, new URL(c.req.url))));

  a.post('/admin/passkey/login/verify', async (c) => {
    const body = await c.req.json<{ response?: AuthenticationResponseJSON; next?: string }>().catch(() => null);
    if (!body?.response?.id) return c.json({ error: 'bad_request' }, 400);
    const email = await verifyLogin(c.env, new URL(c.req.url), body.response);
    if (!email) return c.json({ error: 'prijava nije uspjela' }, 401);
    return startSession(c, email, 'passkey', safeNext(body.next), true);
  });

  a.post('/admin/passkey/register/options', async (c) =>
    c.json(await registrationOptions(c.env, new URL(c.req.url), c.get('adminSession').email)),
  );

  a.post('/admin/passkey/register/verify', async (c) => {
    const body = await c.req.json<{ response?: RegistrationResponseJSON; label?: string }>().catch(() => null);
    if (!body?.response?.id) return c.json({ error: 'bad_request' }, 400);
    const ok = await verifyRegistration(
      c.env, new URL(c.req.url), c.get('adminSession').email, body.response, (body.label ?? '').trim(),
    );
    return ok ? c.json({ ok: true }) : c.json({ error: 'upis nije uspio' }, 400);
  });

  a.get('/admin/passkeys', async (c) => {
    const email = c.get('adminSession').email;
    const r = await c.env.DB.prepare(
      'SELECT id, label, created_at, last_used_at FROM admin_passkeys WHERE email = ? ORDER BY created_at',
    ).bind(email).all<{ id: string; label: string; created_at: string; last_used_at: string | null }>();
    return c.html(renderPasskeysPage({ email, passkeys: r.results }));
  });

  a.post('/admin/passkeys/:id/delete', async (c) => {
    await c.env.DB.prepare('DELETE FROM admin_passkeys WHERE id = ? AND email = ?')
      .bind(c.req.param('id'), c.get('adminSession').email)
      .run();
    return c.redirect('/admin/passkeys', 303);
  });

  a.post('/admin/logout', async (c) => {
    await deleteSession(c.env, c.req.header('cookie') ?? null);
    c.header('set-cookie', sessionCookie('', 0));
    return c.redirect('/admin/login', 303);
  });
}

async function startSession(c: Ctx, email: string, method: 'passkey' | 'access', next: string, asJson = false) {
  const token = await createSession(c.env, email, method, c.req.header('user-agent') ?? null);
  c.header('set-cookie', sessionCookie(token, SESSION_TTL_SECONDS));
  return asJson ? c.json({ ok: true, next }) : c.redirect(next, 302);
}

function randomNonce(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, '');
}

/// wrangler dev: admin radi na localhostu bez preusmjeravanja (WebAuthn
/// dopušta localhost kao rpID).
function isLocal(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

