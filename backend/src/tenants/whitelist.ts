import type { Env } from '../types';
import type { RoutingTarget } from '../monerium/sid';
import { getCampaign, getTenant, isAddressWhitelisted } from './db';
import { getIntent } from '../intents/db';

/// THE enforcement point. Every code path that could move EURe out of the MPT
/// Safe must run through `authorizeForward` and act only on its verdict —
/// there is deliberately no second place where a destination is approved.
///
/// Two independent conditions must BOTH hold before value moves (ADR 0016):
///
///   1. binding   — the address parsed out of the SEPA remittance must equal a
///                  destination we authorised beforehand:
///                    `mpt:` → payment_intents.target_address for that sid
///                    `cmp:` → tenant_campaigns.safe_address for that id
///                  This alone kills reference injection: without a prior
///                  authenticated API call there is nothing to bind to.
///   2. whitelist — that address must be an active payout address of the
///                  tenant owning the intent/campaign.
///
/// Anything else → `park`, with a machine-readable reason. Parking never
/// loses money: the EURe simply stays in the Safe and is reconciled by hand.

/// Reasons are stable strings — they end up in monerium_forwards.error, the
/// admin UI, the outbound `forward.blocked` webhook and the alert text.
export type ParkReason =
  | 'no_routing_target'   // memo carried no address at all
  | 'unroutable_prefix'   // bare 0x / gnosis: — no longer a routing instruction
  | 'missing_sid'         // mpt: without a session id
  | 'missing_campaign_id' // cmp: without a campaign id
  | 'unknown_sid'         // sid names no intent we ever created
  | 'unknown_campaign'    // campaign id is not registered
  | 'target_mismatch'     // memo address ≠ the authorised destination
  | 'tenant_suspended'
  | 'tenant_unknown'
  | 'not_whitelisted';    // bound correctly, but address is not on the list

export type ForwardDecision =
  | { action: 'forward'; tenantId: string; reason?: undefined }
  | { action: 'self_noop'; tenantId: string; reason?: undefined }
  | { action: 'park'; tenantId: string | null; reason: ParkReason };

/// Injected lookups — keeps the decision unit-testable without D1
/// (same philosophy as ConfirmDeps in ../intents/confirm.ts).
export interface AuthorizeDeps {
  getIntentBySid(sid: string): Promise<{ target_address: string; tenant_id: string | null } | null>;
  getCampaignById(
    campaignId: string,
  ): Promise<{ tenant_id: string; safe_address: string } | null>;
  getTenantStatus(tenantId: string): Promise<'active' | 'suspended' | null>;
  isWhitelisted(tenantId: string, address: string): Promise<boolean>;
  /// MPT main-rail Safe. A memo pointing here is the "fund the Safe" no-op —
  /// no value leaves, so it needs binding but no payout permission.
  safeAddress: string | null;
  /// Tenant assumed for intents created before tenants existed (tenant_id NULL).
  defaultTenantId: string;
}

export function makeAuthorizeDeps(env: Env): AuthorizeDeps {
  return {
    getIntentBySid: async (sid) => {
      const row = await getIntent(env, sid);
      return row ? { target_address: row.target_address, tenant_id: row.tenant_id ?? null } : null;
    },
    getCampaignById: async (campaignId) => {
      const row = await getCampaign(env, campaignId);
      return row ? { tenant_id: row.tenant_id, safe_address: row.safe_address } : null;
    },
    getTenantStatus: async (tenantId) => {
      const t = await getTenant(env, tenantId);
      return t ? t.status : null;
    },
    isWhitelisted: (tenantId, address) => isAddressWhitelisted(env, tenantId, address),
    safeAddress: env.SAFE_ADDRESS || null,
    defaultTenantId: defaultTenantId(env),
  };
}

export function defaultTenantId(env: Env): string {
  return (env.DEFAULT_TENANT_ID || '').trim() || 'italk';
}

function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function authorizeForward(
  deps: AuthorizeDeps,
  routing: RoutingTarget,
): Promise<ForwardDecision> {
  // The parser only fills `target` for routing prefixes it trusts (mpt:/cmp:).
  // A bare 0x / gnosis: memo leaves target null but sets diagnosticTarget, so
  // we can tell "no address at all" from "address we refuse to route on".
  if (!routing.target) {
    return {
      action: 'park',
      tenantId: null,
      reason: routing.diagnosticTarget ? 'unroutable_prefix' : 'no_routing_target',
    };
  }

  // --- 1. binding: resolve the destination we authorised in advance ---
  let tenantId: string;
  let authorizedTarget: string;

  if (routing.prefix === 'cmp') {
    if (!routing.campaignId) return { action: 'park', tenantId: null, reason: 'missing_campaign_id' };
    const campaign = await deps.getCampaignById(routing.campaignId);
    if (!campaign) return { action: 'park', tenantId: null, reason: 'unknown_campaign' };
    tenantId = campaign.tenant_id;
    authorizedTarget = campaign.safe_address;
  } else if (routing.prefix === 'mpt') {
    if (!routing.sid) return { action: 'park', tenantId: null, reason: 'missing_sid' };
    const intent = await deps.getIntentBySid(routing.sid);
    if (!intent) return { action: 'park', tenantId: null, reason: 'unknown_sid' };
    tenantId = intent.tenant_id ?? deps.defaultTenantId;
    authorizedTarget = intent.target_address;
  } else {
    // Defensive: the parser should never hand us a target under any other
    // prefix. If it ever does, refuse rather than guess.
    return { action: 'park', tenantId: null, reason: 'unroutable_prefix' };
  }

  if (!eq(routing.target, authorizedTarget)) {
    return { action: 'park', tenantId, reason: 'target_mismatch' };
  }

  const status = await deps.getTenantStatus(tenantId);
  if (status === null) return { action: 'park', tenantId, reason: 'tenant_unknown' };
  if (status !== 'active') return { action: 'park', tenantId, reason: 'tenant_suspended' };

  // Memo points at the Safe itself: "fund the Safe" deposit. Value never
  // leaves, so no payout permission is needed — but the binding above still
  // had to hold, otherwise an unbound memo could flip somebody's intent paid.
  if (eq(routing.target, deps.safeAddress)) {
    return { action: 'self_noop', tenantId };
  }

  // --- 2. whitelist ---
  if (!(await deps.isWhitelisted(tenantId, routing.target))) {
    return { action: 'park', tenantId, reason: 'not_whitelisted' };
  }
  return { action: 'forward', tenantId };
}

/// Human-readable one-liner for alerts and the admin UI.
export function describeParkReason(reason: ParkReason): string {
  switch (reason) {
    case 'no_routing_target': return 'memo bez adrese';
    case 'unroutable_prefix': return 'memo bez mpt:/cmp: prefiksa (goli 0x ili gnosis:)';
    case 'missing_sid': return 'mpt: bez sid-a';
    case 'missing_campaign_id': return 'cmp: bez id-a kampanje';
    case 'unknown_sid': return 'sid ne odgovara nijednom intentu';
    case 'unknown_campaign': return 'kampanja nije registrirana';
    case 'target_mismatch': return 'adresa iz memo-a ≠ autorizirano odredište';
    case 'tenant_suspended': return 'tenant je suspendiran';
    case 'tenant_unknown': return 'tenant ne postoji';
    case 'not_whitelisted': return 'adresa nije na whitelisti tenanta';
  }
}
