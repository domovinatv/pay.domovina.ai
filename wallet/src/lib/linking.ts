import type { Address, Hex } from 'viem';
import { brand } from '../app/brand';

/**
 * Browser detection for picking the cross-TLD linking bootstrap path.
 *
 * Safari (iOS + macOS) partitions iframe storage under ITP. A child iframe
 * embedded from a different TLD cannot reach its own first-party
 * `domovina.ai` storage (passkey registry, ACTIVE wallet) without first
 * calling `document.requestStorageAccess()` AT A USER GESTURE — and even
 * with that, the user sees a confusing "Allow access?" prompt that
 * frequently breaks the WebAuthn flow that follows. The redirect path
 * avoids all of this: tenant → wallet.domovina.ai (first-party,
 * everything works) → tenant via query-param return.
 *
 * Other browsers (Chrome/Edge/Firefox on desktop, Chrome/Edge on Android)
 * handle third-party iframe WebAuthn cleanly with `allow="publickey-
 * credentials-get publickey-credentials-create"` on the iframe element,
 * so the iframe path stays in-place and feels native.
 */
export function isSafariLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /Safari/i.test(ua) && !/Chrome|CriOS|FxiOS|Edg/i.test(ua);
}

/**
 * Master wallet domain. Tenants reach the linking authorize page at
 * `https://<masterDomain>/link`. Currently fixed to the default brand's
 * domain — if a partner ever runs their own master (custom IdP), this
 * becomes a per-tenant config field on BrandConfig.
 */
export const MASTER_WALLET_DOMAIN = 'wallet.domovina.ai';

/** URL-encoded payload the tenant passes to the master authorize page. */
export type LinkAuthorizeParams = {
  /** Address of the new WebAuthn signer the tenant just enrolled —
   * this is what the master Safe will add as a new owner. */
  newSigner: Address;
  /** The new credential id (hex, 0x-prefixed) so the master can register
   * it with the backend on the tenant's behalf. */
  newCredentialId: string;
  /** P-256 pubkey decimal x of the new passkey. */
  newPubKeyX: string;
  /** P-256 pubkey decimal y of the new passkey. */
  newPubKeyY: string;
  /** RP under which the new passkey was created (the tenant's RP). */
  newRpId: string;
  /** Optional human-readable label the tenant chose (keychainName) so
   * the master can render "Linking '<name>' to your Safe…". */
  newLabel?: string;
  /** Either 'postMessage' (iframe path) or 'redirect' (Safari path). */
  returnMode: 'postMessage' | 'redirect';
  /** For postMessage: the parent window origin the iframe should reply to. */
  parentOrigin?: string;
  /** For redirect: where the master should send the user back. */
  returnUrl?: string;
};

/** Build the master authorize URL the tenant opens (iframe src or
 * window.location.href). */
export function buildLinkAuthorizeUrl(params: LinkAuthorizeParams): string {
  const u = new URL(`https://${MASTER_WALLET_DOMAIN}/link`);
  u.searchParams.set('newSigner', params.newSigner);
  u.searchParams.set('newCredentialId', params.newCredentialId);
  u.searchParams.set('newPubKeyX', params.newPubKeyX);
  u.searchParams.set('newPubKeyY', params.newPubKeyY);
  u.searchParams.set('newRpId', params.newRpId);
  if (params.newLabel) u.searchParams.set('newLabel', params.newLabel);
  u.searchParams.set('returnMode', params.returnMode);
  if (params.parentOrigin) u.searchParams.set('parentOrigin', params.parentOrigin);
  if (params.returnUrl) u.searchParams.set('returnUrl', params.returnUrl);
  // Tenant brand identifier for the master UI to render context to the user
  // ("…on Župa Wallet (zupa.domovina.ai)?").
  u.searchParams.set('tenantBrand', brand.id);
  u.searchParams.set('tenantName', brand.name);
  return u.toString();
}

/** postMessage protocol — typed envelope for clarity. */
export type LinkMessage =
  | { type: 'link-ready' } // master → tenant: iframe loaded
  | { type: 'link-result'; safeAddress: Address; txHash: Hex } // master → tenant: addOwner mined
  | { type: 'link-error'; error: string }; // master → tenant: failed/cancelled

/** Discriminator the tenant uses to filter messages from arbitrary
 * unrelated postMessage traffic. */
export const LINK_MESSAGE_NAMESPACE = 'domovina-wallet-link';
export type NamespacedLinkMessage = LinkMessage & {
  ns: typeof LINK_MESSAGE_NAMESPACE;
};

/** Parse a raw message event payload into a LinkMessage, returning null
 * if it isn't ours. Guards against arbitrary postMessage spam in the
 * tenant's window. */
export function parseLinkMessage(data: unknown): LinkMessage | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (obj.ns !== LINK_MESSAGE_NAMESPACE) return null;
  if (typeof obj.type !== 'string') return null;
  if (obj.type === 'link-ready') return { type: 'link-ready' };
  if (
    obj.type === 'link-result' &&
    typeof obj.safeAddress === 'string' &&
    typeof obj.txHash === 'string'
  ) {
    return {
      type: 'link-result',
      safeAddress: obj.safeAddress as Address,
      txHash: obj.txHash as Hex,
    };
  }
  if (obj.type === 'link-error' && typeof obj.error === 'string') {
    return { type: 'link-error', error: obj.error };
  }
  return null;
}

/** Send a typed message from master → tenant. Always namespaces. */
export function postLinkMessage(target: Window, msg: LinkMessage, origin: string): void {
  const payload: NamespacedLinkMessage = { ...msg, ns: LINK_MESSAGE_NAMESPACE };
  target.postMessage(payload, origin);
}

/**
 * Pending-link state the tenant stashes in sessionStorage before
 * redirecting to the master authorize page. Survives the round-trip
 * because sessionStorage is scoped to the (tenant-origin × tab) so the
 * /link-callback handler can recover the new passkey's full record and
 * persist it locally after the master signs addOwner.
 *
 * NOT used in the iframe (postMessage) path — there the parent window
 * keeps the React state and the iframe just resolves a Promise.
 */
export type PendingLink = {
  credentialId: string;
  pubKeyX: string;
  pubKeyY: string;
  signerAddress: string;
  keychainName: string;
  rpId: string;
  /** Unix ms when stashed — used to expire stale entries (15 min). */
  stashedAt: number;
};

const PENDING_LINK_KEY = 'domovina_pending_link';
const PENDING_LINK_TTL_MS = 15 * 60 * 1000;

export function stashPendingLink(p: PendingLink): void {
  try {
    sessionStorage.setItem(PENDING_LINK_KEY, JSON.stringify(p));
  } catch (e) {
    console.warn('[linking] sessionStorage stash failed', e);
  }
}

export function consumePendingLink(): PendingLink | null {
  try {
    const raw = sessionStorage.getItem(PENDING_LINK_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_LINK_KEY);
    const parsed = JSON.parse(raw) as PendingLink;
    if (Date.now() - parsed.stashedAt > PENDING_LINK_TTL_MS) {
      console.warn('[linking] pending link expired, discarding');
      return null;
    }
    return parsed;
  } catch (e) {
    console.warn('[linking] sessionStorage consume failed', e);
    return null;
  }
}
