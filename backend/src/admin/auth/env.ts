// Admin auth konfiguracija (preneseno iz bank-push-gateway, docs/admin.md).
import type { Env } from '../../types';

/** E-mailovi koji smiju u admin. Provjerava se pri svakom zahtjevu. */
export function adminEmails(env: Env): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
}

export const accessConfigured = (env: Env) => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

export async function sha256Hex(message: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
