import type { Env } from './types';

/// Operator alerting. Env-gated and fail-open: when TELEGRAM_BOT_TOKEN /
/// TELEGRAM_CHAT_ID are unset the call degrades to a console line, so a
/// missing secret can never break a money path.
///
/// Setup:
///   1. talk to @BotFather → /newbot → copy the token
///   2. add the bot to the ops chat, then read the chat id from
///      https://api.telegram.org/bot<TOKEN>/getUpdates
///   3. wrangler secret put TELEGRAM_BOT_TOKEN
///      wrangler secret put TELEGRAM_CHAT_ID
///
/// Never pass PII (payer IBAN / name) in here — alerts land in a chat that is
/// not part of the audited surface. Order ids and addresses are fine.
export async function sendAlert(env: Env, text: string): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    console.warn(`[alert:unconfigured] ${text}`);
    return;
  }
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
    if (!res.ok) {
      console.error(`[alert:failed] telegram ${res.status}: ${text}`);
    }
  } catch (e) {
    console.error(`[alert:failed] ${(e as Error).message}: ${text}`);
  }
}
