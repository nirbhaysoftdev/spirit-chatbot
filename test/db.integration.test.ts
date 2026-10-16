// Round-trip every model through Prisma against a real Postgres.
// Proves the hand-written migration matches prisma/schema.prisma.
// Runs only when TEST_DATABASE_URL is set (see README → Tests).
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.TEST_DATABASE_URL;
const shop = "test-shop.myshopify.com";

describe.skipIf(!url)("database schema round-trip", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url! }) });
    await db.$executeRawUnsafe(
      `TRUNCATE "Session","Shop","SyncJob","WebhookReceipt","Product","Variant","Collection","Customer","Order","OrderLine","Event","IdentityLink","ChatSession","Rule","MenuItem","Jurisdiction","ComplianceLog" CASCADE`,
    );
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  it("writes and reads every table", async () => {
    await db.session.create({
      data: { id: "s1", shop, state: "x", accessToken: "t", userId: BigInt(1) },
    });
    await db.shop.create({ data: { domain: shop, name: "Test" } });
    await db.syncJob.create({
      data: { shop, resource: "products", status: "RUNNING", bulkOperationId: "gid://shopify/BulkOperation/1" },
    });
    await db.webhookReceipt.create({ data: { webhookId: "w1", shop, topic: "products/update" } });

    await db.product.create({
      data: {
        id: "gid://shopify/Product/1",
        shop,
        handle: "octomore-17-2",
        title: "Octomore 17.2",
        tags: ["Islay", "Single Malt"],
        abv: new Prisma.Decimal("59.5"),
        caskTypes: ["port"],
        tasteVector: [5, 4, 2, 2, 0, 0, 1, 3, 2, 3, 2, 4],
        enrichment: { source: "rules" },
        variants: {
          create: {
            id: "gid://shopify/ProductVariant/1",
            shop,
            price: new Prisma.Decimal("111.91"),
            inventoryQuantity: 4,
          },
        },
      },
    });
    // pgvector column is Unsupported() in Prisma, so it is written with SQL.
    const vec = `[${Array.from({ length: 1024 }, () => 0.01).join(",")}]`;
    await db.$executeRawUnsafe(
      `UPDATE "Product" SET "embedding" = $1::vector WHERE "id" = $2`,
      vec,
      "gid://shopify/Product/1",
    );

    await db.collection.create({ data: { id: "gid://shopify/Collection/1", shop, handle: "islay", title: "Islay" } });
    await db.customer.create({
      data: { id: "gid://shopify/Customer/1", shop, email: "a@b.com", tags: [], tasteVector: [] },
    });
    await db.order.create({
      data: {
        id: "gid://shopify/Order/1",
        shop,
        name: "#1001",
        customerId: "gid://shopify/Customer/1",
        totalPrice: new Prisma.Decimal("134.29"),
        lines: {
          create: {
            id: "gid://shopify/LineItem/1",
            productId: "gid://shopify/Product/1",
            title: "Octomore 17.2",
            quantity: 1,
            price: new Prisma.Decimal("134.29"),
            recReason: "chip:rarest|RARE_LOW_STOCK",
          },
        },
      },
    });
    await db.event.create({
      data: { id: "e1", shop, clientId: "c1", name: "product_viewed", occurredAt: new Date(), data: { a: 1 } },
    });
    await db.identityLink.create({ data: { shop, clientId: "c1", customerId: "gid://shopify/Customer/1", source: "checkout" } });
    await db.chatSession.create({ data: { shop, clientId: "c1" } });
    await db.rule.create({ data: { shop, name: "Pin MotM", action: "PIN", targetType: "PRODUCT", targetId: "gid://shopify/Product/1", value: 1 } });
    await db.menuItem.create({ data: { shop, kind: "EXPLORE_CHIP", key: "best_deals", label: "Best deals this week", source: "ALGORITHM", countries: [] } });
    await db.jurisdiction.create({ data: { shop, code: "GB", name: "United Kingdom", shippingEnabled: true } });
    await db.complianceLog.create({ data: { shop, rule: "MUP_FLOOR", subject: "x", detail: { floor: 18.2 } } });

    const product = await db.product.findUniqueOrThrow({
      where: { id: "gid://shopify/Product/1" },
      include: { variants: true, orderLines: true },
    });
    expect(product.abv?.toString()).toBe("59.5");
    expect(product.variants[0].price.toString()).toBe("111.91");
    expect(product.orderLines).toHaveLength(1);
    expect(product.tasteVector).toHaveLength(12);

    const [{ dims }] = await db.$queryRawUnsafe<{ dims: number }[]>(
      `SELECT vector_dims("embedding") AS dims FROM "Product" WHERE "id" = $1`,
      "gid://shopify/Product/1",
    );
    expect(Number(dims)).toBe(1024);

    const chat = await db.chatSession.findFirstOrThrow({ where: { shop } });
    expect(chat.messages).toEqual([]);
    const j = await db.jurisdiction.findUniqueOrThrow({ where: { shop_code: { shop, code: "GB" } } });
    expect(j.minimumAge).toBe(18);
  });
});
