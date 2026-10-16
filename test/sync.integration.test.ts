// Sync against a real Postgres with a fake Shopify Admin client.
// Product fixture is the real "Monkey Shoulder Smokey Monkey" record as returned by the live store.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { importLines, processBulkFinish, startFullBackfill } from "~/lib/sync/bulk.server";
import { handleSyncWebhook } from "~/lib/sync/webhooks.server";
import { claimWebhook, redactCustomer } from "~/lib/sync/store.server";
import type { BulkLine } from "~/lib/sync/mappers";

const url = process.env.TEST_DATABASE_URL;
const shop = "the-spirits-embassy.myshopify.com";

const PRODUCT = {
  id: "gid://shopify/Product/4479104647203",
  handle: "monkey-shoulder-batch-9-smokey-monkey-700ml-40",
  title: "Monkey Shoulder Smokey Monkey",
  vendor: "Monkey Shoulder",
  productType: "Whisky",
  status: "ACTIVE",
  tags: ["Blend", "Heavily Peated", "Monkey Shoulder", "Peaty Smokey"],
  descriptionHtml: "<p>Created to add a smoky edge to classic cocktail, Smokey Monkey is a blend of malt whiskies.</p>",
  publishedAt: "2026-08-06T14:33:28Z",
  createdAt: "2020-03-19T17:04:19Z",
  updatedAt: "2026-10-16T14:40:40Z",
  featuredMedia: { preview: { image: { url: "https://cdn.shopify.com/x.png" } } },
};
const VARIANT = {
  id: "gid://shopify/ProductVariant/31830648029219",
  title: "Default Title",
  sku: "",
  price: "23.38",
  compareAtPrice: "27.50",
  inventoryQuantity: 4,
  availableForSale: true,
  inventoryItem: { id: "gid://shopify/InventoryItem/33530290929699" },
};
// Keys come back already prefixed when the query filters by `keys` (seen on the live store).
const METAFIELDS = [
  { id: "gid://shopify/Metafield/1", namespace: "custom", key: "custom.abv", value: "40.0" },
  { id: "gid://shopify/Metafield/2", namespace: "custom", key: "custom.age", value: "NAS" },
  { id: "gid://shopify/Metafield/3", namespace: "custom", key: "custom.malt", value: "Blended Malt Scotch Whisky" },
  { id: "gid://shopify/Metafield/4", namespace: "custom", key: "custom.flavor", value: "Peaty Smokey" },
  { id: "gid://shopify/Metafield/5", namespace: "custom", key: "custom.cask_type", value: "Bourbon/American Oak" },
  { id: "gid://shopify/Metafield/6", namespace: "custom", key: "custom.tasting_notes", value: "<p><b>Nose -</b> Oak smoke, mellow vanilla.</p>" },
  { id: "gid://shopify/Metafield/7", namespace: "custom", key: "custom.fbt", value: '["gid://shopify/Product/6991488745507"]' },
  { id: "gid://shopify/Metafield/8", namespace: "descriptors", key: "descriptors.subtitle", value: "70cl" },
];

/** Fake Admin client: answers by matching the operation name in the query. */
function fakeAdmin(handlers: Record<string, (vars: Record<string, unknown>) => unknown>) {
  const calls: string[] = [];
  return {
    calls,
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      const name = Object.keys(handlers).find((k) => query.includes(k));
      if (!name) throw new Error(`unexpected query: ${query.slice(0, 80)}`);
      calls.push(name);
      return new Response(JSON.stringify({ data: handlers[name](options?.variables ?? {}) }));
    },
  };
}

describe.skipIf(!url)("sync", () => {
  let db: PrismaClient;

  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "Shop","SyncJob","WebhookReceipt","Product","Variant","Collection","Customer","Order","OrderLine","Event","IdentityLink","ChatSession","ComplianceLog" CASCADE`,
    );
    await db.shop.create({ data: { domain: shop } });
  });
  afterAll(async () => db?.$disconnect());

  it("bulk import: products with variants + metafields, lines in any order", async () => {
    const lines: BulkLine[] = [
      { ...METAFIELDS[0], __parentId: PRODUCT.id }, // child before parent on purpose
      PRODUCT,
      { ...VARIANT, __parentId: PRODUCT.id },
      ...METAFIELDS.slice(1).map((m) => ({ ...m, __parentId: PRODUCT.id })),
    ];
    const n = await importLines(db, shop, "products", lines);
    expect(n).toBe(1);

    const p = await db.product.findUniqueOrThrow({ where: { id: PRODUCT.id }, include: { variants: true } });
    expect(p.abv?.toString()).toBe("40");
    expect(p.noAgeStatement).toBe(true);
    expect(p.style).toBe("Blended Malt");
    expect(p.flavours).toEqual(["Smokey & Peaty"]);
    expect(p.caskTypes).toEqual(["Bourbon"]);
    expect(p.peated).toBe(true);
    expect(p.volumeMl).toBe(700);
    expect(p.tastingNotes).toBe("Nose - Oak smoke, mellow vanilla.");
    expect(p.fbtProductIds).toEqual(["gid://shopify/Product/6991488745507"]);
    expect(p.tasteVector[0]).toBeGreaterThanOrEqual(3); // smoke
    expect(p.description).toContain("smoky edge");
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0].price.toString()).toBe("23.38");
  });

  it("bulk import reconciles: products no longer in Shopify are marked deleted", async () => {
    await importLines(db, shop, "products", [PRODUCT, { ...VARIANT, __parentId: PRODUCT.id }]);
    const other = { ...PRODUCT, id: "gid://shopify/Product/999", handle: "other" };
    await importLines(db, shop, "products", [other]);
    const old = await db.product.findUniqueOrThrow({ where: { id: PRODUCT.id } });
    expect(old.deletedAt).not.toBeNull();
    expect(old.status).toBe("DELETED");
  });

  it("orders arriving before their customer and product still import, links kept where possible", async () => {
    const order = {
      id: "gid://shopify/Order/5001",
      name: "#5001",
      email: "Someone@Example.com",
      currencyCode: "GBP",
      displayFinancialStatus: "PAID",
      displayFulfillmentStatus: "UNFULFILLED",
      totalPriceSet: { shopMoney: { amount: "54.00" } },
      customer: { id: "gid://shopify/Customer/77" },
      shippingAddress: { countryCodeV2: "GB", provinceCode: "SCT" },
      customAttributes: [{ key: "_se_chat_session", value: "chat_123" }],
      processedAt: "2026-10-01T10:00:00Z",
    };
    const line = {
      id: "gid://shopify/LineItem/1",
      title: "Gone bottle",
      quantity: 1,
      originalUnitPriceSet: { shopMoney: { amount: "54.00" } },
      product: { id: "gid://shopify/Product/404" }, // not in our DB
      variant: { id: "gid://shopify/ProductVariant/404" },
      customAttributes: [{ key: "_rec", value: "chip:rarest|RARE_LOW_STOCK" }],
      __parentId: order.id,
    };
    await importLines(db, shop, "orders", [order, line]);

    const saved = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { lines: true, customer: true } });
    expect(saved.email).toBe("someone@example.com");
    expect(saved.customer?.id).toBe("gid://shopify/Customer/77"); // stub customer created
    expect(saved.chatSessionId).toBe("chat_123");
    expect(saved.attribution).toBe("direct");
    expect(saved.lines[0].productId).toBeNull();
    expect(saved.lines[0].variantId).toBe("gid://shopify/ProductVariant/404");
    expect(saved.lines[0].recReason).toBe("chip:rarest|RARE_LOW_STOCK");

    // The customer sync later fills the stub in
    await importLines(db, shop, "customers", [
      {
        id: "gid://shopify/Customer/77",
        firstName: "A",
        lastName: "B",
        tags: [],
        numberOfOrders: "3",
        amountSpent: { amount: "210.50" },
        defaultEmailAddress: { emailAddress: "Someone@Example.com", marketingState: "SUBSCRIBED" },
        defaultAddress: { countryCodeV2: "GB" },
      },
    ]);
    const c = await db.customer.findUniqueOrThrow({ where: { id: "gid://shopify/Customer/77" } });
    expect(c.email).toBe("someone@example.com");
    expect(c.numberOfOrders).toBe(3);
  });

  it("product webhook refetches through GraphQL and saves metafields", async () => {
    const admin = fakeAdmin({
      GetProduct: () => ({ product: { ...PRODUCT, variants: { nodes: [VARIANT] }, metafields: { nodes: METAFIELDS } } }),
    });
    const result = await handleSyncWebhook({
      db,
      admin,
      shop,
      topic: "products/update",
      payload: { id: 4479104647203, admin_graphql_api_id: PRODUCT.id },
    });
    expect(result).toContain("saved");
    expect(admin.calls).toEqual(["GetProduct"]);
    expect((await db.product.findUniqueOrThrow({ where: { id: PRODUCT.id } })).abv?.toString()).toBe("40");
  });

  it("stock webhook updates the variant; delete webhook marks the product", async () => {
    await importLines(db, shop, "products", [PRODUCT, { ...VARIANT, __parentId: PRODUCT.id }]);
    const admin = fakeAdmin({
      GetInventoryItem: () => ({
        inventoryItem: { id: VARIANT.inventoryItem.id, variant: { id: VARIANT.id, inventoryQuantity: 0, availableForSale: false } },
      }),
    });
    await handleSyncWebhook({ db, admin, shop, topic: "INVENTORY_LEVELS_UPDATE", payload: { inventory_item_id: 33530290929699 } });
    const v = await db.variant.findUniqueOrThrow({ where: { id: VARIANT.id } });
    expect(v.inventoryQuantity).toBe(0);
    expect(v.availableForSale).toBe(false);

    await handleSyncWebhook({ db, admin, shop, topic: "products/delete", payload: { id: 4479104647203 } });
    expect((await db.product.findUniqueOrThrow({ where: { id: PRODUCT.id } })).deletedAt).not.toBeNull();
  });

  it("duplicate webhook deliveries are processed once", async () => {
    expect(await claimWebhook(db, "wh-1", shop, "products/update")).toBe(true);
    expect(await claimWebhook(db, "wh-1", shop, "products/update")).toBe(false);
  });

  it("full backfill chains products → customers → orders and finishes", async () => {
    let n = 0;
    const admin = fakeAdmin({
      RunBulk: () => ({ bulkOperationRunQuery: { bulkOperation: { id: `gid://shopify/BulkOperation/${++n}`, status: "CREATED" }, userErrors: [] } }),
      GetBulk: () => ({ node: { status: "COMPLETED", errorCode: null, objectCount: "0", url: null, partialDataUrl: null } }),
    });
    await startFullBackfill(db, admin, shop);
    for (let i = 1; i <= 3; i++) await processBulkFinish(db, admin, shop, `gid://shopify/BulkOperation/${i}`);

    const jobs = await db.syncJob.findMany({ where: { shop }, orderBy: { startedAt: "asc" } });
    expect(jobs.map((j) => [j.resource, j.status])).toEqual([
      ["products", "COMPLETED"],
      ["customers", "COMPLETED"],
      ["orders", "COMPLETED"],
    ]);
    expect((await db.shop.findUniqueOrThrow({ where: { domain: shop } })).lastFullSyncAt).not.toBeNull();
  });

  it("GDPR redaction erases personal data and behaviour but keeps order totals", async () => {
    const cid = "gid://shopify/Customer/88";
    await db.customer.create({ data: { id: cid, shop, email: "x@y.com", firstName: "X", tags: ["vip"], tasteVector: [1, 2] } });
    await db.order.create({ data: { id: "gid://shopify/Order/9", shop, name: "#9", customerId: cid, email: "x@y.com", totalPrice: "99.00" } });
    await db.identityLink.create({ data: { shop, clientId: "browser-1", customerId: cid, source: "checkout" } });
    await db.event.create({ data: { id: "ev1", shop, clientId: "browser-1", name: "product_viewed", occurredAt: new Date() } });

    await redactCustomer(db, shop, cid, ["gid://shopify/Order/9"]);

    const c = await db.customer.findUniqueOrThrow({ where: { id: cid } });
    expect(c.email).toBeNull();
    expect(c.firstName).toBeNull();
    expect(c.redactedAt).not.toBeNull();
    expect(await db.event.count({ where: { shop } })).toBe(0);
    expect(await db.identityLink.count({ where: { shop } })).toBe(0);
    const o = await db.order.findUniqueOrThrow({ where: { id: "gid://shopify/Order/9" } });
    expect(o.email).toBeNull();
    expect(o.totalPrice.toString()).toBe("99");
  });
});
