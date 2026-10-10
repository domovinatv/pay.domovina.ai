import { type AppCreds, appByClientId, appsForShop } from './apps';
import { decryptSecret, encryptSecret } from './crypto';
import { getShop, now, saveInstall } from './db';
import type { Env } from './types';

export const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
const ORDER_GID_RE = /^gid:\/\/shopify\/Order\/\d+$/;

export function isOrderGid(s: string): boolean {
  return ORDER_GID_RE.test(s);
}

interface TokenResponse {
  access_token: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
}

/// Authorization-code grant. `expiring=1` asks for an expiring offline token
/// with a refresh token — required for new public apps; harmless otherwise.
export async function exchangeCode(env: Env, app: AppCreds, shop: string, code: string): Promise<void> {
  const res = await tokenRequest(shop, {
    client_id: app.clientId,
    client_secret: app.secret,
    code,
    expiring: '1',
  });
  await storeTokens(env, app.clientId, shop, res);
}

async function tokenRequest(shop: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`shopify token endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json<TokenResponse>();
}

async function storeTokens(env: Env, clientId: string, shop: string, t: TokenResponse): Promise<void> {
  const ts = now();
  await saveInstall(env, shop, clientId, {
    accessEnc: await encryptSecret(env.TOKEN_KEK, t.access_token),
    accessExpiresAt: t.expires_in ? ts + t.expires_in : null,
    refreshEnc: t.refresh_token ? await encryptSecret(env.TOKEN_KEK, t.refresh_token) : null,
    refreshExpiresAt: t.refresh_token_expires_in ? ts + t.refresh_token_expires_in : null,
    scope: t.scope,
  });
}

/// A usable offline token for the shop, refreshed when it is about to expire.
export async function accessToken(env: Env, shop: string): Promise<string> {
  const row = await getShop(env, shop);
  if (!row?.access_token_enc) throw new Error('shop_not_installed');
  if (row.access_expires_at === null || row.access_expires_at > now() + 120) {
    return decryptSecret(env.TOKEN_KEK, row.access_token_enc);
  }
  if (!row.refresh_token_enc) throw new Error('access_token_expired_without_refresh_token');
  // The refresh token belongs to the app that installed the shop.
  const app = row.client_id ? await appByClientId(env, row.client_id) : ((await appsForShop(env, shop))[0] ?? null);
  if (!app) throw new Error('shopify_app_not_registered');
  const refreshed = await tokenRequest(shop, {
    client_id: app.clientId,
    client_secret: app.secret,
    grant_type: 'refresh_token',
    refresh_token: await decryptSecret(env.TOKEN_KEK, row.refresh_token_enc),
  });
  await storeTokens(env, app.clientId, shop, refreshed);
  return refreshed.access_token;
}

export class ShopifyUserError extends Error {}

export async function adminGraphql<T>(env: Env, shop: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await accessToken(env, shop);
  const res = await fetch(`https://${shop}/admin/api/${env.SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shopify-access-token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`shopify admin ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json<{ data?: T; errors?: unknown }>();
  if (json.errors) throw new Error(`shopify graphql: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data as T;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  canMarkAsPaid: boolean;
  paymentGatewayNames: string[];
  totalOutstandingSet: { shopMoney: { amount: string; currencyCode: string } };
  createdAt?: string | null;
  customer?: { id: string } | null;
}

export async function fetchOrder(env: Env, shop: string, orderGid: string): Promise<ShopifyOrder | null> {
  const data = await adminGraphql<{ order: ShopifyOrder | null }>(
    env,
    shop,
    `query MptOrder($id: ID!) {
       order(id: $id) {
         id name createdAt cancelledAt displayFinancialStatus canMarkAsPaid paymentGatewayNames
         customer { id }
         totalOutstandingSet { shopMoney { amount currencyCode } }
       }
     }`,
    { id: orderGid },
  );
  return data.order;
}

function throwUserErrors(errors: { message: string }[] | undefined, op: string): void {
  if (errors && errors.length > 0) {
    throw new ShopifyUserError(`${op}: ${errors.map((e) => e.message).join('; ')}`);
  }
}

export async function markOrderPaid(env: Env, shop: string, orderGid: string): Promise<void> {
  const data = await adminGraphql<{ orderMarkAsPaid: { userErrors: { message: string }[] } }>(
    env,
    shop,
    `mutation MptMarkPaid($input: OrderMarkAsPaidInput!) {
       orderMarkAsPaid(input: $input) { userErrors { field message } }
     }`,
    { input: { id: orderGid } },
  );
  throwUserErrors(data.orderMarkAsPaid.userErrors, 'orderMarkAsPaid');
}

export async function addOrderTags(env: Env, shop: string, orderGid: string, tags: string[]): Promise<void> {
  const data = await adminGraphql<{ tagsAdd: { userErrors: { message: string }[] } }>(
    env,
    shop,
    `mutation MptTags($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
     }`,
    { id: orderGid, tags },
  );
  throwUserErrors(data.tagsAdd.userErrors, 'tagsAdd');
}

/// Proof of payment on the order, visible to the merchant in admin.
export async function setPaymentMetafields(
  env: Env,
  shop: string,
  orderGid: string,
  f: { sid: string; txHash: string | null; receivedCents: number | null },
): Promise<void> {
  const fields: { key: string; type: string; value: string }[] = [{ key: 'sid', type: 'single_line_text_field', value: f.sid }];
  if (f.txHash) {
    fields.push({ key: 'tx_hash', type: 'single_line_text_field', value: f.txHash });
    fields.push({ key: 'tx_url', type: 'url', value: `https://gnosisscan.io/tx/${f.txHash}` });
  }
  if (f.receivedCents !== null) {
    fields.push({ key: 'amount_received', type: 'single_line_text_field', value: (f.receivedCents / 100).toFixed(2) + ' EUR' });
  }
  const data = await adminGraphql<{ metafieldsSet: { userErrors: { message: string }[] } }>(
    env,
    shop,
    `mutation MptMeta($metafields: [MetafieldsSetInput!]!) {
       metafieldsSet(metafields: $metafields) { userErrors { field message } }
     }`,
    { metafields: fields.map((m) => ({ ownerId: orderGid, namespace: 'mpt', ...m })) },
  );
  throwUserErrors(data.metafieldsSet.userErrors, 'metafieldsSet');
}

export async function cancelOrder(env: Env, shop: string, orderGid: string, staffNote: string): Promise<void> {
  const data = await adminGraphql<{ orderCancel: { orderCancelUserErrors: { message: string }[] } }>(
    env,
    shop,
    `mutation MptCancel($orderId: ID!, $staffNote: String) {
       orderCancel(orderId: $orderId, reason: CUSTOMER, restock: true, notifyCustomer: true, staffNote: $staffNote) {
         job { id }
         orderCancelUserErrors { field message code }
       }
     }`,
    { orderId: orderGid, staffNote: staffNote.slice(0, 255) },
  );
  throwUserErrors(data.orderCancel.orderCancelUserErrors, 'orderCancel');
}

/// Shopify money string ("12.30") → integer cents, exact (no float math).
export function moneyToCents(amount: string): number | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
