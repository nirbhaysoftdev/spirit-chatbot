// Receives storefront events from the pixel, stores them, and stitches anonymous browsing to a
// known customer when they log in or complete a checkout.
import { Prisma, type PrismaClient } from "@prisma/client";

export const MAX_BODY_BYTES = 16_384;

export interface PixelPayload {
  shop: string;
  id: string;
  name: string;
  clientId: string;
  ts: string;
  url?: string | null;
  customerId?: string | null;
  productId?: string | null;
  variantId?: string | null;
  query?: string | null;
  collectionId?: string | null;
  orderId?: string | null;
  orderCustomerId?: string | null;
  productIds?: string[];
  price?: string | number | null;
  quantity?: number | null;
  total?: string | number | null;
  currency?: string | null;
  // chat events
  key?: string | null;
  view?: string | null;
  source?: string | null;
}

const ALLOWED = new Set([
  "page_viewed",
  "product_viewed",
  "collection_viewed",
  "search_submitted",
  "product_added_to_cart",
  "product_removed_from_cart",
  "cart_viewed",
  "checkout_started",
  "checkout_completed",
  // chat panel interactions (from the theme embed via the pixel)
  "chat_opened",
  "chat_closed",
  "chat_back",
  "chat_menu_clicked",
  "chat_chip_clicked",
  "chat_message_sent",
  "chat_product_shown",
  "chat_product_clicked",
  "chat_add_to_cart",
]);

/** Pixel ids can be numeric strings or gids; store gids everywhere. */
export function toGid(type: string, id: unknown): string | null {
  if (id == null || id === "") return null;
  const s = String(id);
  if (s.startsWith("gid://")) return s;
  return /^\d+$/.test(s) ? `gid://shopify/${type}/${s}` : null;
}

const str = (v: unknown, max = 500) => (typeof v === "string" && v.length ? v.slice(0, max) : null);

export function validate(raw: unknown): PixelPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.shop !== "string" || !/^[a-z0-9-]+\.myshopify\.com$/.test(p.shop)) return null;
  if (typeof p.id !== "string" || typeof p.clientId !== "string" || typeof p.name !== "string") return null;
  if (!ALLOWED.has(p.name)) return null;
  if (typeof p.ts !== "string" || Number.isNaN(Date.parse(p.ts))) return null;
  return p as unknown as PixelPayload;
}

export function toEventRow(p: PixelPayload): Prisma.EventCreateManyInput {
  const extras: Record<string, unknown> = {};
  for (const k of ["price", "quantity", "total", "currency"] as const) if (p[k] != null) extras[k] = p[k];
  for (const k of ["key", "view", "source"] as const) {
    const v = str(p[k], 64);
    if (v) extras[k] = v;
  }
  const collectionId = toGid("Collection", p.collectionId);
  const orderId = toGid("Order", p.orderId);
  if (collectionId) extras.collectionId = collectionId;
  if (orderId) extras.orderId = orderId;
  if (p.productIds?.length) extras.productIds = p.productIds.map((x) => toGid("Product", x)).filter(Boolean);

  return {
    id: `${p.shop}:${p.id}`.slice(0, 200),
    shop: p.shop,
    clientId: p.clientId.slice(0, 100),
    customerId: toGid("Customer", p.customerId ?? p.orderCustomerId),
    name: p.name,
    productId: toGid("Product", p.productId),
    variantId: toGid("ProductVariant", p.variantId),
    query: str(p.query, 200)?.trim().toLowerCase() ?? null,
    url: str(p.url, 1000),
    data: Object.keys(extras).length ? (extras as Prisma.InputJsonValue) : Prisma.JsonNull,
    occurredAt: new Date(p.ts),
  };
}

/** Link a browser to a customer and claim that browser's earlier anonymous events. */
export async function linkIdentity(
  db: PrismaClient,
  shop: string,
  clientId: string,
  customerId: string,
  source: "login" | "checkout" | "chat_email_code",
) {
  await db.$transaction([
    db.identityLink.upsert({
      where: { shop_clientId_customerId: { shop, clientId, customerId } },
      create: { shop, clientId, customerId, source },
      update: {},
    }),
    db.event.updateMany({ where: { shop, clientId, customerId: null }, data: { customerId } }),
  ]);
}

export type IngestResult = { status: 200 | 204 | 400 | 404; stored: boolean };

export async function ingest(db: PrismaClient, raw: unknown): Promise<IngestResult> {
  const p = validate(raw);
  if (!p) return { status: 400, stored: false };

  // Only accept events for an installed shop that has switched tracking ON.
  const shop = await db.shop.findUnique({ where: { domain: p.shop }, select: { trackingEnabled: true } });
  if (!shop?.trackingEnabled) return { status: 404, stored: false };

  const row = toEventRow(p);
  const { count } = await db.event.createMany({ data: [row], skipDuplicates: true });

  if (row.customerId) {
    await linkIdentity(db, p.shop, row.clientId, row.customerId, p.name.startsWith("checkout") ? "checkout" : "login");
  } else if (p.name === "checkout_completed") {
    // Guest checkout: the order webhook may already have told us who the customer is.
    const orderId = toGid("Order", p.orderId);
    const order = orderId
      ? await db.order.findUnique({ where: { id: orderId }, select: { customerId: true } })
      : null;
    if (order?.customerId) await linkIdentity(db, p.shop, row.clientId, order.customerId, "checkout");
  }

  return { status: count ? 200 : 204, stored: count > 0 };
}

/**
 * Called after an order webhook is saved: if the pixel's checkout_completed event arrived first,
 * link that browser to the order's customer now.
 */
export async function linkCheckoutEvents(db: PrismaClient, shop: string, orderId: string, customerId: string | null) {
  if (!customerId) return 0;
  const events = await db.event.findMany({
    where: { shop, name: "checkout_completed", customerId: null, data: { path: ["orderId"], equals: orderId } },
    select: { clientId: true },
  });
  for (const e of events) await linkIdentity(db, shop, e.clientId, customerId, "checkout");
  return events.length;
}
