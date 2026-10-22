/// Edge cache for public, unauthenticated reads (ADR 0030). Every open
/// project page polls these endpoints; without a cache every poll would be a
/// query on the one D1 database that also settles payments (or a call to a
/// third-party chain API). A Worker response is not cached by the CDN on its
/// own — the Worker runs in front of the cache — so bodies go through the
/// Cache API: fresh for FRESH_S, then served stale up to STALE_S while one
/// refresh per isolate runs in the background.

export const FRESH_S = 10;
export const STALE_S = 60;
const AT_HEADER = 'x-cached-at';

export interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface EdgeCacheDeps {
  cache: EdgeCache | null;
  waitUntil(p: Promise<unknown>): void;
  now(): number;
  /// Asked only on a cold miss, the one path that reaches the backend. A cold
  /// miss for a real page is rare (an entry stays usable for STALE_S), so
  /// this bounds what random keys can cost without touching real viewers —
  /// who may share one IP behind a fair's NAT.
  allowMiss(): Promise<boolean>;
}

export class MissLimited extends Error {}

/// In-flight loads per isolate: concurrent cold misses share one backend call.
const inflight = new Map<string, Promise<string>>();

function refresh(deps: EdgeCacheDeps, key: Request, load: () => Promise<string>): Promise<string> {
  let p = inflight.get(key.url);
  if (!p) {
    p = (async () => {
      const body = await load();
      if (deps.cache) {
        await deps.cache.put(key, new Response(body, {
          headers: {
            'content-type': 'application/json',
            'cache-control': `public, max-age=${STALE_S}`,
            [AT_HEADER]: String(deps.now()),
          },
        }));
      }
      return body;
    })().finally(() => inflight.delete(key.url));
    inflight.set(key.url, p);
  }
  return p;
}

/// Body for `keyUrl`. The cached entry is a bare body, so CORS headers are
/// always those of the current request. Throws MissLimited on a refused miss.
export async function edgeCached(deps: EdgeCacheDeps, keyUrl: string, load: () => Promise<string>): Promise<string> {
  const key = new Request(keyUrl);
  const hit = deps.cache ? await deps.cache.match(key) : undefined;
  if (!hit) {
    if (!(await deps.allowMiss())) throw new MissLimited();
    return refresh(deps, key, load);
  }
  const at = Number(hit.headers.get(AT_HEADER));
  if (!(deps.now() - at < FRESH_S * 1000)) {
    deps.waitUntil(refresh(deps, key, load).catch(() => undefined));
  }
  return hit.text();
}

/// Workers glue: `caches.default` and the PUBLIC_READ_LIMITER binding keyed by
/// client IP. Without either (tests, local dev) the cache is off and misses pass.
export function workerEdgeDeps(env: { PUBLIC_READ_LIMITER?: RateLimit }, req: Request, ctx: { waitUntil(p: Promise<unknown>): void }): EdgeCacheDeps {
  return {
    cache: typeof caches === 'undefined' ? null : caches.default,
    waitUntil: (p) => ctx.waitUntil(p),
    now: () => Date.now(),
    allowMiss: async () => {
      if (!env.PUBLIC_READ_LIMITER) return true;
      const key = req.headers.get('cf-connecting-ip') ?? 'unknown';
      return (await env.PUBLIC_READ_LIMITER.limit({ key })).success;
    },
  };
}
