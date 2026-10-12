# Offline backup MPT produkcije

Fizička kopija stanja `pay.domovina.ai` na dva odvojena SSD-a:

- `/Volumes/DOMOVINA2TB/backup_offline_mpt/`
- `/Volumes/DOMOVINA1TB/backup_offline_mpt/`

launchd (`ai.domovina.mpt-backup-offline`) pokreće `backup.sh` svakih 6 h. Mac koji je
spavao pokrene propušteni termin pri buđenju. Snapshotovi se nikad ne brišu. Jedan ima
oko 120 KB, pa je to oko 175 MB godišnje.

## Što se čuva, a što ne

| Stvar | U snapshotu | Ako je izgubljena |
|---|---|---|
| D1 `pay_domovina` (sve tablice + `d1_migrations`) | `pay_domovina.sql.gz` | jedini izvor istine, zato backup |
| broj redaka po tablici | `counts.tsv` | restore ga uspoređuje |
| KV `onchain:cursor:eure` | `kv_token_cache.json` | bez njega indexer kreće 5000 blokova unatrag |
| `wrangler.toml` backend / wallet / shopify | `config/` | i u gitu; ovdje točno stanje uz dump |
| imena Worker tajni, D1 bookmark, git commit | `manifest.json` | — |
| **vrijednosti tajni** | **NE** (CF ih ne vraća) | password manager, vidi niže |
| KV `monerium:access_token`, `RELAY_KV` | ne | obnove se same |
| Durable Object `IntentStream` | ne | nema stanja |
| Pages buildovi | ne | ponovni deploy iz gita |
| novac (Safe 2/3, Roles) | ne | on-chain; ključevi ownera Safea su izvan servisa |

**Dump sadrži osobne podatke** (IBAN-i, imena uplatitelja, hashevi telefona). Diskovi nisu
šifrirani; preporuka je `diskutil apfs encryptVolume` na oba (lozinka u password manager).

Svaki snapshot prije zapisa prolazi: uvoz u lokalni `sqlite3`, `integrity_check = ok`,
`d1_migrations` nije prazan. Kopija na disk ide u `.tmp-*`, sha256 svake datoteke se
uspoređuje s izvorom, tek onda atomski `mv`. Disk koji nije montiran se preskače.

## Provjera da radi

```bash
tail -20 ~/Library/Logs/mpt-backup-offline.log
cat /Volumes/DOMOVINA1TB/backup_offline_mpt/index.tsv | tail -3
launchctl kickstart -k gui/$(id -u)/ai.domovina.mpt-backup-offline   # odmah
```

Neuspjeh (izlaz 1) ili samo jedan disk (izlaz 2) šalje Telegram poruku (`backend/secrets/telegram.env`)
i macOS notifikaciju. Uspjeh je tih.

## Restore

### Probni restore (lokalno, bez Cloudflarea) — povremeno, da znamo da radi

```bash
tools/backup-offline/restore.sh /Volumes/DOMOVINA1TB/backup_offline_mpt/latest --local /tmp/mpt-restore
```

Provjerava sha256 iz manifesta, uvozi u lokalni D1, uspoređuje broj redaka s `counts.tsv`.

### Scenarij A — loša migracija ili krivi upis (zadnjih 30 dana)

Offline backup ne treba; D1 Time Travel vraća živu bazu na minutu:

```bash
cd backend
npx wrangler d1 time-travel restore pay_domovina --timestamp=2026-10-12T08:00:00Z
# ili --bookmark=<d1_bookmark iz manifest.json snapshota>
```

### Scenarij B — baza obrisana, račun živ

```bash
CLOUDFLARE_ACCOUNT_ID=7dc7167b7e2e00923bfa7cd697df14e4 \
  tools/backup-offline/restore.sh /Volumes/DOMOVINA1TB/backup_offline_mpt/latest --remote pay_domovina
```

Skripta kreira bazu, odbija ako već ima tablica, ispiše novi `database_id`. Upiši ga u
`backend/wrangler.toml` i `cd backend && npx wrangler deploy`.

### Scenarij C — novi Cloudflare račun

1. `wrangler login` na novi račun; `CLOUDFLARE_ACCOUNT_ID=<novi>`.
2. `restore.sh <snapshot> --remote pay_domovina` → novi `database_id`.
3. `wrangler kv namespace create TOKEN_CACHE`; upiši kursor iz `kv_token_cache.json`
   (`wrangler kv key put onchain:cursor:eure <vrijednost> --namespace-id <id>`).
4. U `backend/wrangler.toml`: `account_id`, `database_id`, KV `id`.
5. Tajne iz password managera, za svako ime iz `manifest.json` → `worker_secret_names`:
   `npx wrangler secret put <IME>`. Nezamjenjive: **`PHONE_PEPPER`** (bez njega svi
   telefonski bindingi walleta mrtvi) i **`TENANT_SECRETS_KEK`** (bez njega svaki tenant
   ponovno onboardati). Ostale se mogu izdati iznova (Monerium dashboard, Enable Banking,
   `ROUTER_PRIVATE_KEY` = novi EOA + Safe batch 007).
6. Zona `domovina.ai` na novom računu (ili DNS), `npx wrangler deploy` (routeovi
   `mpt.` i `monerium.`).
7. Izvan koda:
   - Cloudflare Access aplikacija za `mpt.domovina.ai/admin/sso` → novi `ACCESS_AUD`,
     `ACCESS_TEAM_DOMAIN` u `wrangler.toml` (`docs/admin-auth.md`).
   - Monerium webhook: ako se URL nije promijenio ništa; inače ponovna registracija
     (default tenant + svaki `/api/monerium/webhook/t/<tenant>`).
   - Pages `pay-domovina` i `wallet-domovina` (deploy iz gita, `RELAYER_PRIVATE_KEY`,
     `TURNSTILE_SECRET`, KV `RELAY_KV`).
   - Admin passkeyi su u `admin_passkeys` i vrijede dok je `ADMIN_HOST` isti (rpID = host).
8. Provjera: `/admin` login, `/admin/tenants` → Verify, jedna testna uplata.

## Instalacija na novi Mac

```bash
cd backend && npm ci && npx wrangler login
cp tools/backup-offline/ai.domovina.mpt-backup-offline.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.domovina.mpt-backup-offline.plist
```

**Cloudflare API token** (preporučeno, inače job koristi osobni `wrangler login` OAuth,
koji dijele svi wrangler procesi i koji je 12. 10. u 12:20 pao s `Authentication error`):
dashboard → My Profile → API Tokens → Create Custom Token, račun D.O.M., dozvole
*D1 Edit* (export to traži), *Workers KV Storage Read*, *Workers Scripts Read*. Upis u Keychain:

```bash
security add-generic-password -U -a "$USER" -s mpt-backup-cf-token -w '<token>'
```

Log pokazuje `(auth: api token)` kad ga job koristi. Export se pokuša 3 puta, 2 min razmaka.

macOS ne dopušta launchd skripti pisanje na vanjski disk dok `/bin/bash` nema
**Full Disk Access** (System Settings → Privacy & Security → Full Disk Access → `+` →
Cmd+Shift+G `/bin/bash`). Bez toga je log pun `Operation not permitted` i stiže alarm.
