// Full backfill with Shopify bulk operations.
// Runs products → customers → orders in sequence (each waits for the previous one's
// bulk_operations/finish webhook) so orders can link to customers and products that exist.
import type { PrismaClient } from "@prisma/client";
import { BULK_QUERIES, GET_BULK, RUN_BULK, type BulkResource } from "./queries";
import {
  gidType,
  groupBulk,
  parseJsonl,
  type BulkLine,
  type CustomerNode,
  type LineItemNode,
  type MetafieldNode,
  type OrderNode,
  type ProductNode,
  type VariantNode,
} from "./mappers";
import { markProductDeleted, saveCustomer, saveOrder, saveProduct } from "./store.server";

/** Minimal shape of the Admin GraphQL client from @shopify/shopify-app-react-router. */
export interface AdminGraphql {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
}

export const BACKFILL_ORDER: BulkResource[] = ["products", "customers", "orders"];

async function gql<T>(admin: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

/** Start the bulk export for one resource and record it as a SyncJob. */
export async function startBulk(db: PrismaClient, admin: AdminGraphql, shop: string, resource: BulkResource) {
  const data = await gql<{
    bulkOperationRunQuery: {
      bulkOperation: { id: string; status: string } | null;
      userErrors: { message: string; code?: string }[];
    };
  }>(admin, RUN_BULK, { query: BULK_QUERIES[resource] });

  const { bulkOperation, userErrors } = data.bulkOperationRunQuery;
  if (!bulkOperation) {
    const error = userErrors.map((e) => e.message).join("; ") || "unknown error";
    await db.syncJob.create({ data: { shop, resource, status: "FAILED", error, finishedAt: new Date() } });
    throw new Error(`Could not start ${resource} backfill: ${error}`);
  }
  return db.syncJob.create({
    data: { shop, resource, status: "RUNNING", bulkOperationId: bulkOperation.id },
  });
}

/** Kick off a full backfill (the chain continues from the finish webhook). */
export async function startFullBackfill(db: PrismaClient, admin: AdminGraphql, shop: string) {
  const running = await db.syncJob.findFirst({ where: { shop, status: "RUNNING" } });
  if (running) return running; // one backfill at a time
  return startBulk(db, admin, shop, BACKFILL_ORDER[0]);
}

/**
 * Handle bulk_operations/finish: download the JSONL, write every record, then start the next
 * resource in the chain. Can take minutes, so the webhook route calls it without awaiting.
 */
export async function processBulkFinish(db: PrismaClient, admin: AdminGraphql, shop: string, bulkOperationId: string) {
  const job = await db.syncJob.findUnique({ where: { bulkOperationId } });
  if (!job || job.status !== "RUNNING") return; // not ours, or already processed

  try {
    const { node } = await gql<{
      node: { status: string; errorCode: string | null; objectCount: string; url: string | null; partialDataUrl: string | null } | null;
    }>(admin, GET_BULK, { id: bulkOperationId });

    if (!node || node.status !== "COMPLETED") {
      throw new Error(`Bulk operation ended ${node?.status ?? "missing"} (${node?.errorCode ?? "no code"})`);
    }

    // url is null when the export has zero records
    const lines = node.url ? parseJsonl(await (await fetch(node.url)).text()) : [];
    const count = await importLines(db, shop, job.resource as BulkResource, lines);

    await db.syncJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", objectCount: count, finishedAt: new Date() },
    });

    const next = BACKFILL_ORDER[BACKFILL_ORDER.indexOf(job.resource as BulkResource) + 1];
    if (next) await startBulk(db, admin, shop, next);
    else await db.shop.update({ where: { domain: shop }, data: { lastFullSyncAt: new Date() } });
  } catch (e) {
    await db.syncJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: String(e instanceof Error ? e.message : e), finishedAt: new Date() },
    });
    throw e;
  }
}

/** Write grouped bulk lines into the database. Returns the number of parent records written. */
export async function importLines(db: PrismaClient, shop: string, resource: BulkResource, lines: BulkLine[]) {
  const groups = groupBulk(lines);

  if (resource === "products") {
    const seen = new Set<string>();
    for (const { parent, children } of groups) {
      const variants = children.filter((c) => gidType(c.id) === "ProductVariant") as unknown as VariantNode[];
      const metafields = children.filter((c) => gidType(c.id) === "Metafield") as unknown as MetafieldNode[];
      await saveProduct(db, shop, parent as unknown as ProductNode, variants, metafields);
      seen.add(parent.id as string);
    }
    // Reconcile: anything we hold that Shopify no longer has was deleted while a webhook was missed.
    if (seen.size) {
      const stale = await db.product.findMany({
        where: { shop, deletedAt: null, id: { notIn: [...seen] } },
        select: { id: true },
      });
      for (const p of stale) await markProductDeleted(db, p.id);
    }
    return groups.length;
  }

  if (resource === "customers") {
    for (const { parent } of groups) await saveCustomer(db, shop, parent as unknown as CustomerNode);
    return groups.length;
  }

  for (const { parent, children } of groups) {
    const lineItems = children.filter((c) => gidType(c.id) === "LineItem") as unknown as LineItemNode[];
    await saveOrder(db, shop, parent as unknown as OrderNode, lineItems);
  }
  return groups.length;
}
