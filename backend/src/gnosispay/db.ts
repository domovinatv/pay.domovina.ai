import type { Env } from '../types';

export interface GpUserRow {
  credential_id: string;
  safe_address: string;
  gp_user_id: string | null;
  gp_signer: string;
  gp_safe_address: string | null;
  onboarding_step: string;
  kyc_status: string | null;
  webhook_opt_in: number;
  created_at: number;
  updated_at: number;
}

export interface GpSyncInput {
  credentialId: string;
  safeAddress: string;
  gpUserId?: string | null;
  gpSigner: string;
  gpSafeAddress?: string | null;
  onboardingStep: string;
  kycStatus?: string | null;
}

/// Idempotentni mirror onboarding stanja — FE ga šalje na svaki refresh taba
/// Kartica. gp_signer se NIKAD ne mijenja nakon prvog upisa (GP vezanje adrese
/// je nepovratno; promjena bi značila bug na FE strani — čuvamo prvu).
export async function upsertGpUser(env: Env, input: GpSyncInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO gp_users
       (credential_id, safe_address, gp_user_id, gp_signer, gp_safe_address,
        onboarding_step, kyc_status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
     ON CONFLICT (credential_id, safe_address) DO UPDATE SET
       gp_user_id      = COALESCE(excluded.gp_user_id, gp_users.gp_user_id),
       gp_safe_address = COALESCE(excluded.gp_safe_address, gp_users.gp_safe_address),
       onboarding_step = excluded.onboarding_step,
       kyc_status      = COALESCE(excluded.kyc_status, gp_users.kyc_status),
       updated_at      = excluded.updated_at`,
  )
    .bind(
      input.credentialId,
      input.safeAddress.toLowerCase(),
      input.gpUserId ?? null,
      input.gpSigner.toLowerCase(),
      input.gpSafeAddress?.toLowerCase() ?? null,
      input.onboardingStep,
      input.kycStatus ?? null,
      now,
    )
    .run();
}

export async function getGpUser(
  env: Env,
  credentialId: string,
  safeAddress: string,
): Promise<GpUserRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM gp_users WHERE credential_id = ?1 AND safe_address = ?2`,
  )
    .bind(credentialId, safeAddress.toLowerCase())
    .first<GpUserRow>();
  return row ?? null;
}
