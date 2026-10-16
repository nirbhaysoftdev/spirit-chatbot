import { describe, expect, it, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { ingest, linkCheckoutEvents, toGid, validate } from "~/lib/events/ingest.server";

const url = process.env.TEST_DATABASE_URL;
const shop = "the-spirits-embassy.myshopify.com";

const ev = (over: Record<string, unknown> = {}) => ({
  shop,
  id: `e-${Math.random().toString(36).slice(2)}`,
  name: "product_viewed",
  clientId: "browser-A",
  ts: "2026-10-16T12:00:00.000Z",
  url: "https://thespiritsembassy.com/products/octomore-17-2",
  productId: "16002686058877",
  variantId: "58582441722237",
  ...over,
});

describe("validation (no database)", () => {
  it("converts numeric ids to gids and rejects junk", () => {
    expect(toGid("Product", "123")).toBe("gid://shopify/Product/123");
    expect(toGid("Product", "gid://shopify/Product/9")).toBe("gid://shopify/Product/9");
    expect(toGid("Product", "drop table")).toBeNull();
    expect(validate(ev())).not.toBeNull();
    expect(validate(ev({ shop: "evil.com" }))).toBeNull();
    expect(validate(ev({ name: "something_else" }))).toBeNull();
    expect(validate(ev({ ts: "not a date" }))).toBeNull();
  });
});

describe.skipIf(!url)("event ingest + identity stitching", () => {
  let db: PrismaClient;
  beforeAll(() => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe(`TRUNCATE "Shop","Event","IdentityLink","Order","OrderLine","Customer" CASCADE`);
    await db.shop.create({ data: { domain: shop, trackingEnabled: true } });
  });
  afterAll(async () => db?.$disconnect());

  it("ignores events while tracking is off", async () => {
    await db.shop.update({ where: { domain: shop }, data: { trackingEnabled: false } });
    expect((await ingest(db, ev())).status).toBe(404);
    expect(await db.event.count()).toBe(0);
  });

  it("stores events with gids, lower-cased search terms, and dedupes retries", async () => {
    const e = ev();
    expect((await ingest(db, e)).status).toBe(200);
    expect((await ingest(db, e)).status).toBe(204); // same id again
    await ingest(db, ev({ name: "search_submitted", query: "  Sherry CASK ", productId: null, variantId: null }));
    const rows = await db.event.findMany({ orderBy: { name: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].productId).toBe("gid://shopify/Product/16002686058877");
    expect(rows[1].query).toBe("sherry cask");
  });

  it("accepts chat interaction events with their key", async () => {
    await ingest(db, ev({ name: "chat_chip_clicked", key: "rarest", view: "explore", productId: null }));
    const row = await db.event.findFirstOrThrow();
    expect(row.name).toBe("chat_chip_clicked");
    expect(row.data).toMatchObject({ key: "rarest", view: "explore" });
  });

  it("logging in links the browser and claims its earlier anonymous events", async () => {
    await ingest(db, ev()); // anonymous
    await ingest(db, ev({ name: "page_viewed", customerId: "4242" })); // now logged in
    const events = await db.event.findMany();
    expect(events.every((e) => e.customerId === "gid://shopify/Customer/4242")).toBe(true);
    const link = await db.identityLink.findFirstOrThrow();
    expect(link).toMatchObject({ clientId: "browser-A", customerId: "gid://shopify/Customer/4242", source: "login" });
  });

  it("guest checkout: links via the order when the order webhook came first", async () => {
    await db.customer.create({ data: { id: "gid://shopify/Customer/7", shop, tags: [], tasteVector: [] } });
    await db.order.create({ data: { id: "gid://shopify/Order/555", shop, name: "#555", customerId: "gid://shopify/Customer/7", totalPrice: "10" } });
    await ingest(db, ev()); // browsed anonymously
    await ingest(db, ev({ name: "checkout_completed", orderId: "555", productId: null }));
    expect(await db.event.count({ where: { customerId: "gid://shopify/Customer/7" } })).toBe(2);
  });

  it("guest checkout: links later when the pixel event came first", async () => {
    await ingest(db, ev({ name: "checkout_completed", orderId: "556", productId: null }));
    await db.customer.create({ data: { id: "gid://shopify/Customer/8", shop, tags: [], tasteVector: [] } });
    const n = await linkCheckoutEvents(db, shop, "gid://shopify/Order/556", "gid://shopify/Customer/8");
    expect(n).toBe(1);
    expect(await db.identityLink.count({ where: { customerId: "gid://shopify/Customer/8" } })).toBe(1);
  });
});
