/// Open Graph link-preview fetcher. Runs on the Cloudflare worker (public-only
/// egress — the Workers runtime blocks fetch to private/link-local/metadata, so
/// this is SSRF-isolated, unlike the Supabase edge which sits on our docker net).
/// Called server-to-server by domovina-api `pinka-webhook` after a contribution
/// with a message URL is PAID ("pay-to-post" — only real, paid messages fetch).

export type OgPreview = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  siteName: string | null;
};

const MAX_BYTES = 262_144; // 256KB — OG tags live in <head>, stop early anyway
const TIMEOUT_MS = 4_000;

/** Reject non-http(s) and obvious internal hosts (defense-in-depth; CF already
 * blocks private egress). */
function safeUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '0.0.0.0' ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    h.endsWith('.internal') ||
    h.endsWith('.local')
  ) {
    return null;
  }
  return u;
}

export async function fetchOgPreview(rawUrl: string): Promise<OgPreview | null> {
  const u = safeUrl(rawUrl);
  if (!u) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let html = '';
  try {
    const res = await fetch(u.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': 'pinka.finance link-preview bot' },
    });
    if (!res.ok || !res.body) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) return null;
    html = await readCapped(res.body, MAX_BYTES);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }

  const head = sliceHead(html);
  const title = meta(head, 'og:title') ?? meta(head, 'twitter:title') ?? titleTag(head);
  const description =
    meta(head, 'og:description') ?? meta(head, 'twitter:description') ?? meta(head, 'description');
  const image = httpsOnly(meta(head, 'og:image') ?? meta(head, 'twitter:image'), u);
  const siteName = meta(head, 'og:site_name');

  if (!title && !description) return null; // nothing useful

  return {
    url: u.toString(),
    title: cap(title, 200),
    description: cap(description, 300),
    image, // stored but the wall doesn't render remote images in v1 (IP-leak)
    siteName: cap(siteName ?? u.hostname, 80),
  };
}

async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c.subarray(0, Math.min(c.length, maxBytes - off)), off);
    off += c.length;
    if (off >= maxBytes) break;
  }
  return new TextDecoder().decode(buf);
}

function sliceHead(html: string): string {
  const i = html.search(/<\/head>/i);
  return i >= 0 ? html.slice(0, i) : html.slice(0, 65_536);
}

function meta(head: string, key: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRe(key)}["'][^>]*>`, 'i');
  const tag = head.match(re)?.[0];
  if (!tag) return null;
  const c = tag.match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() || null : null;
}

function titleTag(head: string): string | null {
  const m = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() || null : null;
}

function httpsOnly(img: string | null, base: URL): string | null {
  if (!img) return null;
  try {
    const u = new URL(img, base);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function cap(s: string | null, n: number): string | null {
  if (!s) return null;
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ');
}
