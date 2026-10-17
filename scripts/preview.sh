#!/usr/bin/env bash
# Preview on your live Shopify store, hidden from shoppers.
# Starts a local Postgres, installs deps, runs migrations, seeds defaults, then starts
# `shopify app dev` which opens a secure HTTPS tunnel and prints an install link.
#
# Prerequisites: Node 22, npm, Docker, and the Shopify CLI (installed on first run below).
# Usage:  bash scripts/preview.sh
set -euo pipefail

say() { printf "\n\033[1;34m==>\033[0m %s\n" "$*"; }
err() { printf "\n\033[1;31m!!\033[0m %s\n" "$*" >&2; }

# ── 0. Preflight ────────────────────────────────────────────────────────────
command -v node >/dev/null || { err "Node 22+ not found. Install from https://nodejs.org"; exit 1; }
command -v docker >/dev/null || { err "Docker not found. Install Docker Desktop from https://docker.com"; exit 1; }
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then err "Node 22+ required (you have $(node -v))"; exit 1; fi
if ! docker info >/dev/null 2>&1; then err "Docker daemon is not running. Start Docker Desktop first."; exit 1; fi

# ── 1. .env ─────────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  say "Creating .env from .env.example"
  cp .env.example .env
fi
# Make sure DATABASE_URL points at the compose Postgres
if ! grep -q "^DATABASE_URL=" .env; then
  echo "DATABASE_URL=postgresql://assistant:assistant@localhost:5432/assistant" >> .env
fi
if ! grep -q "^SHOP=" .env; then
  echo "SHOP=the-spirits-embassy.myshopify.com" >> .env
fi

# ── 2. Postgres ─────────────────────────────────────────────────────────────
say "Starting local Postgres (pgvector/pg16) with Docker"
docker compose up -d db
# Wait for it to accept connections (pg_isready inside the container)
for i in $(seq 1 30); do
  if docker compose exec -T db pg_isready -U assistant >/dev/null 2>&1; then break; fi
  sleep 1
done

# ── 3. Dependencies ─────────────────────────────────────────────────────────
say "Installing npm dependencies"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ── 4. Prisma client + migrations ───────────────────────────────────────────
say "Generating Prisma client and running migrations"
npx prisma generate
npx prisma migrate deploy

# ── 5. Seed defaults (jurisdictions, menu items) ────────────────────────────
set -a; . ./.env; set +a
say "Seeding default jurisdictions and chat menu items for $SHOP"
npm run db:seed

# ── 6. Shopify CLI ──────────────────────────────────────────────────────────
if ! npx --no-install shopify version >/dev/null 2>&1; then
  say "Installing the Shopify CLI (first run only)"
  npm install --no-save @shopify/cli@latest @shopify/app@latest
fi

# ── 7. Start the dev tunnel ─────────────────────────────────────────────────
cat <<'EOF'

┌───────────────────────────────────────────────────────────────────────────────┐
│  The Shopify CLI is about to start.                                           │
│                                                                               │
│  On FIRST run it will:                                                        │
│    1. Open your browser to log in to Shopify Partners.                        │
│    2. Ask which app to connect to (choose "Create a new app" the first time)  │
│       — pick the Partner org that owns the-spirits-embassy.myshopify.com.     │
│    3. Open a secure HTTPS tunnel and print an URL like:                       │
│         https://xxxxx.trycloudflare.com                                       │
│    4. Print an install link ending in /admin/oauth?... — open that to         │
│       install the app on the store.                                           │
│                                                                               │
│  AFTER it's running:                                                          │
│    • The app's admin page is at Shopify admin > Apps > "Spirits Embassy       │
│      Assistant". Press "Run full sync" there once.                            │
│    • Online Store > Themes > duplicate the live theme (do NOT publish it).    │
│    • Customize the copy > App embeds > switch on "Whisky assistant".          │
│    • In the embed settings, paste the HTTPS tunnel URL into "App API URL".    │
│    • Use the copy's "Preview" link. Shoppers on the live theme never see it.  │
│                                                                               │
│  To stop the tunnel: Ctrl+C in this terminal.                                 │
│  To stop Postgres:   docker compose down                                      │
└───────────────────────────────────────────────────────────────────────────────┘

EOF
exec npm run dev
