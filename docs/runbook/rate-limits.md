# Rate-limit pravila (Cloudflare WAF) — rail javni ulazi

Status: **NIJE PRIMIJENJENO** (2026-10-10). Kod ima vlastite kapice (dolje);
WAF pravila treba ručno upisati u CF dashboard za zonu `domovina.ai`
(Security → WAF → Rate limiting rules) i ovdje zapisati ID svakog pravila.
Fable 5.1 r2: P0-1.8, P0-6.4 (MT-09, SR-01).

| Putanja (host `monerium.domovina.ai` i `mpt.domovina.ai`) | Metoda | Limit | Akcija | Pravilo ID |
|---|---|---|---|---|
| `/api/intents` | POST | 30 / min / IP | block 10 min | — |
| `/api/wallets*` | POST | 10 / min / IP | block 10 min | — |
| `/api/monerium/webhook*` | POST | 60 / min / IP | block 1 min | — |
| `/api/intents/*/stream` | GET | 10 / min / IP | block 1 min | — |

Napomena za webhook: Monerium šalje s malog broja IP-ova i retry ima backoff;
60/min je daleko iznad normalnog prometa, ali provjeri u CF Analytics prije
uključivanja da Monerium nikad ne dođe blizu.

## Kapice u kodu (vrijede i bez WAF-a)

| Kapica | Vrijednost | Gdje |
|---|---|---|
| Tijelo webhooka | 64 KB → 413, bez D1 reda | `MAX_WEBHOOK_BODY_BYTES`, `src/index.ts` |
| Payload webhooka s krivim potpisom | prvih 4096 znakova, samo `webhook-*`/UA/IP zaglavlja | `UNSIGNED_PAYLOAD_KEEP`, `webhookHandler.ts` |
| Nepoznati tenant na `/t/:id` | prvih 1024 znakova | `src/index.ts` |
| SSE streamovi po sidu | 8 → 429 (checkout pada na polling) | `MAX_SINKS_PER_SID`, `intents/stream.ts` |
