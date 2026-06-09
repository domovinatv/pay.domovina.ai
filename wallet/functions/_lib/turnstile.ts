/**
 * Optional Cloudflare Turnstile human-attestation for the gas-sponsoring Workers.
 *
 * This is the layer that actually blocks the headline drain vector: a script can
 * forge unlimited valid relay payloads offline (the on-chain WebAuthn signer checks
 * only the P-256 signature, not that a real authenticator was used), so per-signer
 * and even per-IP caps only slow a determined attacker. A Turnstile token is hard to
 * mint at scale without solving a challenge.
 *
 * GATED ON CONFIG so provisioning is decoupled from deploy: with TURNSTILE_SECRET
 * unset, verifyTurnstile FAILS OPEN (returns ok) and the endpoints behave exactly as
 * before. Set the secret (+ client VITE_TURNSTILE_SITE_KEY) to switch enforcement on
 * with no code change. When configured, a missing/invalid token is rejected, and a
 * verification network error fails CLOSED (the operator opted into the control).
 */

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type TurnstileEnv = { TURNSTILE_SECRET?: string };

export type TurnstileResult = { ok: true; skipped?: boolean } | { ok: false; error: string };

export async function verifyTurnstile(
  env: TurnstileEnv,
  token: unknown,
  ip: string | null,
): Promise<TurnstileResult> {
  const secret = (env.TURNSTILE_SECRET ?? '').trim();
  if (!secret) return { ok: true, skipped: true }; // not configured → no-op

  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, error: 'Turnstile token nedostaje — osvježi stranicu i pokušaj ponovno.' };
  }

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);

  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (data.success) return { ok: true };
    return {
      ok: false,
      error: `Turnstile provjera nije uspjela${
        data['error-codes']?.length ? ` (${data['error-codes'].join(',')})` : ''
      }.`,
    };
  } catch {
    // siteverify is Cloudflare's own endpoint reached from a CF Worker — a failure
    // here is rare; since the operator explicitly enabled the control, fail closed.
    return { ok: false, error: 'Turnstile provjera trenutno nedostupna. Pokušaj ponovno.' };
  }
}
