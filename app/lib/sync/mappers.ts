// Pure functions: Shopify GraphQL node → database rows. No I/O, fully unit-tested.
// Used by both the bulk backfill and the per-webhook refetch.
import { Prisma } from "@prisma/client";
import { extractAttributes, stripHtml, type MetafieldMap } from "../catalog/extract";
import { tasteVector, hasTasteSignal } from "../catalog/taste";

// ── GraphQL node shapes (match app/lib/sync/queries.ts) ──

export interface MetafieldNode {
  id?: string;
  namespace: string;
  key: string;
  value: string | null;
}
export interface VariantNode {
  id: string;
  title?: string | null;
  sku?: string | null;
  price: string;
  compareAtPrice?: string | null;
  inventoryQuantity?: number | null;
  availableForSale?: boolean | null;
  inventoryItem?: { id: string } | null;
}
export interface ProductNode {
  id: string;
  handle: string;
  title: string;
  vendor?: string | null;
  productType?: string | null;
  status?: string | null;
  tags?: string[];
  descriptionHtml?: string | null;
  publishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  featuredMedia?: { preview?: { image?: { url?: string } | null } | null } | null;
}
export interface CustomerNode {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  tags?: string[];
  numberOfOrders?: string | number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  amountSpent?: { amount: string } | null;
  defaultEmailAddress?: { emailAddress: string; marketingState?: string | null } | null;
  defaultAddress?: { countryCodeV2?: string | null } | null;
}
export interface Attribute {
  key: string;
  value: string | null;
}
export interface LineItemNode {
  id: string;
  title: string;
  quantity: number;
  originalUnitPriceSet?: { shopMoney: { amount: string } } | null;
  product?: { id: string } | null;
  variant?: { id: string } | null;
  customAttributes?: Attribute[];
}
export interface OrderNode {
  id: string;
  name: string;
  email?: string | null;
  currencyCode?: string | null;
  cancelledAt?: string | null;
  processedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  totalPriceSet?: { shopMoney: { amount: string } } | null;
  customer?: { id: string } | null;
  shippingAddress?: { countryCodeV2?: string | null; provinceCode?: string | null } | null;
  customAttributes?: Attribute[];
}

// Cart attribute / line property names written by the chat widget when it adds to cart.
// Leading underscore = hidden from the shopper at checkout.
export const CHAT_SESSION_ATTR = "_se_chat_session";
export const CHAT_REC_PROP = "_rec";

const date = (v?: string | null) => (v ? new Date(v) : null);
const dec = (v?: string | null) => (v == null || v === "" ? null : new Prisma.Decimal(v));

/**
 * Turn metafield nodes into a "namespace.key" map.
 * Shopify returns `key` already prefixed ("custom.abv") when the query filters by `keys`,
 * and bare ("abv") otherwise; both are handled.
 */
export function metafieldMap(nodes: MetafieldNode[]): MetafieldMap {
  const map: MetafieldMap = {};
  for (const n of nodes) {
    const full = n.key.includes(".") ? n.key : `${n.namespace}.${n.key}`;
    map[full] = n.value;
  }
  return map;
}

export function mapProduct(shop: string, p: ProductNode, metafields: MetafieldNode[]) {
  const description = stripHtml(p.descriptionHtml);
  const mf = metafieldMap(metafields);
  // tasting notes are stored as HTML in the store
  if (mf["custom.tasting_notes"]) mf["custom.tasting_notes"] = stripHtml(mf["custom.tasting_notes"]);

  const a = extractAttributes({
    title: p.title,
    description,
    tags: p.tags ?? [],
    productType: p.productType,
    vendor: p.vendor,
    metafields: mf,
  });

  const row = {
    id: p.id,
    shop,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor ?? null,
    productType: p.productType ?? null,
    status: p.status ?? null,
    tags: p.tags ?? [],
    description,
    imageUrl: p.featuredMedia?.preview?.image?.url ?? null,
    publishedAt: date(p.publishedAt),
    createdAt: date(p.createdAt),
    updatedAt: date(p.updatedAt),
    deletedAt: null,
    region: a.region,
    style: a.style,
    distillery: a.distillery,
    ageYears: a.ageYears,
    noAgeStatement: a.noAgeStatement,
    abv: a.abv == null ? null : new Prisma.Decimal(a.abv),
    volumeMl: a.volumeMl,
    sizeLabel: a.sizeLabel,
    caskTypes: a.caskTypes,
    flavours: a.flavours,
    peated: a.peated,
    outturn: a.outturn,
    vintage: a.vintage,
    singleCask: a.singleCask,
    limitedEdition: a.limitedEdition,
    exclusive: a.exclusive,
    tastingNotes: a.tastingNotes,
    fbtProductIds: a.fbtProductIds,
    upsellIds: a.upsellIds,
    sources: a.sources as Prisma.InputJsonValue,
    tasteVector: hasTasteSignal(a) ? tasteVector(a) : [],
  } satisfies Prisma.ProductUncheckedCreateInput;
  return row;
}

export function mapVariant(shop: string, productId: string, v: VariantNode) {
  return {
    id: v.id,
    productId,
    shop,
    title: v.title ?? null,
    sku: v.sku || null,
    price: new Prisma.Decimal(v.price),
    compareAtPrice: dec(v.compareAtPrice),
    inventoryItemId: v.inventoryItem?.id ?? null,
    inventoryQuantity: v.inventoryQuantity ?? null,
    availableForSale: v.availableForSale ?? true,
  } satisfies Prisma.VariantUncheckedCreateInput;
}

export function mapCustomer(shop: string, c: CustomerNode) {
  return {
    id: c.id,
    shop,
    email: c.defaultEmailAddress?.emailAddress?.trim().toLowerCase() || null,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    countryCode: c.defaultAddress?.countryCodeV2 ?? null,
    tags: c.tags ?? [],
    numberOfOrders: Number(c.numberOfOrders ?? 0),
    amountSpent: new Prisma.Decimal(c.amountSpent?.amount ?? "0"),
    marketingConsent: c.defaultEmailAddress?.marketingState ?? null,
    createdAt: date(c.createdAt),
    updatedAt: date(c.updatedAt),
  } satisfies Prisma.CustomerUncheckedCreateInput;
}

export function attr(list: Attribute[] | undefined, key: string): string | null {
  return list?.find((a) => a.key === key)?.value ?? null;
}

export function mapOrder(shop: string, o: OrderNode) {
  const chatSessionId = attr(o.customAttributes, CHAT_SESSION_ATTR);
  return {
    id: o.id,
    shop,
    name: o.name,
    customerId: o.customer?.id ?? null,
    email: o.email?.trim().toLowerCase() || null,
    currency: o.currencyCode ?? null,
    totalPrice: new Prisma.Decimal(o.totalPriceSet?.shopMoney.amount ?? "0"),
    financialStatus: o.displayFinancialStatus ?? null,
    fulfillmentStatus: o.displayFulfillmentStatus ?? null,
    cancelledAt: date(o.cancelledAt),
    shipCountryCode: o.shippingAddress?.countryCodeV2 ?? null,
    shipProvinceCode: o.shippingAddress?.provinceCode ?? null,
    processedAt: date(o.processedAt),
    createdAt: date(o.createdAt),
    updatedAt: date(o.updatedAt),
    chatSessionId,
    // "direct" = added to cart from the chat. "assisted" is decided later from pixel events.
    attribution: chatSessionId ? "direct" : null,
  } satisfies Prisma.OrderUncheckedCreateInput;
}

export function mapLine(orderId: string, l: LineItemNode) {
  return {
    id: l.id,
    orderId,
    productId: l.product?.id ?? null,
    variantId: l.variant?.id ?? null,
    title: l.title,
    quantity: l.quantity,
    price: new Prisma.Decimal(l.originalUnitPriceSet?.shopMoney.amount ?? "0"),
    recReason: attr(l.customAttributes, CHAT_REC_PROP),
  } satisfies Prisma.OrderLineUncheckedCreateInput;
}

// ── Bulk JSONL ──
// With groupObjects:false every object is its own line; children carry __parentId.

export type BulkLine = Record<string, unknown> & { id?: string; __parentId?: string };

export function gidType(id: string | undefined): string | null {
  const m = id?.match(/^gid:\/\/shopify\/([A-Za-z]+)\//);
  return m ? m[1] : null;
}

/**
 * Group bulk lines into parents with their children. Does not assume any line order
 * (Shopify does not guarantee parents come before children when groupObjects is false).
 */
export function groupBulk(lines: Iterable<BulkLine>): { parent: BulkLine; children: BulkLine[] }[] {
  const parents: BulkLine[] = [];
  const kids = new Map<string, BulkLine[]>();
  for (const line of lines) {
    if (line.__parentId) {
      const list = kids.get(line.__parentId);
      if (list) list.push(line);
      else kids.set(line.__parentId, [line]);
    } else {
      parents.push(line);
    }
  }
  return parents.map((parent) => ({ parent, children: kids.get(parent.id as string) ?? [] }));
}

export function parseJsonl(text: string): BulkLine[] {
  const out: BulkLine[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line) out.push(JSON.parse(line));
  }
  return out;
}
