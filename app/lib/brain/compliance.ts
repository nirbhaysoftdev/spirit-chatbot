// Compliance layer: hard limits that no merchant rule can override.
// Runs FIRST on every recommendation list, before pins and boosts.
//
// For The Spirits Embassy: dispatch is from Huntly, so Scottish rules apply to every order
// regardless of destination. See the "Legal and compliance" section of the build doc.

import { Prisma } from "@prisma/client";

export interface CandidateProduct {
  id: string;
  title: string;
  abv: Prisma.Decimal | number | null;
  volumeMl: number | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  status: string | null;
  price: Prisma.Decimal | number;
  compareAtPrice: Prisma.Decimal | number | null;
}

export type ComplianceReason =
  | "OUT_OF_STOCK"
  | "NOT_ACTIVE"
  | "MUP_FLOOR"
  | "MULTIBUY_BLOCKED"
  | "LICENSED_HOURS"
  | "SHIP_BLOCKED"
  | "AGE_BLOCKED";

export interface ComplianceContext {
  /** ISO country code of the destination (shipping or shopper locale). */
  countryCode: string | null;
  /** Shopper's declared age (18+ gate). Null = unknown; treat as 18+ unless explicitly younger. */
  shopperAge?: number | null;
  /** When the chat/checkout is happening in Scotland local time (BST/GMT). */
  now?: Date;
  /** Jurisdiction rules from the DB, keyed by country code. */
  jurisdictions: Map<string, { shippingEnabled: boolean; minimumAge: number }>;
}

/**
 * Minimum unit price floor for Scotland.
 * Formula: MUP (£0.65) × ABV (%) × volume (litres).
 * A 700ml 40% whisky: 0.65 × 40 × 0.7 = £18.20.
 */
export const MUP_PENCE = 65;

export function mupFloor(abv: number, volumeMl: number): number {
  // Returns pounds, rounded to 2dp.
  const pence = MUP_PENCE * abv * (volumeMl / 1000);
  return Math.round(pence) / 100;
}

export function toNumber(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === "number" ? v : Number(v.toString());
}

/** True while Scotland allows off-sales payment (10:00–22:00 local time). */
export function withinLicensedHours(now: Date = new Date()): boolean {
  // Scotland is BST (UTC+1) in summer, GMT (UTC+0) in winter. Both are handled by the
  // Europe/London zone, which exists everywhere this code runs.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value);
  return h >= 10 && h < 22;
}

/**
 * Decide whether a product can be recommended in this context.
 * Returns null when the product is OK, or a reason code that blocks it.
 */
export function checkProduct(p: CandidateProduct, ctx: ComplianceContext): ComplianceReason | null {
  // ── Stock and status
  if (p.status === "DELETED" || p.status === "ARCHIVED") return "NOT_ACTIVE";
  if (!p.availableForSale) return "OUT_OF_STOCK";
  if (p.inventoryQuantity != null && p.inventoryQuantity <= 0) return "OUT_OF_STOCK";

  // ── MUP floor (Scotland dispatch applies to every order)
  const abv = toNumber(p.abv);
  const volume = p.volumeMl;
  const price = toNumber(p.price) ?? 0;
  if (abv != null && volume != null) {
    const floor = mupFloor(abv, volume);
    if (price + 0.001 < floor) return "MUP_FLOOR"; // tolerance for float rounding
  }

  // ── Shipping jurisdiction
  if (ctx.countryCode) {
    const j = ctx.jurisdictions.get(ctx.countryCode);
    if (!j || !j.shippingEnabled) return "SHIP_BLOCKED";
    if (ctx.shopperAge != null && ctx.shopperAge < j.minimumAge) return "AGE_BLOCKED";
  }

  return null;
}

/**
 * Compliance guard on a discount. Blocks multibuy / quantity discounts (Scotland rule) and
 * any discount that would push the final price below the MUP floor.
 */
export function checkDiscount(args: {
  product: CandidateProduct;
  discountedPrice: number;
  kind: "percentage" | "fixed" | "multibuy" | "bundle";
}): ComplianceReason | null {
  if (args.kind === "multibuy" || args.kind === "bundle") return "MULTIBUY_BLOCKED";

  const abv = toNumber(args.product.abv);
  const volume = args.product.volumeMl;
  if (abv != null && volume != null) {
    const floor = mupFloor(abv, volume);
    if (args.discountedPrice + 0.001 < floor) return "MUP_FLOOR";
  }
  return null;
}

/**
 * Checkout gate: whether payment can be taken right now. Chat and browsing stay open 24/7;
 * only the final charge is restricted.
 */
export function checkCheckout(ctx: ComplianceContext): ComplianceReason | null {
  if (!withinLicensedHours(ctx.now)) return "LICENSED_HOURS";
  return null;
}

export interface FilterResult<T extends CandidateProduct> {
  kept: T[];
  blocked: { product: T; reason: ComplianceReason }[];
}

export function filterCandidates<T extends CandidateProduct>(products: T[], ctx: ComplianceContext): FilterResult<T> {
  const kept: T[] = [];
  const blocked: { product: T; reason: ComplianceReason }[] = [];
  for (const p of products) {
    const reason = checkProduct(p, ctx);
    if (reason) blocked.push({ product: p, reason });
    else kept.push(p);
  }
  return { kept, blocked };
}

/** Writes an audit row for each blocked product. Safe to await without blocking the chat reply. */
export async function logBlocked(
  db: { complianceLog: { createMany: (args: { data: Prisma.ComplianceLogCreateManyInput[] }) => Promise<unknown> } },
  shop: string,
  blocked: { product: CandidateProduct; reason: ComplianceReason }[],
  context: Record<string, unknown> = {},
) {
  if (!blocked.length) return;
  await db.complianceLog.createMany({
    data: blocked.map((b) => ({
      shop,
      rule: b.reason,
      subject: b.product.id,
      detail: { title: b.product.title, price: toNumber(b.product.price), ...context } as Prisma.InputJsonValue,
    })),
  });
}
