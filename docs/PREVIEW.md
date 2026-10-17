# Preview on your live store, hidden from shoppers

This takes about 10 minutes end-to-end. Nothing you do here is visible to shoppers until you
publish the duplicated theme, which you never need to do during preview.

## Before you start

- Node 22+ and Docker Desktop installed and running.
- You can create apps in your Shopify Partner account (any Partner org that includes
  `the-spirits-embassy.myshopify.com`), or you are a staff user on the store with the
  **Develop apps** permission.

## 1. Start the app on your laptop

```bash
git clone https://github.com/nirbhaysoftdev/spirit-chatbot
cd spirit-chatbot
bash scripts/preview.sh         # macOS / Linux / WSL
# Windows PowerShell:  pwsh scripts/preview.ps1
```

The script does the following for you:

1. Starts a local Postgres (pgvector/pg16) through Docker.
2. Installs npm dependencies.
3. Runs database migrations and seeds the default jurisdictions and chat menu items.
4. Starts the Shopify CLI, which opens an HTTPS tunnel and prints an install link.

On the **first run** the CLI will ask you to:

- Log in to Shopify Partners in your browser.
- Choose an app — pick **Create a new app** the first time; call it "Spirits Embassy Assistant".
- Confirm which org and store it belongs to.

Keep that terminal open — it's your tunnel. If you stop it, the preview stops.

## 2. Install the app on the store

The CLI prints something like:

```
Preview URL:  https://xxxxx.trycloudflare.com
Install URL:  https://the-spirits-embassy.myshopify.com/admin/oauth/install?...
```

Open the **Install URL** and click **Install**. Shopify brings you into the app's admin page.

- Press **Run full sync** once. Products, customers and orders copy into the local database in
  the background (about 4,000 products takes a few minutes). Refresh to see progress.

## 3. Enable the chat on an unpublished copy of the live theme

This is what keeps shoppers from seeing it.

1. In Shopify admin: **Online Store › Themes**.
2. On the live theme (the one marked **Live**), click **…** → **Duplicate**. The copy is named
   "Copy of ...". **Do not publish it.**
3. On the copy, click **Customize**.
4. In the left sidebar, click the **App embeds** tab (the puzzle-piece icon).
5. Switch on **Whisky assistant**.
6. Click the gear icon on the embed. In **App API URL**, paste the Preview URL from the terminal
   (the `https://xxxxx.trycloudflare.com` one). Click **Save**.
7. At the top right, click **Preview**. That opens the storefront with the chat panel on the
   unpublished theme. The URL has `preview_theme_id=...` in it — anyone with that URL sees the
   chat; shoppers on the normal URLs don't.

## 4. Try it

- Click the **Ask our whisky expert** launcher in the bottom-right.
- Click **Explore Liquor** → tap any chip (**Best deals**, **Matches my taste**, **Rarest of rare**,
  **Trending now**, etc.). You should see real product cards from your catalogue with a reason line.
- Open **Shopify admin › Apps › Spirits Embassy Assistant**:
  - The sync status and counts should match what's in your store.
  - The tracking switch is **off**. Leave it off for preview unless you also want to measure the
    chat's event funnel.

## When you're done

- Close the terminal to stop the tunnel. The preview goes down; the duplicated theme stays
  (unpublished) with the embed switch on. Nobody sees it until you reopen the tunnel and the
  preview URL works again.
- To stop Postgres: `docker compose down`.
- To wipe the local database: `docker compose down -v`.

## Deploy for always-on preview

The local tunnel is great for a quick look. If you want the preview URL to work when your laptop
is closed, deploy the same code to Fly.io or Render using the included `Dockerfile`, then point
the embed's **App API URL** at the deployed URL instead. See the README for the production notes.

## Troubleshooting

- **Chat appears but chips do nothing.** The App API URL is empty or wrong — paste the terminal's
  Preview URL into the embed settings and save.
- **Chips return "Couldn't load picks."** Check the terminal where `preview.sh` is running for
  the error. Most often it's the sync not having finished yet.
- **"Shop not installed"** from `/api/chips`. Press **Run full sync** on the app's admin page once.
- **CLI can't open the tunnel.** Run `npx shopify auth logout`, then re-run `scripts/preview.sh`.
