import type { Env } from '../types';
import type {
  MoneriumOrder,
  MoneriumProfile,
  MoneriumTokenResponse,
} from './types';

const TOKEN_KEY = 'monerium:access_token';

/// Monerium uses a custom Accept header to select API version. v2 is required
/// for `/profiles`, `/orders`, `/webhooks` and the modern shape used by the
/// official @monerium/sdk. Without it the API falls back to v1 and returns
/// 404 for these paths.
const API_ACCEPT = 'application/vnd.monerium.api-v2+json';

interface MoneriumAuthContext {
  userId?: string;
  profile?: string;
  defaultProfile?: string;
  profiles?: { id: string; name?: string; kind?: string }[];
  [k: string]: unknown;
}

export interface MoneriumWebhookSubscription {
  id: string;
  url?: string;
  kind?: string;
  state?: string;
  [k: string]: unknown;
}

/// Fetches an OAuth2 client_credentials access token and caches it in KV
/// for slightly less than its declared TTL.
async function getAccessToken(env: Env): Promise<string> {
  const cached = await env.TOKEN_CACHE.get(TOKEN_KEY);
  if (cached) return cached;
  if (!env.MONERIUM_CLIENT_ID || !env.MONERIUM_CLIENT_SECRET) {
    throw new Error(
      'Monerium credentials missing: set MONERIUM_CLIENT_ID and MONERIUM_CLIENT_SECRET',
    );
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.MONERIUM_CLIENT_ID,
    client_secret: env.MONERIUM_CLIENT_SECRET,
  });
  const res = await fetch(`${env.MONERIUM_BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: API_ACCEPT,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Monerium /auth/token → ${res.status}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as MoneriumTokenResponse;
  const ttl = Math.max(60, json.expires_in - 60);
  await env.TOKEN_CACHE.put(TOKEN_KEY, json.access_token, {
    expirationTtl: ttl,
  });
  return json.access_token;
}

export class MoneriumClient {
  constructor(private env: Env) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getAccessToken(this.env);
    const res = await fetch(`${this.env.MONERIUM_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: API_ACCEPT,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(
        `Monerium ${path} → ${res.status}: ${await res.text()}`,
      );
    }
    return (await res.json()) as T;
  }

  async getAuthContext(): Promise<MoneriumAuthContext> {
    return this.call<MoneriumAuthContext>('/auth/context');
  }

  async listProfiles(): Promise<MoneriumProfile[]> {
    return this.call<MoneriumProfile[]>('/profiles');
  }

  /// Picks the profile to operate on. Order of resolution:
  ///   1. MONERIUM_PROFILE_ID env override
  ///   2. /auth/context default profile (what the access token is scoped to)
  ///   3. first profile from /profiles list
  async resolveProfileId(): Promise<string> {
    if (this.env.MONERIUM_PROFILE_ID) return this.env.MONERIUM_PROFILE_ID;
    try {
      const ctx = await this.getAuthContext();
      const fromCtx =
        ctx.defaultProfile ?? ctx.profile ?? ctx.profiles?.[0]?.id;
      if (fromCtx) return fromCtx;
    } catch {
      // Fall through to /profiles
    }
    const profiles = await this.listProfiles();
    if (profiles.length === 0) {
      throw new Error('Monerium: no profiles available for this app');
    }
    return profiles[0].id;
  }

  async listOrders(profileId?: string): Promise<MoneriumOrder[]> {
    const pid = profileId ?? (await this.resolveProfileId());
    /// Monerium v2 wraps the array in `{ orders: [...] }`. Unwrap defensively
    /// so callers always get an array regardless of any future shape change.
    const res = await this.call<{ orders?: MoneriumOrder[] } | MoneriumOrder[]>(
      `/orders?profile=${encodeURIComponent(pid)}`,
    );
    if (Array.isArray(res)) return res;
    return res.orders ?? [];
  }

  async getOrder(orderId: string): Promise<MoneriumOrder> {
    return this.call<MoneriumOrder>(`/orders/${orderId}`);
  }

  async listWebhookSubscriptions(): Promise<MoneriumWebhookSubscription[]> {
    return this.call<MoneriumWebhookSubscription[]>('/webhooks');
  }

  /// Registers a webhook URL with Monerium and ensures the `types` are what
  /// we requested. Implementation note (verified empirically 2026-05-04):
  ///
  ///   • `POST /webhooks` SILENTLY substitutes our `types` with default
  ///     `["iban.updated", "profile.updated"]`, regardless of what we send.
  ///   • `PATCH /webhooks/{id}` honours `types` — but NOT `secret`.
  ///   • There is no DELETE endpoint; rotate by creating a new subscription
  ///     at a different URL (e.g. via query param) and disabling the old.
  ///
  /// So we POST to register + secret, then immediately PATCH to set types.
  /// `secret` must be `whsec_<base64-32-bytes>` per Standard Webhooks spec.
  async createWebhookSubscription(args: {
    url: string;
    types?: string[];
    secret?: string;
  }): Promise<MoneriumWebhookSubscription> {
    const types = args.types ?? ['order.created', 'order.updated'];
    const created = await this.call<MoneriumWebhookSubscription>('/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        url: args.url,
        types,
        ...(args.secret ? { secret: args.secret } : {}),
      }),
    });
    // Workaround: POST silently dropped our types. PATCH to apply them.
    return this.call<MoneriumWebhookSubscription>(`/webhooks/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ types }),
    });
  }

  /// Disables a webhook subscription (no DELETE endpoint exists).
  async disableWebhookSubscription(
    id: string,
  ): Promise<MoneriumWebhookSubscription> {
    return this.call<MoneriumWebhookSubscription>(`/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'inactive' }),
    });
  }
}
