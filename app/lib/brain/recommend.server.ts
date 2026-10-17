// Top-level recommendation entry point. One function per chip.
// Signature: recommend(db, { shop, chip, customerId, countryCode, now, n })
//   → { items: Scored[], blocked: ..., appliedRules: ... }
//
// The chat calls one of these from the server; nothing else needs the brain's internals.

import type { PrismaClient } from "@prisma/client";
import {
  bestsellers,
  coBuy,
  deals,
  loadByIds,
  newArrivals,
  rareFinds,
  restockForCustomer,
  tasteMatches,
  tasteProfileForCustomer,
  trending,
  type Candidate,
  type GeneratorInput,
} from "./candidates.server";
import {
  checkCheckout,
  filterCandidates,
  logBlocked,
  type ComplianceContext,
  type ComplianceReason,
} from "./compliance";
import {
  applyRules,
  buildList,
  mergeCandidates,
  scoreAll,
  type Rule,
  type Scored,
} from "./score";

export type ChipKey =
  | "best_deals"
  | "best_for_me"
  | "matches_taste"
  | "rarest"
  | "trending"
  | "most_demanded"
  | "most_searched"
  | "new_arrivals";

export interface RecommendInput {
  shop: string;
  chip: ChipKey;
  customerId?: string | null;
  countryCode?: string | null;
  shopperAge?: number | null;
  now?: Date;
  n?: number;
}

export interface RecommendResult {
  items: Scored[];
  /** Per-reason count of what the compliance layer filtered out. */
  complianceBlocked: Record<ComplianceReason, number>;
  /** Shopper-blocked by a merchant rule. */
  ruleBlocked: Scored[];
  /** When set, the checkout cannot be completed right now (payment outside licensed hours). */
  checkoutBlocked: ComplianceReason | null;
}

// ── Load the context the brain needs for one request ────────────────────────

async function loadContext(db: PrismaClient, in_: RecommendInput) {
  const [jurisdictions, rules, excluded, customer] = await Promise.all([
    db.jurisdiction.findMany({
      where: { shop: in_.shop },
      select: { code: true, shippingEnabled: true, minimumAge: true },
    }),
    db.rule.findMany({ where: { shop: in_.shop, active: true } }),
    in_.customerId ? excludedForCustomer(db, in_.shop, in_.customerId) : Promise.resolve(new Set<string>()),
    in_.customerId ? db.customer.findUnique({
      where: { id: in_.customerId },
      select: { tasteVector: true, priceBandLow: true, priceBandHigh: true },
    }) : Promise.resolve(null),
  ]);
  const jurMap = new Map(jurisdictions.map((j) => [j.code, { shippingEnabled: j.shippingEnabled, minimumAge: j.minimumAge }]));
  return { jurMap, rules: rules as unknown as Rule[], excluded, customer };
}

/** Products the shopper already owns (don't recommend again, unless a core repeat bottle). */
async function excludedForCustomer(db: PrismaClient, shop: string, customerId: string): Promise<Set<string>> {
  const rows = await db.$queryRaw<{ product_id: string }[]>`
    SELECT DISTINCT l."productId" AS product_id
    FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
    WHERE o.shop = ${shop} AND o."customerId" = ${customerId}
      AND l."productId" IS NOT NULL
      AND o."processedAt" >= NOW() - INTERVAL '365 days'
  `;
  return new Set(rows.map((r) => r.product_id));
}

async function tasteFor(db: PrismaClient, in_: RecommendInput, saved: number[] | null | undefined): Promise<number[]> {
  if (saved && saved.length) return saved;
  if (!in_.customerId) return [];
  return tasteProfileForCustomer(db, in_.shop, in_.customerId);
}

// ── Candidate pipelines per chip ────────────────────────────────────────────

async function pipelineFor(
  db: PrismaClient,
  in_: RecommendInput,
  taste: number[],
  gen: GeneratorInput,
): Promise<Candidate[][]> {
  switch (in_.chip) {
    case "matches_taste":
      return [await tasteMatches(db, gen, taste)];

    case "best_for_me": {
      // Personal: taste + restock + co-buy from the shopper's past purchases.
      const [t, r] = await Promise.all([tasteMatches(db, gen, taste), restockForCustomer(db, gen)]);
      let cob: Candidate[] = [];
      if (in_.customerId) {
        const past = await db.order.findMany({
          where: { shop: in_.shop, customerId: in_.customerId },
          take: 20,
          orderBy: { processedAt: "desc" },
          select: { lines: { select: { productId: true } } },
        });
        const anchors = [...new Set(past.flatMap((o) => o.lines.map((l) => l.productId).filter((id): id is string => !!id)))];
        cob = await coBuy(db, gen, anchors.slice(0, 20));
      }
      // Cold start: fall back to trending + bestsellers so a new shopper still sees good picks.
      if (!t.length && !r.length && !cob.length) {
        return [await trending(db, gen), await bestsellers(db, gen)];
      }
      return [t, r, cob];
    }

    case "rarest":
      return [await rareFinds(db, gen)];

    case "trending":
      return [await trending(db, gen, 48)];

    case "most_demanded": {
      // Views + register-interest + sold-out demand over the last 14 days.
      const since = new Date(Date.now() - 14 * 86400_000);
      const rows = await db.$queryRaw<{ product_id: string; w: number }[]>`
        SELECT "productId" AS product_id,
               SUM(CASE "name"
                     WHEN 'product_viewed' THEN 1
                     WHEN 'product_added_to_cart' THEN 4
                     WHEN 'cart_viewed' THEN 0
                     ELSE 0
                   END)::float AS w
        FROM "Event"
        WHERE "shop" = ${in_.shop} AND "productId" IS NOT NULL AND "occurredAt" >= ${since}
        GROUP BY "productId"
        HAVING SUM(CASE WHEN "name" IN ('product_viewed','product_added_to_cart') THEN 1 ELSE 0 END) > 5
        ORDER BY w DESC LIMIT 60
      `;
      const ids = rows.map((r) => r.product_id);
      if (!ids.length) return [await trending(db, gen)];
      return [await trending(db, { ...gen, n: 50 }, 24 * 14), (await trending(db, gen, 72)).filter((c) => ids.includes(c.id))];
    }

    case "most_searched": {
      const since = new Date(Date.now() - 7 * 86400_000);
      const terms = await db.$queryRaw<{ query: string; n: bigint }[]>`
        SELECT "query", COUNT(*)::bigint AS n
        FROM "Event"
        WHERE shop = ${in_.shop} AND "name" = 'search_submitted' AND "query" IS NOT NULL AND "occurredAt" >= ${since}
        GROUP BY "query" ORDER BY n DESC LIMIT 20
      `;
      // Each top term resolves to a few matching products (title ILIKE).
      // Cheap and good enough for phase 2; replace with full-text search in phase 3.
      const perTerm = await Promise.all(
        terms.map(async (t) => {
          const products = await db.product.findMany({
            where: {
              shop: in_.shop,
              deletedAt: null,
              status: "ACTIVE",
              OR: [{ title: { contains: t.query, mode: "insensitive" } }, { vendor: { contains: t.query, mode: "insensitive" } }],
            },
            select: { id: true },
            take: 5,
          });
          return products.map((p) => p.id);
        }),
      );
      const uniq = [...new Set(perTerm.flat())];
      const scoreMap = new Map(uniq.map((id, i) => [id, 1 - i / Math.max(uniq.length, 1)]));
      return [await loadByIds(db, in_.shop, uniq, "SEARCHED_TERM", (id) => scoreMap.get(id) ?? 0)];
    }

    case "new_arrivals":
      return [await newArrivals(db, gen)];

    case "best_deals":
      return [await deals(db, gen, 72)];
  }
}

// ── Main entry point ────────────────────────────────────────────────────────

export async function recommend(db: PrismaClient, in_: RecommendInput): Promise<RecommendResult> {
  const n = in_.n ?? 6;
  const ctx = await loadContext(db, in_);
  const taste = await tasteFor(db, in_, ctx.customer?.tasteVector);
  const priceBand = ctx.customer?.priceBandLow && ctx.customer?.priceBandHigh
    ? { low: Number(ctx.customer.priceBandLow.toString()), high: Number(ctx.customer.priceBandHigh.toString()) }
    : null;

  const gen: GeneratorInput = { shop: in_.shop, n: 50, customerId: in_.customerId, excludeProductIds: ctx.excluded };
  const lists = await pipelineFor(db, in_, taste, gen);
  const merged = mergeCandidates(lists);

  // Compliance
  const compCtx: ComplianceContext = {
    countryCode: in_.countryCode ?? null,
    shopperAge: in_.shopperAge ?? null,
    now: in_.now,
    jurisdictions: ctx.jurMap,
  };
  const filtered = filterCandidates(merged, compCtx);
  // Audit log is best-effort; a failure here must not break the chat response.
  logBlocked(db, in_.shop, filtered.blocked, { chip: in_.chip, countryCode: in_.countryCode ?? null }).catch(() => {});

  // Score
  const scored = scoreAll(filtered.kept, { chip: in_.chip, countryCode: in_.countryCode ?? null, priceBand, tasteVector: taste });

  // Rules + diversity
  const ruled = applyRules(scored, ctx.rules, { chip: in_.chip, countryCode: in_.countryCode ?? null }, in_.now);
  const built = buildList(ruled, n);

  // Checkout gate (not applied here; the agent reads this to tell the shopper when to come back).
  const checkoutBlocked = checkCheckout(compCtx);

  // Count blocks per reason
  const complianceBlocked = filtered.blocked.reduce(
    (acc, b) => { acc[b.reason] = (acc[b.reason] ?? 0) + 1; return acc; },
    {} as Record<ComplianceReason, number>,
  );

  return { items: built.items, complianceBlocked, ruleBlocked: built.blockedByRule, checkoutBlocked };
}
