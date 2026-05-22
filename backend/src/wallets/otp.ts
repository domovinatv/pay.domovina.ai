import type { Env } from '../types';

export interface OtpVerificationView {
  id: string;
  code: string;
  status: 'pending' | 'verified' | 'expired';
  verified_phone: string | null;
  verified_at: string | null;
  purpose: string | null;
  expires_at: string;
}

/// Server-to-server confirmation of a verification we previously *started*
/// on the client side. Never trust the PWA's claim that a verification is
/// verified — always GET it from otp.domovina.ai before acting on it.
export async function fetchOtpVerification(
  env: Env,
  verificationId: string,
): Promise<OtpVerificationView | null> {
  const base = env.OTP_API_BASE.replace(/\/$/, '');
  const res = await fetch(`${base}/api/verifications/${encodeURIComponent(verificationId)}`, {
    headers: { Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OTP service ${res.status}: ${await res.text().catch(() => '')}`);
  return (await res.json()) as OtpVerificationView;
}

/// HMAC-SHA256 of an E.164 phone number using the server-only PHONE_PEPPER
/// secret. Produces a stable identifier suitable for indexing without
/// storing any reversible representation of the phone number itself.
export async function hashPhone(env: Env, e164Phone: string): Promise<string> {
  if (!env.PHONE_PEPPER) throw new Error('PHONE_PEPPER secret not configured');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(env.PHONE_PEPPER),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(e164Phone.trim()));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
