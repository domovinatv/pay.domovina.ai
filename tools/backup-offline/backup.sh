#!/bin/bash
# Offline backup MPT produkcije (pay.domovina.ai) na dva fizička SSD-a.
#
# Što ide u snapshot (jedan direktorij po pokretanju, ništa se ne prepisuje):
#   pay_domovina.sql.gz   cijeli D1 (`wrangler d1 export --remote`), shema + podaci
#   counts.tsv            broj redaka po tablici, iz provjerenog uvoza u sqlite
#   kv_token_cache.json   KV vrijednosti koje nisu tajne (kursor indexera)
#   config/               wrangler.toml backenda, walleta i shopifyja u trenutku backupa
#   manifest.json         vrijeme, git commit, D1 bookmark, imena tajni, sha256 svih datoteka
#
# Tajne (vrijednosti) NISU ovdje: Cloudflare ih ne daje pročitati. Restore ih traži
# iz password managera; popis imena je u manifestu. Vidi README.md.
#
# Determinizam: wrangler je onaj pinan u backend/node_modules, provjera je lokalni
# sqlite3 uvoz, snapshot se piše u .tmp-* pa atomski preimenuje tek kad sha256
# kopije odgovara izvoru. Disk koji nije montiran se preskače (nikad ne pišemo
# u /Volumes/<ime> koji je samo prazan direktorij na sistemskom disku).
#
# Izlaz: 0 = oba diska OK; 1 = nijedan; 2 = samo jedan. Sve osim 0 ide u Telegram.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BACKEND="$REPO/backend"
WRANGLER="$BACKEND/node_modules/.bin/wrangler"
DB_NAME="pay_domovina"
KV_TOKEN_CACHE="8b9f1c0c575246e284b8a18157990b38"
KV_SAFE_KEYS="onchain:cursor:eure"          # monerium:access_token je tajna, ne ide
TARGETS="/Volumes/DOMOVINA2TB/backup_offline_mpt /Volumes/DOMOVINA1TB/backup_offline_mpt"
export CLOUDFLARE_ACCOUNT_ID="7dc7167b7e2e00923bfa7cd697df14e4"

# launchd ne zna za nvm: uzmi najnoviji instalirani node.
if ! command -v node >/dev/null 2>&1; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
SNAP="$WORK/$STAMP"
trap 'rm -rf "$WORK"' EXIT

log() { echo "[$(date -u +%FT%TZ)] $*"; }

alert() {
  local msg="MPT offline backup $STAMP: $1"
  log "ALERT $msg"
  /usr/bin/osascript -e "display notification \"$1\" with title \"MPT backup\"" >/dev/null 2>&1 || true
  local envf="$BACKEND/secrets/telegram.env"
  if [ -f "$envf" ]; then
    # shellcheck disable=SC1090
    ( set -a; . "$envf"; set +a
      curl -fsS -m 20 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
        --data-urlencode "text=⚠️ $msg" >/dev/null ) || log "telegram slanje nije uspjelo"
  fi
}

fail() { alert "$1"; exit 1; }

sha() { /usr/bin/shasum -a 256 "$1" | cut -d' ' -f1; }

[ -x "$WRANGLER" ] || fail "nema $WRANGLER (npm ci u backend/)"
mkdir -p "$SNAP/config"

# ── 1. D1 export ────────────────────────────────────────────────────────────
log "export $DB_NAME"
(cd "$BACKEND" && "$WRANGLER" d1 export "$DB_NAME" --remote --output="$WORK/dump.sql") \
  >"$WORK/export.log" 2>&1 || { cat "$WORK/export.log"; fail "d1 export pao"; }

# ── 2. Provjera: dump se mora čisto učitati u sqlite ────────────────────────
/usr/bin/sqlite3 "$WORK/check.db" <"$WORK/dump.sql" || fail "dump se ne učitava u sqlite"
[ "$(/usr/bin/sqlite3 "$WORK/check.db" 'pragma integrity_check;')" = "ok" ] \
  || fail "integrity_check nije ok"
MIGRATIONS="$(/usr/bin/sqlite3 "$WORK/check.db" 'select count(*) from d1_migrations;')"
[ "$MIGRATIONS" -gt 0 ] || fail "d1_migrations prazan, sumnjiv dump"
for t in $(/usr/bin/sqlite3 "$WORK/check.db" \
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name;"); do
  printf '%s\t%s\n' "$t" "$(/usr/bin/sqlite3 "$WORK/check.db" "select count(*) from \"$t\";")"
done >"$SNAP/counts.tsv"
gzip -9 -n -c "$WORK/dump.sql" >"$SNAP/pay_domovina.sql.gz"

# ── 3. KV (samo ne-tajne vrijednosti) ───────────────────────────────────────
{
  echo "{"
  first=1
  for k in $KV_SAFE_KEYS; do
    v="$(cd "$BACKEND" && "$WRANGLER" kv key get "$k" --namespace-id "$KV_TOKEN_CACHE" --text 2>/dev/null)" \
      || fail "kv key get $k pao"
    [ $first = 1 ] || echo ","
    first=0
    printf '  "%s": "%s"' "$k" "$v"
  done
  echo; echo "}"
} >"$SNAP/kv_token_cache.json"

# ── 4. Konfiguracija i manifest ─────────────────────────────────────────────
cp "$BACKEND/wrangler.toml" "$SNAP/config/backend.wrangler.toml"
cp "$REPO/wallet/wrangler.toml" "$SNAP/config/wallet.wrangler.toml"
cp "$REPO/shopify/worker/wrangler.toml" "$SNAP/config/shopify.wrangler.toml"

BOOKMARK="$(cd "$BACKEND" && "$WRANGLER" d1 time-travel info "$DB_NAME" 2>/dev/null \
  | grep -oE "bookmark is '[^']+'" | cut -d"'" -f2 || true)"
SECRETS="$(cd "$BACKEND" && "$WRANGLER" secret list 2>/dev/null \
  | grep -oE '"name": *"[^"]+"' | cut -d'"' -f4 | paste -sd, - || true)"
GIT_SHA="$(git -C "$REPO" rev-parse HEAD)"

{
  echo "{"
  echo "  \"stamp\": \"$STAMP\","
  echo "  \"database\": \"$DB_NAME\","
  echo "  \"database_id\": \"$(grep -m1 database_id "$BACKEND/wrangler.toml" | cut -d'"' -f2)\","
  echo "  \"account_id\": \"$CLOUDFLARE_ACCOUNT_ID\","
  echo "  \"d1_bookmark\": \"$BOOKMARK\","
  echo "  \"migrations_applied\": $MIGRATIONS,"
  echo "  \"git_commit\": \"$GIT_SHA\","
  echo "  \"wrangler\": \"$("$WRANGLER" --version 2>/dev/null | tail -1)\","
  echo "  \"worker_secret_names\": \"$SECRETS\","
  echo "  \"sha256\": {"
  first=1
  for f in $(cd "$SNAP" && find . -type f ! -name manifest.json | sed 's|^\./||' | sort); do
    [ $first = 1 ] || echo ","
    first=0
    printf '    "%s": "%s"' "$f" "$(sha "$SNAP/$f")"
  done
  echo; echo "  }"
  echo "}"
} >"$SNAP/manifest.json"

# ── 5. Kopija na svaki disk ─────────────────────────────────────────────────
ok=0; bad=""
for root in $TARGETS; do
  vol="$(echo "$root" | cut -d/ -f1-3)"
  if ! /sbin/mount | grep -q " on $vol ("; then
    log "preskačem $root: $vol nije montiran"; bad="$bad $vol(nije montiran)"; continue
  fi
  dest="$root/$(echo "$STAMP" | cut -c1-4)/$(echo "$STAMP" | cut -c5-6)"
  if mkdir -p "$dest" && cp -R "$SNAP" "$dest/.tmp-$STAMP"; then
    match=1
    for f in $(cd "$SNAP" && find . -type f | sed 's|^\./||'); do
      [ "$(sha "$SNAP/$f")" = "$(sha "$dest/.tmp-$STAMP/$f")" ] || match=0
    done
    if [ $match = 1 ] && mv "$dest/.tmp-$STAMP" "$dest/$STAMP"; then
      ln -sfn "$dest/$STAMP" "$root/latest"
      printf '%s\t%s\n' "$STAMP" "$dest/$STAMP" >>"$root/index.tsv"
      ok=$((ok + 1)); log "OK $dest/$STAMP"; continue
    fi
  fi
  rm -rf "$dest/.tmp-$STAMP" 2>/dev/null || true
  bad="$bad $vol(kopija neispravna)"; log "GREŠKA $root"
done

total="$(echo $TARGETS | wc -w | tr -d ' ')"
rows="$(awk -F'\t' '{s+=$2} END {print s}' "$SNAP/counts.tsv")"
log "gotovo: $ok/$total diska, $rows redaka, bookmark $BOOKMARK"
[ "$ok" -eq "$total" ] && exit 0
[ "$ok" -eq 0 ] && fail "nijedan disk nije zapisan:$bad"
alert "samo $ok/$total diska:$bad"
exit 2
