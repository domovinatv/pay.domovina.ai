// otp.domovina.ai — Reverse OTP service. We hit it directly from the PWA;
// CORS is permissive there (it's designed as a third-party verification
// service, see /Users/ms/git/domovinatv/sms.domovina.ai). Server-side
// confirmation of the verified state still happens via our own backend.

const OTP_BASE = 'https://otp.domovina.ai';

export type OtpStatus = 'pending' | 'verified' | 'expired';

export type OtpStartResponse = {
  id: string;
  code: string;
  gateway_number: string;
  status: OtpStatus;
  expires_at: string;
  sms_body: string;
  instructions: string;
  purpose: string | null;
};

export type OtpPollResponse = {
  id: string;
  code: string;
  gateway_number: string;
  status: OtpStatus;
  expires_at: string;
  verified_at: string | null;
  verified_phone: string | null;
  purpose: string | null;
};

export async function startOtpVerification(purpose: string): Promise<OtpStartResponse> {
  const res = await fetch(`${OTP_BASE}/api/verifications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose }),
  });
  if (!res.ok) throw new Error(`OTP start failed (${res.status}): ${await res.text().catch(() => '')}`);
  return (await res.json()) as OtpStartResponse;
}

export async function pollOtpVerification(id: string): Promise<OtpPollResponse> {
  const res = await fetch(`${OTP_BASE}/api/verifications/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`OTP poll failed (${res.status})`);
  return (await res.json()) as OtpPollResponse;
}

export function otpQrUrl(id: string): string {
  return `${OTP_BASE}/api/verifications/${encodeURIComponent(id)}/qr.svg`;
}

/**
 * Subscribe to verification status changes. Polls every 2.5s until
 * status flips terminal (verified/expired) or the caller cancels.
 */
export function subscribeOtp(
  id: string,
  onUpdate: (v: OtpPollResponse) => void,
): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  async function tick() {
    if (cancelled) return;
    try {
      const v = await pollOtpVerification(id);
      if (!cancelled) onUpdate(v);
      if (v.status === 'verified' || v.status === 'expired') return;
    } catch {
      /* swallow; retry */
    }
    if (!cancelled) timeoutId = setTimeout(tick, 2_500);
  }
  tick();
  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
}
