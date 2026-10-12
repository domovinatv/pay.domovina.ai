#!/bin/bash
# Restore jednog offline snapshota u D1.
#
#   restore.sh <snapshot-dir> --local <persist-dir>
#       Probni restore u lokalni (miniflare) D1, bez ikakvog dodira s Cloudflareom.
#
#   CLOUDFLARE_ACCOUNT_ID=<novi račun> restore.sh <snapshot-dir> --remote <d1-ime>
#       Restore u PRAZNU D1 bazu na računu iz CLOUDFLARE_ACCOUNT_ID. Baza se kreira
#       ako ne postoji. Ako već ima tablica, skripta odbija (nikad ne pišemo preko
#       žive baze; za vraćanje žive baze u prošlost služi `d1 time-travel restore`).
#
# Obje varijante: provjera sha256 iz manifesta prije, usporedba broja redaka po
# tablici s counts.tsv poslije. Razlika = izlaz 1.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WRANGLER="$REPO/backend/node_modules/.bin/wrangler"

usage() { sed -n '2,12p' "$0"; exit 64; }
[ $# -eq 3 ] || usage
SNAP="$(cd "$1" && pwd -P)"; MODE="$2"; ARG="$3"
[ -f "$SNAP/manifest.json" ] || { echo "nema $SNAP/manifest.json"; exit 1; }

if ! command -v node >/dev/null 2>&1; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$NODE_BIN" ] && export PATH="$NODE_BIN:$PATH"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Svi wrangler pozivi iz $WORK: nikad ne smije pokupiti backend/wrangler.toml
# (account_id produkcije) iz direktorija iz kojeg je skripta pokrenuta.
cd "$WORK"

# ── 1. Integritet snapshota ─────────────────────────────────────────────────
grep -oE '"[^"]+": "[0-9a-f]{64}"' "$SNAP/manifest.json" | while IFS= read -r line; do
  f="$(echo "$line" | cut -d'"' -f2)"; want="$(echo "$line" | cut -d'"' -f4)"
  got="$(/usr/bin/shasum -a 256 "$SNAP/$f" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || { echo "sha256 ne odgovara: $f"; exit 1; }
done
echo "sha256 OK"
gunzip -c "$SNAP/pay_domovina.sql.gz" >"$WORK/dump.sql"

# ── 2. Privremena wrangler konfiguracija s ciljnom bazom ────────────────────
case "$MODE" in
  --local)
    DB="pay_domovina"; DB_ID="00000000-0000-0000-0000-000000000000"
    WHERE=(--local --persist-to "$ARG")
    ;;
  --remote)
    [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "postavi CLOUDFLARE_ACCOUNT_ID ciljnog računa"; exit 1; }
    DB="$ARG"
    DB_ID="$("$WRANGLER" d1 info "$DB" --json 2>/dev/null | grep -oE '"uuid": *"[^"]+"' | cut -d'"' -f4 || true)"
    if [ -z "$DB_ID" ]; then
      "$WRANGLER" d1 create "$DB"
      DB_ID="$("$WRANGLER" d1 info "$DB" --json | grep -oE '"uuid": *"[^"]+"' | cut -d'"' -f4)"
    fi
    WHERE=(--remote)
    ;;
  *) usage ;;
esac

cat >"$WORK/wrangler.toml" <<EOF
name = "restore-tmp"
compatibility_date = "2025-01-01"
[[d1_databases]]
binding = "DB"
database_name = "$DB"
database_id = "$DB_ID"
EOF

q() { (cd "$WORK" && "$WRANGLER" d1 execute "$DB" "${WHERE[@]}" --json --command "$1"); }

if [ "$MODE" = "--remote" ]; then
  existing="$(q "select count(*) as n from sqlite_master where type='table' and name not like '\_cf\_%' escape '\' and name not like 'sqlite_%';" \
    | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+$')"
  [ "$existing" = "0" ] || { echo "$DB već ima $existing tablica, odbijam"; exit 1; }
fi

# ── 3. Uvoz ─────────────────────────────────────────────────────────────────
echo "uvozim u $DB ($MODE)"
(cd "$WORK" && "$WRANGLER" d1 execute "$DB" "${WHERE[@]}" --yes --file "$WORK/dump.sql") >"$WORK/import.log" 2>&1 \
  || { cat "$WORK/import.log"; exit 1; }

# ── 4. Usporedba broja redaka ───────────────────────────────────────────────
diffs=0
while IFS="$(printf '\t')" read -r t want; do
  got="$(q "select count(*) as n from \"$t\";" | grep -oE '"n": *[0-9]+' | grep -oE '[0-9]+$')"
  if [ "$got" = "$want" ]; then echo "  ok  $t $got"; else echo "  !!  $t: očekivano $want, dobiveno $got"; diffs=$((diffs + 1)); fi
done <"$SNAP/counts.tsv"

[ $diffs -eq 0 ] || { echo "RESTORE NEPOTPUN: $diffs tablica ne odgovara"; exit 1; }
echo "RESTORE OK: $DB = snapshot $(basename "$SNAP")"
[ "$MODE" = "--remote" ] && echo "database_id za backend/wrangler.toml: $DB_ID"
exit 0
