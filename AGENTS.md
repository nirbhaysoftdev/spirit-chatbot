# Spirits Embassy Assistant: rules for anyone changing this code

Private Shopify app for thespiritsembassy.com (UK, dispatches from Huntly, Scotland). See README.md.

- **Read-only on store data.** Do not add `write_products`, `write_orders`, `write_customers`,
  `write_discounts` or similar scopes, and do not add mutations that change store data. The only
  write is `webPixelCreate/Update/Delete` for the app's own pixel.
- **Tracking and the chat embed stay off by default.** A person turns them on.
- **Compliance before merchant rules.** Recommendations, prices and discounts must pass the
  jurisdiction table and Scottish rules (minimum unit pricing, no multibuy/quantity discounts,
  payment 10:00–22:00, age and shipping per country) before pins/boosts apply.
- **No personal data in events.** The pixel and chat send ids, search terms and clicks only.
- **Sync is idempotent.** Webhooks can arrive twice and in any order; keep handlers safe to re-run.
- Run `npm test`, `npm run typecheck` and `npm run lint` before committing; run `npm run test:db`
  against a throwaway database when touching sync or events.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for Shopify API and platform work.
