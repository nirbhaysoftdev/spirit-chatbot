// Database writes for the sync. Every function is idempotent: running it twice with the same
// input leaves the same rows, because Shopify may deliver a webhook more than once.
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  mapCustomer,
  mapLine,
  mapOrder,
  mapProduct,
  mapVariant,
  type CustomerNode,
  type LineItemNode,
  type MetafieldNode,
  type OrderNode,
  type ProductNode,
  type VariantNode,
} from "./mappers";

type Db = PrismaClient | Prisma.TransactionClient;

/** Returns false if this webhook id was already processed. */
export async function claimWebhook(db: Db, webhookId: string, shop: string, topic: string): Promise<boolean> {
  try {
    await db.webhookReceipt.create({ data: { webhookId, shop, topic } });
    return true;
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
}

/** If processing fails, release the claim so Shopify's retry is processed. */
export async function releaseWebhook(db: Db, webhookId: string) {
  await db.webhookReceipt.deleteMany({ where: { webhookId } });
}

// ── Products ──

export async function saveProduct(
  db: PrismaClient,
  shop: string,
  node: ProductNode,
  variants: VariantNode[],
  metafields: MetafieldNode[],
) {
  const row = mapProduct(shop, node, metafields);
  const { id, ...update } = row;
  await db.$transaction(async (tx) => {
    // embedding / enrichment / enrichedAt are owned by the AI step and are never overwritten here
    await tx.product.upsert({ where: { id }, create: row, update });
    const keep: string[] = [];
    for (const v of variants) {
      const vr = mapVariant(shop, id, v);
      keep.push(vr.id);
      const { id: vid, ...vupdate } = vr;
      await tx.variant.upsert({ where: { id: vid }, create: vr, update: vupdate });
    }
    await tx.variant.deleteMany({ where: { productId: id, id: { notIn: keep } } });
  });
  return row;
}

export async function markProductDeleted(db: Db, id: string) {
  await db.product.updateMany({ where: { id }, data: { deletedAt: new Date(), status: "DELETED" } });
}

export async function updateVariantStock(
  db: Db,
  variant: { id: string; inventoryQuantity?: number | null; availableForSale?: boolean | null },
) {
  await db.variant.updateMany({
    where: { id: variant.id },
    data: {
      inventoryQuantity: variant.inventoryQuantity ?? null,
      ...(variant.availableForSale == null ? {} : { availableForSale: variant.availableForSale }),
    },
  });
}

export async function saveCollection(db: Db, shop: string, c: { id: string; handle: string; title: string; updatedAt?: string | null }) {
  const data = { shop, handle: c.handle, title: c.title, updatedAt: c.updatedAt ? new Date(c.updatedAt) : null, deletedAt: null };
  await db.collection.upsert({ where: { id: c.id }, create: { id: c.id, ...data }, update: data });
}

export async function markCollectionDeleted(db: Db, id: string) {
  await db.collection.updateMany({ where: { id }, data: { deletedAt: new Date() } });
}

// ── Customers ──

export async function saveCustomer(db: Db, shop: string, node: CustomerNode) {
  const row = mapCustomer(shop, node);
  // tasteVector / price band are computed by the brain, so sync only sets them on first create
  const { id, ...update } = row;
  await db.customer.upsert({ where: { id }, create: { ...row, tasteVector: [] }, update });
  return row;
}

/** Customer deleted in Shopify: remove our copy and everything tied to it. */
export async function deleteCustomer(db: PrismaClient, shop: string, customerId: string) {
  await db.$transaction([
    db.identityLink.deleteMany({ where: { shop, customerId } }),
    db.event.updateMany({ where: { shop, customerId }, data: { customerId: null } }),
    db.chatSession.updateMany({ where: { shop, customerId }, data: { customerId: null } }),
    db.customer.deleteMany({ where: { id: customerId, shop } }), // orders keep their row; FK sets customerId null
  ]);
}

// ── Orders ──

export async function saveOrder(db: PrismaClient, shop: string, node: OrderNode, lines: LineItemNode[]) {
  const order = mapOrder(shop, node);
  const mapped = lines.map((l) => mapLine(order.id, l));

  await db.$transaction(async (tx) => {
    // The customer may not be synced yet (webhooks arrive in any order): create a stub the
    // customer sync fills in later, so the order keeps its link.
    if (order.customerId) {
      await tx.customer.upsert({
        where: { id: order.customerId },
        create: { id: order.customerId, shop, tags: [], tasteVector: [] },
        update: {},
      });
    }
    // A product can be missing locally (e.g. deleted in Shopify long ago): keep the line, drop the link.
    const productIds = [...new Set(mapped.map((l) => l.productId).filter((x): x is string => !!x))];
    const known = new Set(
      (await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true } })).map((p) => p.id),
    );
    const safeLines = mapped.map((l) => (l.productId && !known.has(l.productId) ? { ...l, productId: null } : l));

    const { id, ...update } = order;
    await tx.order.upsert({ where: { id }, create: order, update });
    await tx.orderLine.deleteMany({ where: { orderId: id } });
    if (safeLines.length) await tx.orderLine.createMany({ data: safeLines });
  });
  return order;
}

// ── Privacy (UK GDPR / EU GDPR) ──

/** customers/redact: erase personal data for one customer. Order totals stay for accounting. */
export async function redactCustomer(db: PrismaClient, shop: string, customerId: string, orderIds: string[]) {
  const links = await db.identityLink.findMany({ where: { shop, customerId }, select: { clientId: true } });
  const clientIds = links.map((l) => l.clientId);
  await db.$transaction([
    db.event.deleteMany({ where: { shop, OR: [{ customerId }, { clientId: { in: clientIds } }] } }),
    db.chatSession.deleteMany({ where: { shop, OR: [{ customerId }, { clientId: { in: clientIds } }] } }),
    db.identityLink.deleteMany({ where: { shop, customerId } }),
    db.order.updateMany({
      where: { shop, OR: [{ customerId }, { id: { in: orderIds } }] },
      data: { email: null, shipProvinceCode: null },
    }),
    db.customer.updateMany({
      where: { id: customerId, shop },
      data: {
        email: null,
        firstName: null,
        lastName: null,
        tags: [],
        marketingConsent: null,
        tasteVector: [],
        priceBandLow: null,
        priceBandHigh: null,
        redactedAt: new Date(),
      },
    }),
  ]);
}

/** shop/redact: the store uninstalled the app 48h+ ago; delete everything we hold for it. */
export async function redactShop(db: PrismaClient, shop: string) {
  await db.$transaction([
    db.event.deleteMany({ where: { shop } }),
    db.identityLink.deleteMany({ where: { shop } }),
    db.chatSession.deleteMany({ where: { shop } }),
    db.orderLine.deleteMany({ where: { order: { shop } } }),
    db.order.deleteMany({ where: { shop } }),
    db.customer.deleteMany({ where: { shop } }),
    db.variant.deleteMany({ where: { shop } }),
    db.product.deleteMany({ where: { shop } }),
    db.collection.deleteMany({ where: { shop } }),
    db.rule.deleteMany({ where: { shop } }),
    db.menuItem.deleteMany({ where: { shop } }),
    db.jurisdiction.deleteMany({ where: { shop } }),
    db.complianceLog.deleteMany({ where: { shop } }),
    db.syncJob.deleteMany({ where: { shop } }),
    db.webhookReceipt.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { domain: shop } }),
  ]);
}

/** customers/data_request: record it so the team can send the customer their data within 30 days. */
export async function logDataRequest(db: Db, shop: string, payload: unknown) {
  await db.complianceLog.create({
    data: { shop, rule: "DATA_REQUEST", subject: "customer", detail: payload as Prisma.InputJsonValue },
  });
}
