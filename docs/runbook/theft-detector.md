# Detektor krađe (ADR 0019 faza 0) — kako znati da radi

Cron (svake 2 min) čita `Transfer(from = prihvatni Safe)` za svaki rail i
klasificira izlaz po Safe eventima u receiptu (`outflowWatch.ts`).

| Signal | Kad | Gdje |
|---|---|---|
| 🚨 `role_unknown` | EURe izašao kroz naš Roles modifier, a rail ga nije poslao (i kroz relay/multicall) | Telegram + `tenant_audit_log` `outflow.unexplained` |
| 🚨 `module_unknown` | EURe izašao kroz modul koji nije naš Roles | isto |
| ⚠️ `role_unhashed` | naš forward na chainu, red mlađi od 15 min bez tx hasha | isto |
| ℹ️ `other` | vlasnici (2/3) ili bez Safe izvršenja | isto |
| ⚠️ „zaostaje" | kursor > 500 blokova iza chaina (jednom u 6 h) | Telegram |
| ⚠️ „ne čita chain" | 3 uzastopna neuspjela ticka po railu (raspon se prije toga prepolovljava do 100 blokova) | Telegram |
| `outflow.tick` | jednom na sat, `{from,to,outflows,flagged}` | `tenant_audit_log` |
| heartbeat | nakon svakog ticka u kojem su svi railovi pročitani | `WATCH_HEARTBEAT_URL` |

## Heartbeat izvan Cloudflarea (TD-02) — NIJE JOŠ POSTAVLJEN

Detektor živi u Workeru koji napadač s deploy pravima kontrolira, pa mora
dokazivati da je živ izvana. Postavljanje (jednom):

1. healthchecks.io (ili Better Stack): novi check, period 2 min, grace 10 min,
   obavijest na e-mail/drugi kanal (ne isti Telegram bot).
2. `cd backend && npx wrangler secret put WATCH_HEARTBEAT_URL` → ping URL.
3. Nakon deploya provjeriti da check prelazi u „up".

Bez secreta Worker samo preskače ping; ništa se ne kvari.
