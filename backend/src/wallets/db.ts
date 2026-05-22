import type { Env } from '../types';

export interface WalletRow {
  credential_id: string;
  pub_key_x: string;
  pub_key_y: string;
  signer_address: string;
  safe_address: string;
  phone_hash: string | null;
  rp_id: string;
  user_agent: string | null;
  created_at: number;
  phone_bound_at: number | null;
}

export interface RegisterWalletArgs {
  credentialId: string;
  pubKeyX: string;
  pubKeyY: string;
  signerAddress: string;
  safeAddress: string;
  rpId: string;
  userAgent?: string | null;
}

export async function registerWallet(env: Env, args: RegisterWalletArgs): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO wallet_registry
       (credential_id, pub_key_x, pub_key_y, signer_address, safe_address,
        phone_hash, rp_id, user_agent, created_at, phone_bound_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)`,
  )
    .bind(
      args.credentialId,
      args.pubKeyX,
      args.pubKeyY,
      args.signerAddress.toLowerCase(),
      args.safeAddress.toLowerCase(),
      args.rpId,
      (args.userAgent ?? null)?.slice(0, 255) ?? null,
      now,
    )
    .run();
}

export async function getWalletByCredentialId(
  env: Env,
  credentialId: string,
): Promise<WalletRow | null> {
  const row = await env.DB.prepare(
    `SELECT * FROM wallet_registry WHERE credential_id = ?`,
  )
    .bind(credentialId)
    .first<WalletRow>();
  return row ?? null;
}

export async function getWalletsByPhoneHash(
  env: Env,
  phoneHash: string,
): Promise<WalletRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM wallet_registry WHERE phone_hash = ? ORDER BY created_at DESC`,
  )
    .bind(phoneHash)
    .all<WalletRow>();
  return res.results ?? [];
}

/// Legacy convenience: keeps `wallet_registry.phone_hash` and `phone_bound_at`
/// in sync as a denormalized "latest phone bound to this wallet" cache for
/// admin UI rendering and the `has_phone` boolean. The source of truth for
/// per-phone history is `wallet_phone_bindings` — see `upsertPhoneBinding`.
export async function bindPhone(
  env: Env,
  credentialId: string,
  phoneHash: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.DB.prepare(
    `UPDATE wallet_registry
        SET phone_hash = ?, phone_bound_at = ?
      WHERE credential_id = ?`,
  )
    .bind(phoneHash, now, credentialId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/// Upsert a (credential_id, phone_hash) row in wallet_phone_bindings.
/// If the pair exists: bump verification_count and refresh latest_verified_at.
/// If new: insert with count=1 and both timestamps = now.
/// This is the source of truth for "phones this wallet has verified."
export async function upsertPhoneBinding(
  env: Env,
  credentialId: string,
  phoneHash: string,
): Promise<{ isNewPhone: boolean; verificationCount: number; firstBoundAt: number; latestVerifiedAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await env.DB.prepare(
    `SELECT first_bound_at, verification_count FROM wallet_phone_bindings
      WHERE credential_id = ? AND phone_hash = ?`,
  )
    .bind(credentialId, phoneHash)
    .first<{ first_bound_at: number; verification_count: number }>();

  if (existing) {
    const nextCount = existing.verification_count + 1;
    await env.DB.prepare(
      `UPDATE wallet_phone_bindings
          SET verification_count = ?, latest_verified_at = ?
        WHERE credential_id = ? AND phone_hash = ?`,
    )
      .bind(nextCount, now, credentialId, phoneHash)
      .run();
    return {
      isNewPhone: false,
      verificationCount: nextCount,
      firstBoundAt: existing.first_bound_at,
      latestVerifiedAt: now,
    };
  }

  await env.DB.prepare(
    `INSERT INTO wallet_phone_bindings
       (credential_id, phone_hash, first_bound_at, latest_verified_at, verification_count)
     VALUES (?, ?, ?, ?, 1)`,
  )
    .bind(credentialId, phoneHash, now, now)
    .run();
  return { isNewPhone: true, verificationCount: 1, firstBoundAt: now, latestVerifiedAt: now };
}

export interface PhoneBindingRow {
  phone_hash: string;
  first_bound_at: number;
  latest_verified_at: number;
  verification_count: number;
}

export async function listPhoneBindingsForCredential(
  env: Env,
  credentialId: string,
): Promise<PhoneBindingRow[]> {
  const res = await env.DB.prepare(
    `SELECT phone_hash, first_bound_at, latest_verified_at, verification_count
       FROM wallet_phone_bindings
      WHERE credential_id = ?
      ORDER BY first_bound_at ASC`,
  )
    .bind(credentialId)
    .all<PhoneBindingRow>();
  return res.results ?? [];
}

/// "Are any of this wallet's phones shared with another wallet?" — used for
/// the admin sybil flag in the wallets list. Returns the count of OTHER
/// wallets that share at least one phone hash with this one.
export async function countSybilNeighbors(
  env: Env,
  credentialId: string,
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(DISTINCT b2.credential_id) AS c
       FROM wallet_phone_bindings b1
       JOIN wallet_phone_bindings b2 ON b1.phone_hash = b2.phone_hash
      WHERE b1.credential_id = ? AND b2.credential_id != ?`,
  )
    .bind(credentialId, credentialId)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface SybilCluster {
  phone_hash: string;
  wallet_count: number;
  first_bound_at: number;
  latest_verified_at: number;
}

/// Admin sybil dashboard: phone hashes held by 2+ wallets, with metadata.
export async function listSybilClusters(
  env: Env,
  args: { limit: number; offset: number },
): Promise<SybilCluster[]> {
  const res = await env.DB.prepare(
    `SELECT
        phone_hash,
        COUNT(*) AS wallet_count,
        MIN(first_bound_at) AS first_bound_at,
        MAX(latest_verified_at) AS latest_verified_at
       FROM wallet_phone_bindings
      GROUP BY phone_hash
      HAVING COUNT(*) > 1
      ORDER BY wallet_count DESC, latest_verified_at DESC
      LIMIT ? OFFSET ?`,
  )
    .bind(args.limit, args.offset)
    .all<SybilCluster>();
  return res.results ?? [];
}

/// List of wallets sharing a given phone hash (for sybil cluster drill-down).
export async function listWalletsSharingPhone(
  env: Env,
  phoneHash: string,
): Promise<{ credential_id: string; first_bound_at: number; latest_verified_at: number; verification_count: number }[]> {
  const res = await env.DB.prepare(
    `SELECT credential_id, first_bound_at, latest_verified_at, verification_count
       FROM wallet_phone_bindings
      WHERE phone_hash = ?
      ORDER BY first_bound_at ASC`,
  )
    .bind(phoneHash)
    .all<{ credential_id: string; first_bound_at: number; latest_verified_at: number; verification_count: number }>();
  return res.results ?? [];
}

export interface ListWalletsArgs {
  limit: number;
  offset: number;
}

export async function listWallets(env: Env, args: ListWalletsArgs): Promise<WalletRow[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM wallet_registry ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(args.limit, args.offset)
    .all<WalletRow>();
  return res.results ?? [];
}

export async function countWallets(
  env: Env,
): Promise<{ total: number; withPhone: number }> {
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM wallet_registry`,
  ).first<{ c: number }>();
  const withPhone = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM wallet_registry WHERE phone_hash IS NOT NULL`,
  ).first<{ c: number }>();
  return { total: total?.c ?? 0, withPhone: withPhone?.c ?? 0 };
}

/// Replay protection. Each otp.domovina.ai verification id can only be
/// consumed once across our wallet endpoints. Inserts atomically; returns
/// false if the id was already consumed.
///
/// `credentialId` populates the lookup chain to otp.domovina.ai for the
/// raw phone (see ADR 0001 `docs/decisions/0001-no-server-side-recovery.md`).
/// `wallet_register` callers pass null since they happen before any wallet
/// row exists; `wallet_bind_phone` and `wallet_reverify` pass the binding
/// wallet's credentialId so we can later send SMS notifications.
export async function markOtpConsumed(
  env: Env,
  args: {
    verificationId: string;
    purpose: string;
    consumedFor: 'wallet_register' | 'wallet_bind_phone' | 'wallet_reverify' | 'wallet_recovery';
    credentialId?: string | null;
  },
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(
      `INSERT INTO otp_consumed (verification_id, purpose, consumed_at, consumed_for, credential_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(args.verificationId, args.purpose, now, args.consumedFor, args.credentialId ?? null)
      .run();
    return true;
  } catch {
    // PK collision = already consumed.
    return false;
  }
}

/// Latest OTP verification consumed by a given wallet. Used by future SMS
/// notification flows: take its verification_id, GET otp.domovina.ai for
/// the raw phone, hand off to the SMS gateway.
export async function getLatestOtpForCredential(
  env: Env,
  credentialId: string,
): Promise<{ verification_id: string; consumed_at: number; consumed_for: string } | null> {
  const row = await env.DB.prepare(
    `SELECT verification_id, consumed_at, consumed_for
       FROM otp_consumed
      WHERE credential_id = ?
      ORDER BY consumed_at DESC
      LIMIT 1`,
  )
    .bind(credentialId)
    .first<{ verification_id: string; consumed_at: number; consumed_for: string }>();
  return row ?? null;
}

/// Per-wallet verification history stats. Backbone of the sybil-resistance
/// reputation signal targeted by [[project-phase5-onchain-attestation]]:
/// callers care about *frequency* and *age*, not the binding itself.
/// Counts ALL phone-related verifications (`wallet_bind_phone` +
/// `wallet_reverify`), regardless of whether they ended up writing onchain.
export async function getVerificationStats(
  env: Env,
  credentialId: string,
): Promise<{ count: number; first_at: number | null; latest_at: number | null }> {
  const row = await env.DB.prepare(
    `SELECT
        COUNT(*) AS c,
        MIN(consumed_at) AS first_at,
        MAX(consumed_at) AS latest_at
       FROM otp_consumed
      WHERE credential_id = ?
        AND consumed_for IN ('wallet_bind_phone', 'wallet_reverify')`,
  )
    .bind(credentialId)
    .first<{ c: number; first_at: number | null; latest_at: number | null }>();
  return {
    count: row?.c ?? 0,
    first_at: row?.first_at ?? null,
    latest_at: row?.latest_at ?? null,
  };
}
