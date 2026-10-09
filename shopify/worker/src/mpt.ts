import type { Env, MptIntent } from './types';

/// Thin client for the MPT intent API (backend/src/intents/api.ts). The tenant
/// key decides which IBAN collects and which payout whitelist applies.

export class MptError extends Error {
  constructor(public status: number, public code: string) {
    super(`mpt ${status}: ${code}`);
  }
}

export async function createIntent(
  env: Env,
  apiKey: string,
  body: {
    sid: string;
    target_address: string;
    amount_eur: string;
    label: string;
    expires_in_seconds: number;
    metadata: Record<string, unknown>;
  },
): Promise<MptIntent | 'exists'> {
  const res = await fetch(`${env.MPT_API_BASE}/api/intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mpt-key': apiKey },
    body: JSON.stringify(body),
  });
  if (res.status === 409) return 'exists';
  if (!res.ok) throw new MptError(res.status, await errorCode(res));
  return res.json<MptIntent>();
}

export async function getIntent(env: Env, sid: string): Promise<MptIntent | null> {
  const res = await fetch(`${env.MPT_API_BASE}/api/intents/${encodeURIComponent(sid)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new MptError(res.status, await errorCode(res));
  return res.json<MptIntent>();
}

async function errorCode(res: Response): Promise<string> {
  try {
    const j = await res.json<{ error?: string }>();
    return j.error ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
