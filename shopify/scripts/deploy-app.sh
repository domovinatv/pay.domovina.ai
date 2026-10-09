#!/usr/bin/env bash
# Deploys one app config + the QR extension, with the extension pointed at that
# app's worker. The worker URL is the app's own `application_url`, so the
# toml stays the single source of truth for every URL of the app.
#
#   ./scripts/deploy-app.sh croatisimo        # shopify.app.croatisimo.toml
#   ./scripts/deploy-app.sh                   # shopify.app.toml (shared app)
# Extra args go to `shopify app deploy` (e.g. --force).
set -euo pipefail
cd "$(dirname "$0")/.."

toml=shopify.app.toml
cli_args=()
if [ $# -gt 0 ] && [[ $1 != -* ]]; then
  toml="shopify.app.$1.toml"
  cli_args=(--config "$1")
  shift
fi
[ -f "$toml" ] || { echo "$toml not found" >&2; exit 66; }

url=$(sed -n 's|^application_url = "\(https://[a-z0-9.-]*\)/\{0,1\}"$|\1|p' "$toml")
[ -n "$url" ] || { echo "$toml: application_url must be https://host/" >&2; exit 65; }

cfg=extensions/mpt-payment-qr/src/config.js
cp "$cfg" "$cfg.bak"
trap 'mv "$cfg.bak" "$cfg"' EXIT
sed -i.tmp "s|^export const API = .*|export const API = '$url';|" "$cfg" && rm -f "$cfg.tmp"
grep -q "export const API = '$url';" "$cfg" || { echo "failed to set API in $cfg" >&2; exit 70; }

echo "deploying $toml → extension API $url"
npx shopify app deploy ${cli_args[@]+"${cli_args[@]}"} "$@"
