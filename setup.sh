#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

info()  { echo -e "\033[1;34m[INFO]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[OK]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[WARN]\033[0m $*"; }

# -- Secrets -------------------------------------------------------------------
if command -v op &>/dev/null && op account list &>/dev/null 2>&1; then
    op inject -i .env.tpl -o .env
    ok "Secrets injected from 1Password"
else
    if [[ ! -f .env ]]; then
        cp .env.tpl .env
        warn "1Password not available. Copied .env.tpl -> .env (edit manually)"
    fi
fi

# -- Dependencies --------------------------------------------------------------
info "Installing dependencies..."
npm install --silent
ok "Dependencies installed"

ok "Setup complete"
