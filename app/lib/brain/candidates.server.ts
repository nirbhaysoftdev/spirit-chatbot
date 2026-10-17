// Candidate generators: each one returns up to N products with a reason code.
// They are deliberately independent — the scorer mixes them. Every generator uses the SAME
// select shape, so the rest of the brain treats them as one list.

import { Prisma, type PrismaClient } from "@prisma/client";
import { cosine, type TasteDimension, TASTE_DIMENSIONS } from "../catalog/taste";
import type { CandidateProduct } from "./compliance";

// Reason codes travel with each product and are what the chat agent is allowed to say to the shopper.
export type ReasonCode =
  | "TASTE_MATCH"
  | "BOUGHT_SIMILAR"
  | "COBUY"
  | "STORE_FBT"
  | "STORE_UPSELL"
  | "TRENDING"
  | "RARE_FIND"
  | "RARE_LOW_STOCK"
  | "RESTOCK_DUE"
  | "RETURNING_FAVOURITE"
  | "BESTSELLER"
  | "NEW_ARRIVAL"
  | "ON_SALE"
  | "COMPLEMENTS"
  | "SEARCHED_TERM";

export interface Candidate extends CandidateProduct {
  shop: string;
  vendor: string | null;
  region: string | null;
  style: string | null;
  tasteVector: number[];
  flavours: string[];
  caskTypes: string[];
  peated: boolean | null;
  outturn: number | null;
  ageYears: number | null;
  singleCask: boolean | null;
  limitedEdition: boolean | null;
  exclusive: boolean | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  reason: ReasonCode;
  /** 0–1 within this generator; the scorer rescales these to the final rank. */
  rawScore: number;
  /** Extra bits the agent might show to the shopper, e.g. "4 left". */
  extras?: Record<string, string | number | null>;
}

/** Columns the generators read. Keep in sync with the Candidate type. */
export const CANDIDATE_SELECT = {
  id: true,
  title: true,
  shop: true,
  vendor: true,
  region: true,
  style: true,
  abv: true,
  volumeMl: true,
  status: true,
  tasteVector: true,
  flavours: true,
  caskTypes: true,
  peated: true,
  outturn: true,
  ageYears: true,
  singleCask: true,
  limitedEdition: true,
  exclusive: true,
  publishedAt: true,
  updatedAt: true,
} as const;

const VARIANT_SELECT = {
  select: { id: true, price: true, compareAtPrice: true, inventoryQuantity: true, availableForSale: true },
  take: 1,
  orderBy: { id: "asc" as const }, // Variant has no `position` column; id order is stable per product
} as const;

type RawRow = Prisma.ProductGetPayload<{ select: typeof CANDIDATE_SELECT & { variants: typeof VARIANT_SELECT } }>;

function toCandidate(row: RawRow, reason: ReasonCode, rawScore: number, extras?: Candidate["extras"]): Candidate | null {
  const v = row.variants[0];
  if (!v) return null; // no sellable variant
  return {
    id: row.id,
    title: row.title,
    shop: row.shop,
    vendor: row.vendor,
    region: row.region,
    style: row.style,
    abv: row.abv,
    volumeMl: row.volumeMl,
    status: row.status,
    availableForSale: v.availableForSale,
    inventoryQuantity: v.inventoryQuantity,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    tasteVector: row.tasteVector,
    flavours: row.flavours,
    caskTypes: row.caskTypes,
    peated: row.peated,
    outturn: row.outturn,
    ageYears: row.ageYears,
    singleCask: row.singleCask,
    limitedEdition: row.limitedEdition,
    exclusive: row.exclusive,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    reason,
    rawScore,
    extras,
  };
}

const liveProduct = (shop: string) => ({ shop, deletedAt: null, status: "ACTIVE" }) satisfies Prisma.ProductWhereInput;

export interface GeneratorInput {
  shop: string;
  n?: number;
  /** Known customer, when the shopper is identified. */
  customerId?: string | null;
  /** Products the shopper already owns or is in-cart with: never recommend these again. */
  excludeProductIds?: Iterable<string>;
}

// ── Shared helper: load products by ids, in the order given, with the latest variant ──
export async function loadByIds(db: PrismaClient, shop: string, ids: string[], reason: ReasonCode, scoreOf: (id: string, idx: number) => number) {
  if (!ids.length) return [];
  const rows = await db.product.findMany({
    where: { ...liveProduct(shop), id: { in: ids } },
    select: { ...CANDIDATE_SELECT, variants: VARIANT_SELECT },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Candidate[] = [];
  ids.forEach((id, i) => {
    const r = byId.get(id);
    if (r) {
      const c = toCandidate(r, reason, scoreOf(id, i));
      if (c) out.push(c);
    }
  });
  return out;
}

// ── 1. Taste match ──────────────────────────────────────────────────────────
// Needs a taste vector for the shopper (built from their orders in buildTasteProfile).

export async function tasteMatches(db: PrismaClient, in_: GeneratorInput, taste: number[]): Promise<Candidate[]> {
  if (!taste.length || taste.every((v) => v === 0)) return [];
  const exclude = new Set(in_.excludeProductIds ?? []);
  // Pull a reasonable candidate pool, then rank in memory. For 4000 products this is fast
  // (~ms) and keeps the brain stateless; a pgvector ANN index can replace it later.
  const pool = await db.product.findMany({
    where: { ...liveProduct(in_.shop), NOT: { tasteVector: { isEmpty: true } } },
    select: { ...CANDIDATE_SELECT, variants: VARIANT_SELECT },
    take: 1500,
  });
  const scored = pool
    .filter((p) => !exclude.has(p.id))
    .map((p) => ({ p, s: cosine(taste, p.tasteVector) }))
    .filter(({ s }) => s > 0.2)
    .sort((a, b) => b.s - a.s)
    .slice(0, in_.n ?? 50);
  return scored
    .map(({ p, s }) => toCandidate(p, "TASTE_MATCH", s))
    .filter((c): c is Candidate => !!c);
}

// ── 2. Store's own "frequently bought together" + upsell lists ──────────────
// These were curated by the team as product metafields during sync.

export async function storeFbt(db: PrismaClient, in_: GeneratorInput, anchorProductIds: string[]): Promise<Candidate[]> {
  if (!anchorProductIds.length) return [];
  const anchors = await db.product.findMany({
    where: { shop: in_.shop, id: { in: anchorProductIds } },
    select: { id: true, fbtProductIds: true, upsellIds: true },
  });
  const fbt = new Set<string>();
  const up = new Set<string>();
  for (const a of anchors) {
    for (const id of a.fbtProductIds) fbt.add(id);
    for (const id of a.upsellIds) up.add(id);
  }
  const exclude = new Set([...(in_.excludeProductIds ?? []), ...anchorProductIds]);
  const fbtOnly = [...fbt].filter((id) => !exclude.has(id));
  const upOnly = [...up].filter((id) => !exclude.has(id) && !fbt.has(id));
  const a = await loadByIds(db, in_.shop, fbtOnly, "STORE_FBT", () => 1);
  const b = await loadByIds(db, in_.shop, upOnly, "STORE_UPSELL", () => 0.8);
  return [...a, ...b];
}

// ── 3. Co-buy (from the store's own orders) ─────────────────────────────────
// Products that frequently appear alongside the anchors in past orders.

export async function coBuy(db: PrismaClient, in_: GeneratorInput, anchorProductIds: string[]): Promise<Candidate[]> {
  if (!anchorProductIds.length) return [];
  // Co-occurrence inside one order. Grouped and ranked by Postgres so we read small rows only.
  const rows = await db.$queryRaw<{ product_id: string; cnt: bigint }[]>`
    SELECT l2."productId" AS product_id, COUNT(DISTINCT l1."orderId")::bigint AS cnt
    FROM "OrderLine" l1
    JOIN "OrderLine" l2 ON l1."orderId" = l2."orderId" AND l1."productId" <> l2."productId"
    JOIN "Order" o ON o.id = l1."orderId"
    WHERE o.shop = ${in_.shop}
      AND l1."productId" = ANY(${anchorProductIds}::text[])
      AND l2."productId" IS NOT NULL
    GROUP BY l2."productId"
    ORDER BY cnt DESC
    LIMIT ${in_.n ?? 50}
  `;
  const exclude = new Set([...(in_.excludeProductIds ?? []), ...anchorProductIds]);
  const ids = rows.filter((r) => !exclude.has(r.product_id)).map((r) => r.product_id);
  const max = Number(rows[0]?.cnt ?? 1);
  const scores = new Map(rows.map((r) => [r.product_id, Number(r.cnt) / max]));
  return loadByIds(db, in_.shop, ids, "COBUY", (id) => scores.get(id) ?? 0);
}

// ── 4. Trending in the last 48h (pixel events + sales) ──────────────────────

export async function trending(db: PrismaClient, in_: GeneratorInput, windowHours = 48): Promise<Candidate[]> {
  const since = new Date(Date.now() - windowHours * 3600_000);
  const rows = await db.$queryRaw<{ product_id: string; weight: number }[]>`
    SELECT "productId" AS product_id,
           SUM(CASE "name"
                 WHEN 'product_viewed' THEN 1
                 WHEN 'product_added_to_cart' THEN 3
                 WHEN 'checkout_completed' THEN 5
                 ELSE 0
               END)::float AS weight
    FROM "Event"
    WHERE "shop" = ${in_.shop} AND "productId" IS NOT NULL AND "occurredAt" >= ${since}
    GROUP BY "productId"
    ORDER BY weight DESC
    LIMIT ${in_.n ?? 50}
  `;
  const exclude = new Set(in_.excludeProductIds ?? []);
  const ids = rows.filter((r) => !exclude.has(r.product_id)).map((r) => r.product_id);
  const max = rows[0]?.weight ?? 1;
  const scores = new Map(rows.map((r) => [r.product_id, r.weight / max]));
  return loadByIds(db, in_.shop, ids, "TRENDING", (id) => scores.get(id) ?? 0);
}

// ── 5. Rare finds (outturn, age, single cask, closed distillery) ────────────

export async function rareFinds(db: PrismaClient, in_: GeneratorInput): Promise<Candidate[]> {
  const exclude = [...(in_.excludeProductIds ?? [])];
  const rows = await db.product.findMany({
    where: {
      ...liveProduct(in_.shop),
      ...(exclude.length ? { id: { notIn: exclude } } : {}),
      OR: [
        { outturn: { lte: 300 } },
        { ageYears: { gte: 25 } },
        { singleCask: true },
        { exclusive: true },
      ],
    },
    select: { ...CANDIDATE_SELECT, variants: VARIANT_SELECT },
    take: 200, // narrow candidate set; the scorer picks the final few
  });

  const scored: Candidate[] = [];
  for (const r of rows) {
    const v = r.variants[0];
    if (!v) continue;
    let score = 0;
    const extras: Candidate["extras"] = {};
    if (r.outturn != null && r.outturn <= 300) {
      score += 1 - r.outturn / 300;
      extras.outturn = r.outturn;
    }
    if (r.ageYears && r.ageYears >= 25) {
      score += Math.min(1, (r.ageYears - 20) / 30);
    }
    if (r.singleCask) score += 0.4;
    if (r.exclusive) score += 0.3;
    // Pick the strongest single reason to show the shopper.
    const reason: ReasonCode = v.inventoryQuantity != null && v.inventoryQuantity <= 6 ? "RARE_LOW_STOCK" : "RARE_FIND";
    if (reason === "RARE_LOW_STOCK") extras.stockLeft = v.inventoryQuantity;
    const c = toCandidate(r, reason, Math.min(1, score / 2), extras);
    if (c) scored.push(c);
  }
  return scored.sort((a, b) => b.rawScore - a.rawScore).slice(0, in_.n ?? 50);
}

// ── 6. Replenishment / restock ──────────────────────────────────────────────
// Products the shopper bought before, now back in stock or due for a repeat.

export async function restockForCustomer(db: PrismaClient, in_: GeneratorInput): Promise<Candidate[]> {
  if (!in_.customerId) return [];
  const orders = await db.order.findMany({
    where: { shop: in_.shop, customerId: in_.customerId, cancelledAt: null },
    orderBy: { processedAt: "desc" },
    take: 50,
    select: { lines: { select: { productId: true } } },
  });
  const bought = new Set<string>();
  for (const o of orders) for (const l of o.lines) if (l.productId) bought.add(l.productId);
  if (!bought.size) return [];
  const exclude = new Set(in_.excludeProductIds ?? []);
  const ids = [...bought].filter((id) => !exclude.has(id));
  const rows = await db.product.findMany({
    where: { ...liveProduct(in_.shop), id: { in: ids } },
    select: { ...CANDIDATE_SELECT, variants: VARIANT_SELECT },
  });
  return rows
    .map((r) => toCandidate(r, "RETURNING_FAVOURITE", 1))
    .filter((c): c is Candidate => !!c);
}

// ── 7. Bestsellers (cold-start fallback) ────────────────────────────────────

export async function bestsellers(db: PrismaClient, in_: GeneratorInput): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ product_id: string; units: bigint }[]>`
    SELECT l."productId" AS product_id, SUM(l.quantity)::bigint AS units
    FROM "OrderLine" l JOIN "Order" o ON o.id = l."orderId"
    WHERE o.shop = ${in_.shop} AND o."cancelledAt" IS NULL AND l."productId" IS NOT NULL
      AND o."processedAt" >= NOW() - INTERVAL '90 days'
    GROUP BY l."productId"
    ORDER BY units DESC
    LIMIT ${in_.n ?? 50}
  `;
  const exclude = new Set(in_.excludeProductIds ?? []);
  const ids = rows.filter((r) => !exclude.has(r.product_id)).map((r) => r.product_id);
  const max = Number(rows[0]?.units ?? 1);
  const scores = new Map(rows.map((r) => [r.product_id, Number(r.units) / max]));
  return loadByIds(db, in_.shop, ids, "BESTSELLER", (id) => scores.get(id) ?? 0);
}

// ── 8. New arrivals ─────────────────────────────────────────────────────────

export async function newArrivals(db: PrismaClient, in_: GeneratorInput): Promise<Candidate[]> {
  const exclude = [...(in_.excludeProductIds ?? [])];
  const rows = await db.product.findMany({
    where: { ...liveProduct(in_.shop), publishedAt: { not: null }, ...(exclude.length ? { id: { notIn: exclude } } : {}) },
    orderBy: { publishedAt: "desc" },
    select: { ...CANDIDATE_SELECT, variants: VARIANT_SELECT },
    take: in_.n ?? 50,
  });
  const now = Date.now();
  return rows
    .map((r) => {
      const ageDays = r.publishedAt ? (now - r.publishedAt.getTime()) / 86400_000 : 999;
      return toCandidate(r, "NEW_ARRIVAL", Math.max(0, 1 - ageDays / 90));
    })
    .filter((c): c is Candidate => !!c);
}

// ── 9. Deals (on-sale items, filtered by price-stability rule) ──────────────
// Scotland requires each price to stay fixed for ≥ 72 hours, so recent price changes don't count.

export async function deals(db: PrismaClient, in_: GeneratorInput, minPriceAgeHours = 72): Promise<Candidate[]> {
  const stableSince = new Date(Date.now() - minPriceAgeHours * 3600_000);
  const exclude = [...(in_.excludeProductIds ?? [])];
  const variants = await db.variant.findMany({
    where: {
      shop: in_.shop,
      compareAtPrice: { not: null },
      availableForSale: true,
      updatedAt: { lte: stableSince },
      product: liveProduct(in_.shop),
      ...(exclude.length ? { productId: { notIn: exclude } } : {}),
    },
    select: {
      productId: true, price: true, compareAtPrice: true,
      product: { select: { ...CANDIDATE_SELECT, variants: VARIANT_SELECT } },
    },
    take: 200,
  });
  const scored: Candidate[] = [];
  for (const v of variants) {
    const price = Number(v.price);
    const was = Number(v.compareAtPrice);
    if (!(was > price && price > 0)) continue;
    const pct = (was - price) / was;
    const c = toCandidate(v.product, "ON_SALE", Math.min(1, pct * 2), { save: Number((was - price).toFixed(2)), wasPrice: was });
    if (c) scored.push(c);
  }
  return scored.sort((a, b) => b.rawScore - a.rawScore).slice(0, in_.n ?? 50);
}

// ── 10. Build a taste vector for one customer, from their order history ─────

export function buildTasteProfile(
  rows: { tasteVector: number[]; quantity: number; weight: number }[],
): number[] {
  const sum = new Array(TASTE_DIMENSIONS.length).fill(0) as number[];
  let total = 0;
  for (const r of rows) {
    if (!r.tasteVector || r.tasteVector.length !== TASTE_DIMENSIONS.length) continue;
    const w = r.weight * r.quantity;
    for (let i = 0; i < sum.length; i++) sum[i] += r.tasteVector[i] * w;
    total += w;
  }
  if (!total) return [];
  return sum.map((v) => v / total);
}

export async function tasteProfileForCustomer(db: PrismaClient, shop: string, customerId: string): Promise<number[]> {
  // Weight: purchase 5, with a 180-day half-life.
  const rows = await db.$queryRaw<{ tasteVector: number[]; quantity: number; days_ago: number }[]>`
    SELECT p."tasteVector" AS "tasteVector", l.quantity AS quantity,
           EXTRACT(EPOCH FROM NOW() - COALESCE(o."processedAt", o."createdAt")) / 86400 AS days_ago
    FROM "OrderLine" l
    JOIN "Order" o ON o.id = l."orderId"
    JOIN "Product" p ON p.id = l."productId"
    WHERE o.shop = ${shop} AND o."customerId" = ${customerId} AND o."cancelledAt" IS NULL
      AND cardinality(p."tasteVector") > 0
  `;
  return buildTasteProfile(
    rows.map((r) => ({ tasteVector: r.tasteVector, quantity: r.quantity, weight: 5 * Math.pow(0.5, r.days_ago / 180) })),
  );
}

// Re-exported for the taste.ts test
export type { TasteDimension };
