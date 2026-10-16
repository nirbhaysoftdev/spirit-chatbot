// What each sync webhook does. Webhook payloads use the REST shape and carry no metafields,
// so for products, customers and orders we refetch the record through GraphQL and reuse the
// same mapper as the bulk backfill: one code path, one data shape.
import type { PrismaClient } from "@prisma/client";
import { GET_CUSTOMER, GET_INVENTORY_ITEM, GET_ORDER, GET_PRODUCT } from "./queries";
import type { AdminGraphql } from "./bulk.server";
import { processBulkFinish } from "./bulk.server";
import { linkCheckoutEvents } from "../events/ingest.server";
import type { CustomerNode, LineItemNode, MetafieldNode, OrderNode, ProductNode, VariantNode } from "./mappers";
import {
  deleteCustomer,
  markCollectionDeleted,
  markProductDeleted,
  saveCollection,
  saveCustomer,
  saveOrder,
  saveProduct,
  updateVariantStock,
} from "./store.server";

type Payload = Record<string, unknown>;

/** "products/update" and "PRODUCTS_UPDATE" → "PRODUCTS_UPDATE" */
export function normaliseTopic(topic: string) {
  return topic.toUpperCase().replace(/\//g, "_");
}

export function gidFor(type: string, payload: Payload, numericKey = "id"): string | null {
  const ready = payload.admin_graphql_api_id;
  if (typeof ready === "string" && ready.startsWith("gid://")) return ready;
  const raw = payload[numericKey];
  return raw == null ? null : `gid://shopify/${type}/${raw}`;
}

async function gql<T>(admin: AdminGraphql, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

export interface SyncWebhook {
  db: PrismaClient;
  admin: AdminGraphql;
  shop: string;
  topic: string;
  payload: Payload;
  /** For long jobs (bulk finish): run without blocking the webhook response. */
  defer?: (job: () => Promise<void>) => void;
}

/** Returns a short description of what was done (logged by the route). */
export async function handleSyncWebhook({ db, admin, shop, topic, payload, defer }: SyncWebhook): Promise<string> {
  switch (normaliseTopic(topic)) {
    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE": {
      const id = gidFor("Product", payload);
      if (!id) return "skipped: no id";
      const { product } = await gql<{
        product: (ProductNode & { variants: { nodes: VariantNode[] }; metafields: { nodes: MetafieldNode[] } }) | null;
      }>(admin, GET_PRODUCT, { id });
      if (!product) {
        await markProductDeleted(db, id);
        return `product ${id} gone`;
      }
      await saveProduct(db, shop, product, product.variants.nodes, product.metafields.nodes);
      return `product ${id} saved`;
    }

    case "PRODUCTS_DELETE": {
      const id = gidFor("Product", payload);
      if (id) await markProductDeleted(db, id);
      return `product ${id} deleted`;
    }

    case "INVENTORY_LEVELS_UPDATE": {
      const itemId = payload.inventory_item_id == null ? null : `gid://shopify/InventoryItem/${payload.inventory_item_id}`;
      if (!itemId) return "skipped: no inventory item";
      const { inventoryItem } = await gql<{
        inventoryItem: { variant: { id: string; inventoryQuantity: number | null; availableForSale: boolean } | null } | null;
      }>(admin, GET_INVENTORY_ITEM, { id: itemId });
      if (inventoryItem?.variant) await updateVariantStock(db, inventoryItem.variant);
      return `stock ${itemId} updated`;
    }

    case "COLLECTIONS_CREATE":
    case "COLLECTIONS_UPDATE": {
      const id = gidFor("Collection", payload);
      if (!id) return "skipped: no id";
      await saveCollection(db, shop, {
        id,
        handle: String(payload.handle ?? ""),
        title: String(payload.title ?? ""),
        updatedAt: (payload.updated_at as string | undefined) ?? null,
      });
      return `collection ${id} saved`;
    }

    case "COLLECTIONS_DELETE": {
      const id = gidFor("Collection", payload);
      if (id) await markCollectionDeleted(db, id);
      return `collection ${id} deleted`;
    }

    case "CUSTOMERS_CREATE":
    case "CUSTOMERS_UPDATE": {
      const id = gidFor("Customer", payload);
      if (!id) return "skipped: no id";
      const { customer } = await gql<{ customer: CustomerNode | null }>(admin, GET_CUSTOMER, { id });
      if (customer) await saveCustomer(db, shop, customer);
      return `customer ${id} saved`;
    }

    case "CUSTOMERS_DELETE": {
      const id = gidFor("Customer", payload);
      if (id) await deleteCustomer(db, shop, id);
      return `customer ${id} deleted`;
    }

    case "ORDERS_CREATE":
    case "ORDERS_UPDATED":
    case "ORDERS_CANCELLED":
    case "REFUNDS_CREATE": {
      const isRefund = normaliseTopic(topic) === "REFUNDS_CREATE";
      const id = isRefund ? gidFor("Order", { id: payload.order_id }) : gidFor("Order", payload);
      if (!id) return "skipped: no id";
      const { order } = await gql<{ order: (OrderNode & { lineItems: { nodes: LineItemNode[] } }) | null }>(
        admin,
        GET_ORDER,
        { id },
      );
      if (order) {
        const saved = await saveOrder(db, shop, order, order.lineItems.nodes);
        await linkCheckoutEvents(db, shop, saved.id, saved.customerId);
      }
      return `order ${id} saved`;
    }

    case "BULK_OPERATIONS_FINISH": {
      const id = gidFor("BulkOperation", payload);
      if (!id) return "skipped: no id";
      const job = () => processBulkFinish(db, admin, shop, id);
      if (defer) defer(job);
      else await job();
      return `bulk ${id} processing`;
    }

    default:
      return `ignored ${topic}`;
  }
}
