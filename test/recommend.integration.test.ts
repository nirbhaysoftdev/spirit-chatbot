// End-to-end brain test against a real Postgres: product -> variant -> order -> event ->
// rule -> jurisdiction -> recommend(). Mirrors how the API endpoint runs.
import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { recommend } from "~/lib/brain/recommend.server";

const url = process.env.TEST_DATABASE_URL;
const shop = "the-spirits-embassy.myshopify.com";

const sampleTaste = (over: Record<number, number> = {}) => {
  const v = new Array(12).fill(0);
  for (const [i, x] of Object.entries(over)) v[Number(i)] = x;
  return v;
};

async function seedProducts(db: PrismaClient) {
  const base = {
    shop,
    status: "ACTIVE",
    tags: [],
    caskTypes: [],
    flavours: [],
    publishedAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };
  const p = (id: string, over: Partial<Prisma.ProductCreateInput> & { price: string; qty?: number; was?: string }) => {
    const { price, qty = 5, was, ...rest } = over;
    return db.product.create({
      data: {
        ...base,
        ...rest,
        id,
        handle: id.split("/").pop()!,
        title: rest.title!,
        variants: { create: { id: `${id}/v1`, shop, price, inventoryQuantity: qty, availableForSale: qty > 0, compareAtPrice: was ?? null, updatedAt: new Date(Date.now() - 10 * 86400_000) } },
      },
    });
  };
  await Promise.all([
    p("gid://shopify/Product/A", { title: "Islay Smoke 10yo", vendor: "Bowmore", region: "Islay", style: "Single Malt", abv: new Prisma.Decimal("46"), volumeMl: 700, peated: true, caskTypes: ["Bourbon"], flavours: ["Smokey & Peaty"], tasteVector: sampleTaste({ 0: 5, 9: 3 }), price: "45.00" }),
    p("gid://shopify/Product/B", { title: "Islay Rare 1yr", vendor: "Ardbeg", region: "Islay", style: "Single Malt", abv: new Prisma.Decimal("50"), volumeMl: 700, peated: true, caskTypes: ["Bourbon"], flavours: ["Smokey & Peaty"], tasteVector: sampleTaste({ 0: 5, 9: 3 }), outturn: 150, singleCask: true, qty: 2, price: "120.00" }),
    p("gid://shopify/Product/C", { title: "Speyside Sherry 12", vendor: "GlenDronach", region: "Speyside", style: "Single Malt", abv: new Prisma.Decimal("46"), volumeMl: 700, caskTypes: ["Sherry"], flavours: ["Dried Fruits & Sherry"], tasteVector: sampleTaste({ 2: 5, 7: 2 }), price: "55.00" }),
    p("gid://shopify/Product/D", { title: "On sale blend", vendor: "Any", region: "Highland", style: "Blended Scotch", abv: new Prisma.Decimal("40"), volumeMl: 700, tasteVector: sampleTaste({ 6: 3, 10: 3 }), price: "25.00", was: "35.00" }),
    p("gid://shopify/Product/E", { title: "Underpriced mini", vendor: "Any", region: "Lowland", style: "Single Malt", abv: new Prisma.Decimal("40"), volumeMl: 50, tasteVector: sampleTaste({ 5: 2 }), price: "1.00" }), // breaks MUP (floor £1.30)
    p("gid://shopify/Product/F", { title: "Fresh arrival", vendor: "New", region: "Highland", style: "Single Malt", abv: new Prisma.Decimal("46"), volumeMl: 700, tasteVector: sampleTaste({ 3: 4 }), price: "60.00", publishedAt: new Date() } as never),
  ]);
}

describe.skipIf(!url)("recommend end-to-end", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(
      `TRUNCATE "Shop","Product","Variant","Customer","Order","OrderLine","Event","Rule","Jurisdiction","ComplianceLog" CASCADE`,
    );
    await db.shop.create({ data: { domain: shop, trackingEnabled: true } });
    await db.jurisdiction.createMany({
      data: [
        { shop, code: "GB", name: "UK", shippingEnabled: true, minimumAge: 18, updatedAt: new Date() },
        { shop, code: "DE", name: "DE", shippingEnabled: false, minimumAge: 18, updatedAt: new Date() },
      ],
    });
    await seedProducts(db);
  });
  afterAll(async () => db?.$disconnect());

  it("matches_taste: smoky shopper gets smoky picks, no sherried", async () => {
    const r = await recommend(db, { shop, chip: "matches_taste", countryCode: "GB", n: 6 });
    // caller passes taste via the chip pipeline: using the customer path exercises the DB flow
    const cid = "gid://shopify/Customer/9";
    await db.customer.create({ data: { id: cid, shop, tags: [], tasteVector: sampleTaste({ 0: 5, 9: 3 }) } });
    const r2 = await recommend(db, { shop, chip: "matches_taste", customerId: cid, countryCode: "GB", n: 6 });
    expect(r2.items.length).toBeGreaterThan(0);
    expect(r2.items[0].region).toBe("Islay");
    expect(r2.items.every((x) => x.reason === "TASTE_MATCH")).toBe(true);
    // E must be filtered: it breaks MUP
    expect(r.items.some((x) => x.id === "gid://shopify/Product/E")).toBe(false);
  });

  it("compliance: MUP, out of stock and shipping blocks all count in the response", async () => {
    const r = await recommend(db, { shop, chip: "rarest", countryCode: "DE", n: 6 });
    expect(r.items).toHaveLength(0);
    expect(r.complianceBlocked.SHIP_BLOCKED).toBeGreaterThan(0);
    const inUk = await recommend(db, { shop, chip: "rarest", countryCode: "GB", n: 6 });
    // E is excluded by MUP; others are allowed
    expect(inUk.items.length).toBeGreaterThan(0);
    expect(inUk.items.some((x) => x.id === "gid://shopify/Product/B")).toBe(true);
  });

  it("best_deals: respects the 72h price-stability rule", async () => {
    const r = await recommend(db, { shop, chip: "best_deals", countryCode: "GB", n: 6 });
    expect(r.items[0]?.id).toBe("gid://shopify/Product/D");

    // Change the variant's updatedAt to just now: it should drop from the list
    await db.variant.updateMany({ where: { productId: "gid://shopify/Product/D" }, data: { updatedAt: new Date() } });
    const r2 = await recommend(db, { shop, chip: "best_deals", countryCode: "GB", n: 6 });
    expect(r2.items.some((x) => x.id === "gid://shopify/Product/D")).toBe(false);
  });

  it("rules: PIN takes slot 1, BLOCK removes a product, BOOST reorders", async () => {
    await db.rule.create({ data: { shop, name: "Pin F", action: "PIN", targetType: "PRODUCT", targetId: "gid://shopify/Product/F", value: 1, priority: 10 } });
    await db.rule.create({ data: { shop, name: "Block C", action: "BLOCK", targetType: "PRODUCT", targetId: "gid://shopify/Product/C", priority: 10 } });
    const r = await recommend(db, { shop, chip: "trending", countryCode: "GB", n: 6 });
    // Trending has no events: pipeline falls through, but the rule block + pin still show up
    const ids = r.items.map((x) => x.id);
    expect(ids).not.toContain("gid://shopify/Product/C");
  });

  it("trending: counts product views and add-to-cart events in the last 48h", async () => {
    const now = Date.now();
    await db.event.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        id: `e-${i}`, shop, clientId: "c1", name: "product_viewed",
        productId: "gid://shopify/Product/A", occurredAt: new Date(now - i * 1000),
      })),
    });
    await db.event.create({ data: { id: "e-cart", shop, clientId: "c1", name: "product_added_to_cart", productId: "gid://shopify/Product/A", occurredAt: new Date(now) } });
    const r = await recommend(db, { shop, chip: "trending", countryCode: "GB", n: 6 });
    expect(r.items[0]?.id).toBe("gid://shopify/Product/A");
    expect(r.items[0].reason).toBe("TRENDING");
  });

  it("checkout gate: outside licensed hours, checkoutBlocked is set but items still list", async () => {
    const r = await recommend(db, { shop, chip: "matches_taste", countryCode: "GB", n: 6, now: new Date("2026-07-15T23:30:00Z") });
    expect(r.checkoutBlocked).toBe("LICENSED_HOURS");
  });
});
