import type { Env } from '../types';
import { addCampaign, addPayoutAddress, getCampaign, writeAudit } from './db';

/// One project of a tenant: campaign row + payout whitelist + audit. Used by
/// POST …/campaigns (an existing Safe) and POST …/projects (ADR 0027, a Safe
/// made and linked to Monerium on the setup page).

export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const ID_RE = /^[A-Za-z0-9_-]{2,64}$/;

export type CampaignResult =
  | { ok: true; campaignId: string; safeAddress: string }
  | { ok: false; error: 'invalid_campaign_id' | 'invalid_safe_address' | 'campaign_owned_by_other_tenant' };

/// BW-24: a campaign id belongs to one tenant for good.
export async function campaignIdFree(env: Env, tenantId: string, campaignId: string): Promise<boolean> {
  const existing = await getCampaign(env, campaignId);
  return !existing || existing.tenant_id === tenantId;
}

export async function registerCampaign(
  env: Env,
  args: { tenantId: string; campaignId: string; safeAddress: string; label: string | null; actor: string; action?: string; detail?: Record<string, unknown> },
): Promise<CampaignResult> {
  const { tenantId, campaignId, safeAddress, label, actor } = args;
  if (!ID_RE.test(campaignId)) return { ok: false, error: 'invalid_campaign_id' };
  if (!ADDR_RE.test(safeAddress)) return { ok: false, error: 'invalid_safe_address' };
  if (!(await campaignIdFree(env, tenantId, campaignId))) return { ok: false, error: 'campaign_owned_by_other_tenant' };
  await addCampaign(env, { tenantId, campaignId, safeAddress, label, actor });
  // A campaign Safe is a payout destination — register it on the whitelist
  // too, so the `cmp:` binding and the whitelist can never disagree.
  await addPayoutAddress(env, {
    tenantId,
    address: safeAddress,
    label: `campaign ${campaignId}${label ? ` — ${label}` : ''}`,
    actor,
  });
  await writeAudit(env, {
    tenantId,
    action: args.action ?? 'campaign.add',
    address: safeAddress.toLowerCase(),
    actor,
    detail: JSON.stringify({ campaign_id: campaignId, label, ...(args.detail ?? {}) }),
  });
  return { ok: true, campaignId, safeAddress: safeAddress.toLowerCase() };
}
