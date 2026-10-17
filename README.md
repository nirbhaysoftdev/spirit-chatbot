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

**Preview on the live store, hidden from shoppers:** see [docs/PREVIEW.md](docs/PREVIEW.md) for
a one-command setup. On macOS/Linux/WSL:

```bash
bash scripts/preview.sh
```

The script starts Postgres, runs migrations, seeds defaults, then opens the Shopify CLI tunnel
and prints the install link. You install the app on the store, duplicate the live theme (do not
publish the copy), enable the embed on the copy and preview it — shoppers on the published theme
never see it.

**Manual run:**

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

## Phase 2: the brain (shipped)

| Part | Where | What it does |
| --- | --- | --- |
| Compliance layer | `app/lib/brain/compliance.ts` | Hard limits run FIRST on every pick: Scottish MUP floor (65p per unit), no multibuy, 10:00–22:00 payment window, shipping and age per country. Blocks are logged |
| Candidate generators | `app/lib/brain/candidates.server.ts` | Taste match (12-dim cosine), store's own FBT/upsell links, co-buy from past orders, trending (48h events), rare finds, restock for the customer, bestsellers, new arrivals, deals (72h stable price), top on-site searches |
| Scoring + rules + MMR | `app/lib/brain/score.ts` | Final score = source + taste + price fit + quality + novelty. Merchant rules (PIN/BOOST/BURY/BLOCK) scoped by chip, country, segment and dates. MMR diversity so the list isn't 5 near-identical bottles |
| Entry point | `app/lib/brain/recommend.server.ts` | One `recommend(db, { chip, customerId, countryCode, ... })` call per chip. Loads context, picks the pipeline, filters, scores, applies rules, diversifies |
| Chip API | `app/routes/api.chips.tsx` | Public endpoint the storefront panel calls. Returns UI-ready items with reason codes and the "why" line, with live prices |
| Chat panel | `extensions/se-chat/` | Chips now show real product cards (title, vendor · region · style, price with was-price, "why", pin badge). Clicks are tracked |

### How a recommendation is built, in order
1. **Compliance** removes anything out of stock, below MUP, not shippable to the country, or deleted.
2. **Score** = source weight × its raw rank + taste similarity + price fit + quality + novelty.
3. **Rules** block, pin, boost or bury — scoped by chip, country, segment and dates.
4. **Diversity (MMR)** picks the final list so smoky and sherried styles are mixed.
5. The checkout gate (`LICENSED_HOURS`) is reported separately so the chat can tell the shopper when to come back.

## Next phases

3. **Chat (free-text):** typed questions go to Claude (Haiku first, Sonnet for advice) with the brain's tools; order tracking with login or email code; human handoff.
4. **Measure:** chat funnel, revenue per chip and rule, 10% holdout A/B test.
