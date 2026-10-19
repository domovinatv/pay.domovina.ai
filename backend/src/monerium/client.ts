import type { Env } from '../types';
import type { MoneriumCreds } from '../tenants/rail';
import type {
  MoneriumOrder,
  MoneriumProfile,
  MoneriumTokenResponse,
} from './types';

/// Monerium uses a custom Accept header to select API version. v2 is required
/// for `/profiles`, `/orders`, `/webhooks` and the modern shape used by the
/// official @monerium/sdk. Without it the API falls back to v1 and returns
/// 404 for these paths.
const API_ACCEPT = 'application/vnd.monerium.api-v2+json';

export const MONERIUM_SANDBOX_API = 'https://api.monerium.dev';
/// Web UI endpoint behind "Simulate bank transfer"; see monerium/sandboxFund.ts.
export const SANDBOX_FUND_URL = 'https://sandbox.monerium.dev/api/treasury/fund';

interface MoneriumAuthContext {
  userId?: string;
  profile?: string;
  defaultProfile?: string;
  profiles?: { id: string; name?: string; kind?: string }[];
  [k: string]: unknown;
}

export interface MoneriumIban {
  iban: string;
  bic?: string;
  profile?: string;
  /// Address the IBAN mints to.
  address?: string;
  chain?: string;
  [k: string]: unknown;
}

export interface MoneriumAddress {
  address: string;
  profile?: string;
  chains?: string[];
  state?: string;
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
/// for slightly less than its declared TTL. The cache key is per tenant
/// (ADR 0017): ITalk keeps the historical `monerium:access_token`, every
/// other tenant gets `monerium:access_token:<tenant>`.
async function getAccessToken(env: Env, creds: MoneriumCreds): Promise<string> {
  const cached = await env.TOKEN_CACHE.get(creds.tokenCacheKey);
  if (cached) return cached;
  if (!creds.clientId || !creds.clientSecret) {
    throw new Error(
      'Monerium credentials missing: set MONERIUM_CLIENT_ID and MONERIUM_CLIENT_SECRET',
    );
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(`${creds.baseUrl}/auth/token`, {
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
  await env.TOKEN_CACHE.put(creds.tokenCacheKey, json.access_token, {
    expirationTtl: ttl,
  });
  return json.access_token;
}

export class MoneriumClient {
  private creds: MoneriumCreds;

  /// Acts on one tenant's own Monerium account (`TenantRail.monerium`).
  constructor(private env: Env, creds: MoneriumCreds) {
    this.creds = creds;
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const token = await getAccessToken(this.env, this.creds);
    const res = await fetch(`${this.creds.baseUrl}${path}`, {
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
  ///   1. configured profile (MONERIUM_PROFILE_ID for ITalk; always set for
  ///      other tenants — `tenant_rail.profile_id`)
  ///   2. /auth/context default profile (what the access token is scoped to)
  ///   3. first profile from /profiles list
  async resolveProfileId(): Promise<string> {
    if (this.creds.profileId) return this.creds.profileId;
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

  /// IBANs of a profile and the address each one mints to
  /// (`GET /ibans?profile=` → `{ ibans: [...] }`, SDK 4.2 `IBANsResponse`).
  async listIbans(profileId: string): Promise<MoneriumIban[]> {
    const res = await this.call<{ ibans?: MoneriumIban[] } | MoneriumIban[]>(
      `/ibans?profile=${encodeURIComponent(profileId)}`,
    );
    if (Array.isArray(res)) return res;
    return res.ibans ?? [];
  }

  /// Addresses linked to this app's profiles (`GET /addresses` → `{ addresses: [...] }`).
  async listAddresses(): Promise<MoneriumAddress[]> {
    const res = await this.call<{ addresses?: MoneriumAddress[] } | MoneriumAddress[]>('/addresses');
    if (Array.isArray(res)) return res;
    return res.addresses ?? [];
  }

  /// Links an address to a profile. A Safe that signed the message on chain
  /// (SignMessageLib, ADR 0027) sends signature "0x": Monerium checks it with
  /// ERC-1271 isValidSignature.
  async linkAddress(args: { profile: string; address: string; chain: string; message: string; signature: string }): Promise<MoneriumAddress> {
    return this.call<MoneriumAddress>('/addresses', { method: 'POST', body: JSON.stringify(args) });
  }

  /// Sandbox only: a simulated SEPA transfer into one of this profile's
  /// IBANs (see monerium/sandboxFund.ts). Never throws on an HTTP error, the
  /// caller reports Monerium's status.
  async sandboxFund(body: Record<string, unknown>): Promise<{ status: number; text: string }> {
    if (this.creds.baseUrl !== MONERIUM_SANDBOX_API) throw new Error('sandboxFund: not a Monerium sandbox rail');
    const token = await getAccessToken(this.env, this.creds);
    const res = await fetch(SANDBOX_FUND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: (await res.text()).slice(0, 500) };
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
    // Workaround: POST silently dropped our types. PATCH to apply them. If
    // the PATCH fails the subscription still EXISTS — return it flagged, so
    // the caller stores its id (MT-05) instead of losing track of it.
    try {
      return await this.call<MoneriumWebhookSubscription>(`/webhooks/${created.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ types }),
      });
    } catch (e) {
      console.error(`monerium webhook ${created.id}: PATCH types failed: ${(e as Error).message}`);
      return { ...created, typesApplied: false };
    }
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
