/// Javni hostovi pod *.mpt.hr (ADR 0021).
///
/// Jedan Worker servira sve hostove. Legacy hostovi (`mpt.domovina.ai`,
/// `monerium.domovina.ai`) i svi hostovi kojih nema u `HOST_POLICY` (localhost,
/// testovi, workers.dev) rade točno kao prije: bez ograničenja putanja (P1, P4)
/// i s linkovima iz origina zahtjeva (P3).
import type { Context, Next } from 'hono';

import type { Env } from './types';

export const LEGACY_HOSTS: ReadonlySet<string> = new Set(['mpt.domovina.ai', 'monerium.domovina.ai']);

const INTENT_SID_PATH = /^\/(api|v1)\/intents\/[^/]+(\/.*)?$/;

/// Koje putanje smije servirati koji novi host (P4). `/admin*` ovdje nije
/// naveden namjerno: mountAdminAuth GET preusmjerava na ADMIN_HOST, a ostale
/// metode odbija s 421.
export const HOST_POLICY: Readonly<Record<string, (path: string) => boolean>> = {
  'api.mpt.hr': (p) => p === '/' || p.startsWith('/v1/') || p.startsWith('/api/'),
  'pay.mpt.hr': (p) =>
    p === '/' || p.startsWith('/checkout/') || p.startsWith('/potvrda/') || INTENT_SID_PATH.test(p),
};

/// Ime hosta kojemu putanja pripada, za poruku u 404 odgovoru.
function rightHostFor(path: string): string {
  if (path.startsWith('/checkout/') || path.startsWith('/potvrda/')) return 'pay.mpt.hr';
  return 'api.mpt.hr';
}

export async function hostPolicyMiddleware(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  const url = new URL(c.req.url);
  const host = url.hostname;
  const path = c.req.path;
  // Strukturirani log hosta i prefiksa (P12): koliko prometa još ide na legacy.
  const prefix = path.startsWith('/v1/') ? 'v1' : path.startsWith('/api/') ? 'api' : path.split('/')[1] || 'root';
  console.log(JSON.stringify({ msg: 'req_host', host, prefix, legacy: LEGACY_HOSTS.has(host) }));

  const allow = HOST_POLICY[host];
  if (!allow || allow(path) || path === '/admin' || path.startsWith('/admin/')) return next();
  return c.json({ error: 'wrong_host', host: rightHostFor(path) }, 404);
}

/// Baze za linkove u odgovoru intenta (P3). `api` uključuje prefiks putanje
/// (`/api` ili `/v1`), `checkout` je origin na kojem živi `/checkout/:sid`.
export interface LinkBases {
  api: string;
  checkout: string;
}

export function linkBases(env: Pick<Env, 'PUBLIC_CHECKOUT_BASE'>, requestUrl: string): LinkBases {
  const url = new URL(requestUrl);
  const prefix = url.pathname.startsWith('/v1/') ? '/v1' : '/api';
  const checkoutBase = env.PUBLIC_CHECKOUT_BASE?.trim().replace(/\/+$/, '');
  // PUBLIC_CHECKOUT_BASE vrijedi samo na novim hostovima; legacy i lokalni
  // odgovori ostaju bajt-identični.
  const checkout = checkoutBase && url.hostname in HOST_POLICY ? checkoutBase : url.origin;
  return { api: `${url.origin}${prefix}`, checkout };
}

export function toLinkBases(origin: string | LinkBases): LinkBases {
  return typeof origin === 'string' ? { api: `${origin}/api`, checkout: origin } : origin;
}

/// Bazni URL za Monerium webhook pretplate (P6): PUBLIC_API_BASE ako je
/// postavljen, inače origin zahtjeva (kao prije).
export function publicApiBase(env: Pick<Env, 'PUBLIC_API_BASE'>, fallbackOrigin: string): string {
  return env.PUBLIC_API_BASE?.trim().replace(/\/+$/, '') || fallbackOrigin;
}
