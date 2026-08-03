import type { Env } from './types';

/// Operator alerting. Env-gated and fail-open: when TELEGRAM_BOT_TOKEN /
/// TELEGRAM_CHAT_ID are unset the call degrades to a console line, so a
/// missing secret can never break a money path.
///
/// Setup + the supergroup-migration trap are documented in
/// `docs/plans/tenant-payout-whitelist-rollout.md` §7.
///
/// Never pass PII (payer IBAN / name) in here — alerts land in a chat that is
/// not part of the audited surface. Order ids and addresses are fine.

export interface AlertResult {
  /// Both secrets present. False = alerting is intentionally off.
  configured: boolean;
  /// Telegram accepted the message.
  ok: boolean;
  /// HTTP status from the Telegram API, when we got that far.
  status?: number;
  /// Failure detail — Telegram's `description`, or the thrown message.
  /// Never contains the bot token.
  error?: string;
}

/// Sends and REPORTS the outcome. Used by the admin alert-test endpoint, which
/// needs to distinguish "not configured" from "configured but rejected" —
/// otherwise a wrong chat id stays invisible until the first real incident
/// (alerting is fail-open by design, so nothing else surfaces it).
export async function trySendAlert(env: Env, text: string): Promise<AlertResult> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return { configured: false, ok: false };

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (res.ok) return { configured: true, ok: true, status: res.status };
    // Telegram puts the useful part in `description` ("chat not found",
    // "bot was kicked", …). Fall back to the raw body, truncated.
    let detail = '';
    try {
      const body = (await res.json()) as { description?: string };
      detail = body?.description ?? '';
    } catch {
      detail = (await res.text().catch(() => '')).slice(0, 200);
    }
    return { configured: true, ok: false, status: res.status, error: detail };
  } catch (e) {
    return { configured: true, ok: false, error: (e as Error).message };
  }
}

/// Fire-and-forget wrapper for money paths. Never throws, never blocks a
/// forward decision — the worst case is a log line nobody reads.
export async function sendAlert(env: Env, text: string): Promise<void> {
  const r = await trySendAlert(env, text);
  if (!r.configured) {
    console.warn(`[alert:unconfigured] ${text}`);
  } else if (!r.ok) {
    console.error(`[alert:failed] telegram ${r.status ?? '-'} ${r.error ?? ''}: ${text}`);
  }
}
