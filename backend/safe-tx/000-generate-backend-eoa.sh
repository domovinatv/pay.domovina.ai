#!/usr/bin/env bash
#
# Generate a fresh secp256k1 keypair to use as the MPT backend forwarder EOA.
#
# The PRIVATE KEY printed by this script is highly sensitive — it controls
# any role the EOA is granted on the Zodiac Roles Modifier. Save it to
# 1Password immediately and never paste it into chat, git, cloud notes,
# screenshots, or anything else. Only the PUBLIC ADDRESS gets shared.
#
# Run this in a SEPARATE OFFLINE TERMINAL (not inside Claude Code, IDE
# integrations, recording software, screen-shared sessions, etc) so the
# value never enters any tool's capture buffer.
#
# Usage:
#   ./000-generate-backend-eoa.sh
#
# What it does:
#   1. Prefers `cast wallet new` (Foundry) — single canonical command.
#   2. Falls back to openssl + node(viem) derivation if Foundry isn't
#      installed. Same secp256k1 math, same result format.
#
# After:
#   - Copy "Address" → use it for `--eoa` flag in
#     `001-eure-forwarder-role-setup.mjs`
#   - Copy "Private key" → 1Password vault, label "MPT backend EOA"
#   - Later, upload private key to Cloudflare Workers as a secret via
#     `printf '<key>' | wrangler secret put ROUTER_PRIVATE_KEY` — also
#     from a separate offline terminal.

set -euo pipefail

echo "════════════════════════════════════════════════════════════════"
echo "  MPT — Generating fresh backend forwarder EOA"
echo "════════════════════════════════════════════════════════════════"
echo

if command -v cast >/dev/null 2>&1; then
  echo "Using Foundry cast wallet new:"
  echo
  cast wallet new
else
  echo "Foundry 'cast' not found — falling back to openssl + viem."
  echo "Tip: install Foundry (curl -L https://foundry.paradigm.xyz | bash) for the canonical path."
  echo
  PK=$(openssl rand -hex 32)
  # Derive public address via node + viem (already a dep in this backend).
  ADDR=$(cd "$(dirname "$0")/.." && node -e "
    const { privateKeyToAccount } = require('viem/accounts');
    console.log(privateKeyToAccount('0x$PK').address);
  ")
  cat <<EOF
Successfully created new keypair.
Address:     $ADDR
Private key: 0x$PK
EOF
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo "  NEXT STEPS"
echo "════════════════════════════════════════════════════════════════"
echo "  1. Private key  → 1Password (vault item: 'MPT backend EOA')"
echo "  2. Public addr  → next: run"
echo "       node safe-tx/001-eure-forwarder-role-setup.mjs --eoa <addr>"
echo "  3. Fund the EOA with ~\$1 xDAI on Gnosis for forward gas."
echo "  4. From a separate terminal, upload the secret:"
echo "       printf 'YOUR_PRIVATE_KEY' | wrangler secret put ROUTER_PRIVATE_KEY"
echo "════════════════════════════════════════════════════════════════"
