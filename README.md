# Spirits Embassy Assistant

A private Shopify app for **thespiritsembassy.com**: a 24/7 copy of the store's catalogue,
customers and orders, storefront behaviour tracking, and the side-panel chat assistant.
This repository is **phase 1: the foundation** that the recommendation brain and the AI chat build on.

The app is **read-only** on store data. It cannot create, edit or delete products, prices,
orders, customers or discounts.

## What phase 1 contains

| Part | Where | What it does |
| --- | --- | --- |
| Data model | `prisma/schema.prisma`, `prisma/migrations/` | Postgres 16 + pgvector. Products with whisky attributes and a taste vector, customers, orders, behaviour events, identity links, merchant rules, menu items, legal rules per country |
| Whisky attributes | `app/lib/catalog/extract.ts`, `taste.ts` | Reads the store's own `custom.*` metafields first (ABV, age, region, cask, flavour, size, single cask, exclusive, tasting notes, frequently-bought-together), then tags, then text rules. Builds a 12-dimension taste vector |
| Full sync | `app/lib/sync/bulk.server.ts` | Bulk export of products → customers → orders, in that order. Reconciles products deleted while a webhook was missed |
| Live sync | `app/routes/webhooks.sync.tsx`, `app/lib/sync/webhooks.server.ts` | Products, stock, collections, customers, orders, refunds. Each delivery processed once (de-duplicated by webhook id); failures are retried by Shopify |
| Privacy | `app/routes/webhooks.privacy.tsx` | `customers/data_request`, `customers/redact`, `shop/redact` (UK GDPR / EU GDPR) |
| Tracking pixel | `extensions/se-pixel/` | Views, searches, cart, checkout and chat clicks. **Off until switched on.** Loads only for visitors who accept analytics cookies. Sends no names, emails or addresses |
| Event ingest | `app/routes/api.events.tsx`, `app/lib/events/ingest.server.ts` | Stores events and links anonymous browsing to a customer on login or checkout |
| Chat panel | `extensions/se-chat/` | Theme app embed: launcher + full-height side panel, home menu, Explore Liquor chips, AI notice, Drinkaware link. **Off on every theme by default** |
| Admin page | `app/routes/app._index.tsx` | Sync status and counts, "Run full sync", tracking on/off, how to test privately |
| Seed | `prisma/seed.ts` | Legal rules per country (UK on; EU and US off) and the default buttons and chips |

## One-time setup (store staff with the "Develop apps" permission)

1. **Create the app** in the Shopify Dev Dashboard (dev.shopify.com) under the store's organisation.
   If the app belongs to a Partner organisation instead, choose **Custom distribution**, enter
   `the-spirits-embassy.myshopify.com`, and generate the install link.
2. **Protected customer data:** in the app's API access settings, select protected customer data
   and the **Name** and **Email** fields. For a custom app this is available without a Shopify review.
   Address and phone are not needed; the app only reads country and province.
3. **Optional, older orders:** request `read_all_orders` (orders older than 60 days), then add it to
   `scopes` in `shopify.app.toml`.
4. **Link this code to the app:** `npm install`, then `npm run config:link` and pick the app.

## Run it

```bash
cp .env.example .env              # then fill in DATABASE_URL
docker compose up -d              # local Postgres 16 + pgvector
npm install
npm run db:migrate
SHOP=the-spirits-embassy.myshopify.com npm run db:seed
npm run dev                       # Shopify CLI: tunnel, install on the store, live reload
```

In the store admin, open the app and press **Run full sync**. About 4,000 products plus all
customers and orders are copied in the background; refresh to watch progress.

### Production

Any Node 22 host with Postgres (with the `vector` extension) works: Google Cloud Run, AWS ECS,
Fly.io or Render. Build with the included `Dockerfile`; it runs migrations on start.
Set `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`, then
`npm run deploy` to push the app config, webhooks and extensions to Shopify.

## Testing privately on the live store

The chat is hidden from shoppers until you choose otherwise:

1. **Online Store › Themes ›** duplicate the live theme. **Do not publish the copy.**
2. **Customize** the copy › **App embeds** › switch on **Whisky assistant**.
3. Open the copy's **Preview** link. Shoppers on the published theme never see the panel.

**Tracking is different:** a web pixel is not tied to a theme. When switched on (app home page) it
runs on the whole storefront, for visitors who accept analytics cookies. It stays off until you
press the button.

## Tests

```bash
npm test                    # extractor + taste vectors (no database needed)
TEST_DATABASE_URL=postgresql://... npm run test:db   # full suite against a THROWAWAY database
```

`test:db` truncates tables. Never point it at the real database. The extractor tests use real
products from the store; the sync tests include the live "Monkey Shoulder Smokey Monkey" record.

## Notes for developers

- **Prisma runs without its Rust engine** (`engineType = "client"` with `@prisma/adapter-pg`):
  lighter containers and no binary downloads at runtime. `prisma migrate` still uses the schema engine.
- **One data shape:** webhook payloads carry no metafields, so product, customer and order webhooks
  refetch the record through GraphQL and reuse the bulk export's mapper (`app/lib/sync/mappers.ts`).
- **Metafield keys:** when a query filters metafields by `keys`, Shopify returns `key` already
  prefixed (`"custom.abv"`). `metafieldMap()` handles both forms.
- **Brain-owned fields** (`embedding`, `enrichment`, customer `tasteVector`, price band) are never
  overwritten by sync.
- **Long jobs:** the bulk import runs in the background inside the web process. Phase 2 moves it to
  a job queue (BullMQ + Redis) so a restart mid-import resumes cleanly.
- The `/api/events` endpoint is public by design (the pixel calls it). It accepts events only for a
  shop with tracking on, validates names and ids, caps body size and rate-limits per IP.

## Next phases

2. **Brain v1:** candidate generators (taste, bought-together, the team's own FBT links, trending,
   rarity, restock), scoring, merchant rules (pin/boost/bury/block), compliance layer
   (Scottish minimum unit pricing, no multibuy, licensed payment hours, shipping and age per country).
3. **Chat:** chips and buttons call the brain; typed questions go to Claude (Haiku first, Sonnet for
   advice) with tools only; product cards with live prices; order tracking with verification.
4. **Measure:** chat funnel, revenue per chip and rule, 10% holdout A/B test.
