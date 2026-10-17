import type { LoaderFunctionArgs } from "react-router";
import db from "../db.server";
import { recommend, type ChipKey } from "../lib/brain/recommend.server";
import { toNumber } from "../lib/brain/compliance";

// Public endpoint the storefront chat panel calls when a chip is tapped.
// Returns a small, UI-ready JSON payload with the shopper's picks, plus the reason the brain
// chose each one. Prices are decided server-side on every call so the chat cannot show a stale price.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-store",
};

const CHIP_KEYS: ChipKey[] = ["best_deals", "best_for_me", "matches_taste", "rarest", "trending", "most_demanded", "most_searched", "new_arrivals"];

const toGid = (type: string, id: string): string | null => {
  if (!id) return null;
  if (id.startsWith("gid://")) return id;
  return /^\d+$/.test(id) ? `gid://shopify/${type}/${id}` : null;
};

// Shopper-friendly sentence per reason. The chat LLM uses this as a hint, not a verbatim string.
const REASON_LINE: Record<string, (c: { title: string; extras?: Record<string, unknown> }) => string> = {
  TASTE_MATCH: () => "Matches your taste profile.",
  STORE_FBT: () => "Often bought together.",
  STORE_UPSELL: () => "A step up from what you’ve been looking at.",
  COBUY: () => "Other shoppers who liked that bought this.",
  TRENDING: () => "Trending this week.",
  RARE_FIND: () => "A rare find.",
  RARE_LOW_STOCK: (c) => `Only ${c.extras?.stockLeft ?? "a few"} left.`,
  RETURNING_FAVOURITE: () => "You’ve bought this before.",
  BESTSELLER: () => "Among the store’s bestsellers.",
  NEW_ARRIVAL: () => "A new arrival.",
  ON_SALE: (c) => `Save £${c.extras?.save ?? ""} on this.`,
  SEARCHED_TERM: () => "A top search this week.",
  BOUGHT_SIMILAR: () => "Similar to something you bought.",
  COMPLEMENTS: () => "Complements what you’ve been looking at.",
  RESTOCK_DUE: () => "Time to restock?",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const chip = url.searchParams.get("chip") as ChipKey | null;
  const country = url.searchParams.get("country")?.toUpperCase() || null;
  const customer = url.searchParams.get("customer");
  const n = Math.min(12, Math.max(1, Number(url.searchParams.get("n") ?? 6)));

  if (!shop || !/^[a-z0-9-]+\.myshopify\.com$/.test(shop)) {
    return Response.json({ error: "bad shop" }, { status: 400, headers: CORS });
  }
  if (!chip || !CHIP_KEYS.includes(chip)) {
    return Response.json({ error: "bad chip" }, { status: 400, headers: CORS });
  }
  // The custom app only serves this one store.
  const known = await db.shop.findUnique({ where: { domain: shop }, select: { domain: true } });
  if (!known) return Response.json({ error: "shop not installed" }, { status: 404, headers: CORS });

  const customerId = customer ? toGid("Customer", customer) : null;

  try {
    const result = await recommend(db, { shop, chip, customerId, countryCode: country, n });
    const items = result.items.map((c) => {
      const price = toNumber(c.price) ?? 0;
      const was = toNumber(c.compareAtPrice);
      return {
        id: c.id,
        title: c.title,
        vendor: c.vendor,
        region: c.region,
        style: c.style,
        price,
        wasPrice: was && was > price ? was : null,
        reason: c.reason,
        reasonLine: REASON_LINE[c.reason]?.({ title: c.title, extras: c.extras }) ?? "Recommended for you.",
        extras: c.extras ?? null,
        pinned: c.appliedRule?.action === "PIN" || undefined,
      };
    });
    return Response.json(
      {
        chip,
        items,
        meta: {
          complianceBlocked: result.complianceBlocked,
          ruleBlocked: result.ruleBlocked.length,
          checkoutBlocked: result.checkoutBlocked,
        },
      },
      { headers: CORS },
    );
  } catch (e) {
    console.error("[chips] failed", e);
    return Response.json({ error: "brain error" }, { status: 500, headers: CORS });
  }
};
