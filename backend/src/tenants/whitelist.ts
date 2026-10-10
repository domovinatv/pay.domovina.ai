import type { Env } from '../types';
import type { RoutingTarget } from '../monerium/sid';
import { getCampaign, getTenant, isAddressWhitelisted } from './db';
import { getIntent } from '../intents/db';
import type { TenantRail } from './rail';

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
  | 'not_whitelisted'     // bound correctly, but address is not on the list
  // ADR 0017 — multi-tenant rail:
  | 'tenant_mismatch'     // intent/campaign belongs to another tenant than
                          // the one whose IBAN (webhook) received the money
  | 'mint_address_mismatch' // Monerium minted somewhere else than the Safe
                          // this tenant forwards from — moving value out of
                          // that Safe would spend money this order never brought
  | 'over_cap';           // above the tenant's per-forward cap

export type ForwardDecision =
  | { action: 'forward'; tenantId: string; reason?: undefined }
  | { action: 'self_noop'; tenantId: string; reason?: undefined }
  | { action: 'park'; tenantId: string | null; reason: ParkReason };

/// Injected lookups — keeps the decision unit-testable without D1
/// (same philosophy as ConfirmDeps in ../intents/confirm.ts).
export interface AuthorizeDeps {
  /// state / amount / monerium_order_id are for the operator reroute check
  /// (SR-02) — authorizeForward itself only uses target and tenant.
  getIntentBySid(sid: string): Promise<{
    target_address: string;
    tenant_id: string | null;
    state?: string;
    amount_cents?: number;
    monerium_order_id?: string | null;
  } | null>;
  getCampaignById(
    campaignId: string,
  ): Promise<{ tenant_id: string; safe_address: string } | null>;
  getTenantStatus(tenantId: string): Promise<'active' | 'suspended' | 'onboarding' | null>;
  isWhitelisted(tenantId: string, address: string): Promise<boolean>;
  /// MPT main-rail Safe. A memo pointing here is the "fund the Safe" no-op —
  /// no value leaves, so it needs binding but no payout permission.
  safeAddress: string | null;
  /// Tenant assumed for intents created before tenants existed (tenant_id NULL).
  defaultTenantId: string;
  /// Tenant whose Monerium account (signed webhook) received the money. An
  /// intent/campaign of any other tenant is refused (ADR 0017).
  railTenantId: string;
  /// Non-null for tenant rails: the order must have been minted to exactly
  /// this address (the Safe forwards are signed from). Null for the legacy
  /// ITalk rail, whose behaviour stays as it was.
  requireMintAt: string | null;
  /// Per-forward cap in cents, STRICT (amount must be below it, matching the
  /// on-chain LessThan); null = none.
  maxForwardCents: number | null;
}

/// Facts about the order itself (as opposed to its routing memo).
export interface OrderFacts {
  mintAddress: string | null;
  amountCents: number | null;
}

export function makeAuthorizeDeps(env: Env, rail: TenantRail): AuthorizeDeps {
  return {
    getIntentBySid: async (sid) => {
      const row = await getIntent(env, sid);
      return row
        ? {
            target_address: row.target_address,
            tenant_id: row.tenant_id ?? null,
            state: row.state,
            amount_cents: row.amount_cents,
            monerium_order_id: row.monerium_order_id,
          }
        : null;
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
    safeAddress: rail.receivingSafe,
    defaultTenantId: defaultTenantId(env),
    railTenantId: rail.tenantId,
    // MT-03: ITalk too, behind a flag for one deploy cycle (pre-check
    // 2026-10-10: every ITalk issue order since the Safe exists minted there).
    requireMintAt: rail.legacy && env.LEGACY_REQUIRE_MINT_AT !== '1' ? null : rail.receivingSafe,
    maxForwardCents: rail.maxForwardCents,
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
  facts?: OrderFacts,
): Promise<ForwardDecision> {
  // Tenant rails only: the money must actually be in the Safe we would sign
  // from. Missing facts count as a mismatch (fail-closed).
  if (deps.requireMintAt && !eq(facts?.mintAddress, deps.requireMintAt)) {
    return { action: 'park', tenantId: deps.railTenantId, reason: 'mint_address_mismatch' };
  }

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

  // Money that landed on tenant X's IBAN may only ever settle tenant X's
  // intents/campaigns — never another tenant's, whatever the memo says.
  if (tenantId !== deps.railTenantId) {
    return { action: 'park', tenantId, reason: 'tenant_mismatch' };
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

  // Strict, like the on-chain `LessThan` in safe-tx/007: an amount equal to
  // the cap would revert on-chain, so it parks here instead.
  if (deps.maxForwardCents !== null) {
    const cents = facts?.amountCents ?? null;
    if (cents === null || cents >= deps.maxForwardCents) {
      return { action: 'park', tenantId, reason: 'over_cap' };
    }
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
    case 'tenant_mismatch': return 'intent/kampanja pripada drugom tenantu nego IBAN na koji je novac stigao';
    case 'mint_address_mismatch': return 'Monerium nije mintao na prihvatni Safe tenanta';
    case 'over_cap': return 'iznos je iznad kapice po forwardu za tenanta';
  }
}
