# Preview on your live Shopify store (Windows PowerShell).
# Prerequisites: Node 22, Docker Desktop.
# Usage:  pwsh scripts/preview.ps1   (or:  powershell -File scripts\preview.ps1)
$ErrorActionPreference = "Stop"

function Say($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Err($msg) { Write-Host "`n!! $msg" -ForegroundColor Red }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Err "Node 22+ not found."; exit 1 }
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Err "Docker not found."; exit 1 }
try { docker info *> $null } catch { Err "Docker daemon is not running. Start Docker Desktop."; exit 1 }

if (-not (Test-Path .env)) { Say "Creating .env"; Copy-Item .env.example .env }
if (-not (Select-String -Path .env -Pattern '^SHOP=' -Quiet)) { Add-Content .env "SHOP=the-spirits-embassy.myshopify.com" }

Say "Starting local Postgres"
docker compose up -d db
for ($i = 0; $i -lt 30; $i++) {
  if ((docker compose exec -T db pg_isready -U assistant) -match "accepting") { break }
  Start-Sleep -Seconds 1
}

Say "Installing npm dependencies"
if (Test-Path package-lock.json) { npm ci } else { npm install }

Say "Generating Prisma client and running migrations"
npx prisma generate
npx prisma migrate deploy

Say "Seeding default rules and menu items"
npm run db:seed

Say "Starting the Shopify CLI dev tunnel"
Write-Host "After the tunnel opens, follow the steps in docs/PREVIEW.md"
npm run dev
