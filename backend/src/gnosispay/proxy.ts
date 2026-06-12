import { Hono } from 'hono';

import type { Env } from '../types';

/// Gnosis Pay API proxy — opcija 2 (zaobilaženje browser CORS-a prije partner
/// registracije). Naš Worker zove api.gnosispay.com server-to-server i samo
/// provlači zahtjev + tuđi user JWT. Browser ↔ naš Worker ima CORS (globalni
/// middleware), Worker ↔ GP nema (nije browser) — pa CORS prepreka nestaje.
///
/// Self-custody netaknut: potpisivanje (passkey/ERC-1271) ostaje na klijentu;
/// ovdje prolazi SAMO korisnikov vlastiti bearer token, nikad server-held ključ.
///
/// Empirijski (Faza 0): GP WAF 403-a Node/undici TLS fingerprint, ali propušta
/// browser-like headere. Ovdje šaljemo iste headere; otvoreno pitanje je hoće
/// li GP WAF propustiti CF Workers fetch egress — to ovaj proxy i testira.
///
/// Pure passthrough: sve iza /api/gp-proxy ide doslovno na api.gnosispay.com
/// (FE klijent već šalje pune /api/v1/... putanje).
/// Mount: app.route('/api/gp-proxy', buildGnosisPayProxy())
///   FE: VITE_GP_API_BASE=https://mpt.domovina.ai/api/gp-proxy

const GP_ORIGIN = 'https://api.gnosispay.com';
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export function buildGnosisPayProxy(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.all('/*', async (c) => {
    // Sve iza /api/gp-proxy ide doslovno na GP (rest već uključuje /api/v1/...).
    const rest = c.req.path.replace(/^.*\/api\/gp-proxy/, '');
    const url = `${GP_ORIGIN}${rest}${new URL(c.req.url).search}`;

    const headers: Record<string, string> = {
      'User-Agent': BROWSER_UA,
      Origin: 'http://localhost:5173',
      Referer: 'http://localhost:5173/',
      Accept: 'application/json',
    };
    const auth = c.req.header('Authorization');
    if (auth) headers.Authorization = auth;
    const ct = c.req.header('Content-Type');
    if (ct) headers['Content-Type'] = ct;

    const method = c.req.method;
    const body =
      method === 'GET' || method === 'HEAD' ? undefined : await c.req.text();

    const gpRes = await fetch(url, { method, headers, body });
    const text = await gpRes.text();
    // Provuci status + body; CORS header za browser dodaje globalni middleware.
    return new Response(text, {
      status: gpRes.status,
      headers: {
        'Content-Type': gpRes.headers.get('Content-Type') ?? 'application/json',
      },
    });
  });

  return api;
}
