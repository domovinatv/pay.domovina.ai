import { Hono } from 'hono';

import type { Env } from '../types';
import {
  bindPhone,
  getVerificationStats,
  getWalletByCredentialId,
  markOtpConsumed,
  registerWallet,
} from './db';
import { fetchOtpVerification, hashPhone } from './otp';

/// Public wallet-registry API for wallet.domovina.ai.
///
/// - POST   /api/wallets                       — register a new wallet (no phone)
/// - GET    /api/wallets/:credentialId         — public lookup by credential id
/// - POST   /api/wallets/:credentialId/bind-phone — bind a phone via OTP verification
/// - GET    /api/admin/wallets                 — paginated list (Basic Auth)
/// - GET    /api/admin/wallets/count           — total + phone-bound counts (Basic Auth)
///
/// Mountable into the root Hono app via
///   app.route('/api/wallets', buildWalletApi())
///   app.route('/api/admin/wallets', buildWalletAdminApi())

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;
const BIGINT_RE = /^\d+$/;

interface RegisterBody {
  credentialId?: string;
  pubKeyX?: string;
  pubKeyY?: string;
  signerAddress?: string;
  safeAddress?: string;
  rpId?: string;
}

interface BindPhoneBody {
  otpVerificationId?: string;
}

export function buildWalletApi(): Hono<{ Bindings: Env }> {
  const api = new Hono<{ Bindings: Env }>();

  api.post('/', async (c) => {
    let body: RegisterBody;
    try {
      body = await c.req.json<RegisterBody>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!body.credentialId || !HEX_RE.test(body.credentialId)) {
      return c.json({ error: 'invalid_credential_id' }, 400);
    }
    if (!body.pubKeyX || !BIGINT_RE.test(body.pubKeyX)) {
      return c.json({ error: 'invalid_pub_key_x' }, 400);
    }
    if (!body.pubKeyY || !BIGINT_RE.test(body.pubKeyY)) {
      return c.json({ error: 'invalid_pub_key_y' }, 400);
    }
    if (!body.signerAddress || !ADDR_RE.test(body.signerAddress)) {
      return c.json({ error: 'invalid_signer_address' }, 400);
    }
    if (!body.safeAddress || !ADDR_RE.test(body.safeAddress)) {
      return c.json({ error: 'invalid_safe_address' }, 400);
    }
    if (!body.rpId || body.rpId.length > 253) {
      return c.json({ error: 'invalid_rp_id' }, 400);
    }
    await registerWallet(c.env, {
      credentialId: body.credentialId,
      pubKeyX: body.pubKeyX,
      pubKeyY: body.pubKeyY,
      signerAddress: body.signerAddress,
      safeAddress: body.safeAddress,
      rpId: body.rpId,
      userAgent: c.req.header('User-Agent') ?? null,
    });
    const row = await getWalletByCredentialId(c.env, body.credentialId);
    return c.json(publicWalletView(row));
  });

  api.get('/:credentialId', async (c) => {
    const credentialId = c.req.param('credentialId');
    if (!HEX_RE.test(credentialId)) return c.json({ error: 'invalid_credential_id' }, 400);
    const row = await getWalletByCredentialId(c.env, credentialId);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const stats = await getVerificationStats(c.env, credentialId);
    return c.json({ ...publicWalletView(row), verification: viewStats(stats) });
  });

  api.post('/:credentialId/bind-phone', async (c) => {
    const credentialId = c.req.param('credentialId');
    if (!HEX_RE.test(credentialId)) return c.json({ error: 'invalid_credential_id' }, 400);

    let body: BindPhoneBody;
    try {
      body = await c.req.json<BindPhoneBody>();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    if (!body.otpVerificationId) return c.json({ error: 'missing_otp_verification_id' }, 400);

    const wallet = await getWalletByCredentialId(c.env, credentialId);
    if (!wallet) return c.json({ error: 'wallet_not_found' }, 404);

    // Server-side confirm: never trust PWA-reported verified state.
    let otp;
    try {
      otp = await fetchOtpVerification(c.env, body.otpVerificationId);
    } catch (e) {
      return c.json({ error: 'otp_unreachable', detail: (e as Error).message }, 502);
    }
    if (!otp) return c.json({ error: 'otp_verification_not_found' }, 404);
    if (otp.status !== 'verified' || !otp.verified_phone) {
      return c.json({ error: 'otp_not_verified', status: otp.status }, 400);
    }

    // Single-use: enforce that each verification can be consumed only once
    // across our entire wallet surface. Stores credentialId so we can later
    // traverse from wallet → verification → otp.domovina.ai for the raw phone
    // (see ADR 0001 for the two-system separation).
    const consumed = await markOtpConsumed(c.env, {
      verificationId: body.otpVerificationId,
      purpose: otp.purpose ?? '',
      consumedFor: 'wallet_bind_phone',
      credentialId,
    });
    if (!consumed) return c.json({ error: 'otp_already_used' }, 409);

    const phoneHash = await hashPhone(c.env, otp.verified_phone);
    const updated = await bindPhone(c.env, credentialId, phoneHash);
    if (!updated) return c.json({ error: 'wallet_unchanged' }, 500);

    const row = await getWalletByCredentialId(c.env, credentialId);
    const stats = await getVerificationStats(c.env, credentialId);
    return c.json({ ...publicWalletView(row), verification: viewStats(stats) });
  });

  return api;
}

/// Shared view shape — used by the public registry endpoints AND by the
/// admin HTML dashboard JSON endpoints in src/admin/app.ts. Phone numbers
/// are never returned in any view (only `has_phone` boolean); only the
/// `phone_hash` column exists on the row, and even that stays server-side.
export function publicWalletView(
  row: import('./db').WalletRow | null,
): Record<string, unknown> | null {
  if (!row) return null;
  return {
    credential_id: row.credential_id,
    signer_address: row.signer_address,
    safe_address: row.safe_address,
    rp_id: row.rp_id,
    has_phone: row.phone_hash !== null,
    created_at: isoFromUnix(row.created_at),
    phone_bound_at: row.phone_bound_at ? isoFromUnix(row.phone_bound_at) : null,
  };
}

/// Verification stats shape — feeds the wallet UI's "verified N times,
/// first DATE, latest DATE" reputation footprint display. Counts ALL
/// phone-related OTP consumptions for a wallet, supporting any number of
/// re-verifications over time (which is exactly the long-term sybil-
/// resistance signal we want to build per Phase 5 design).
function viewStats(stats: { count: number; first_at: number | null; latest_at: number | null }) {
  return {
    count: stats.count,
    first_at: stats.first_at ? isoFromUnix(stats.first_at) : null,
    latest_at: stats.latest_at ? isoFromUnix(stats.latest_at) : null,
  };
}

function isoFromUnix(s: number): string {
  return new Date(s * 1000).toISOString();
}
