// Admin GraphQL used by the sync. One node shape per resource, shared by the bulk backfill
// and the webhook refetch, so both paths go through the same mapper.
import { PRODUCT_METAFIELD_KEYS } from "../catalog/extract";

const MF_KEYS = JSON.stringify([...PRODUCT_METAFIELD_KEYS]);

const PRODUCT_FIELDS = `
  id handle title vendor productType status tags descriptionHtml
  publishedAt createdAt updatedAt
  featuredMedia { preview { image { url } } }`;

const VARIANT_FIELDS = `
  id title sku price compareAtPrice inventoryQuantity availableForSale
  inventoryItem { id }`;

const CUSTOMER_FIELDS = `
  id firstName lastName tags numberOfOrders createdAt updatedAt
  amountSpent { amount }
  defaultEmailAddress { emailAddress marketingState }
  defaultAddress { countryCodeV2 }`;

const ORDER_FIELDS = `
  id name email currencyCode cancelledAt processedAt createdAt updatedAt
  displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount } }
  customer { id }
  shippingAddress { countryCodeV2 provinceCode }
  customAttributes { key value }`;

const LINE_FIELDS = `
  id title quantity
  originalUnitPriceSet { shopMoney { amount } }
  product { id }
  variant { id }
  customAttributes { key value }`;

// ── Bulk backfill (run once on install, then nightly to reconcile) ──

export const BULK_PRODUCTS = `{
  products {
    edges { node {
      ${PRODUCT_FIELDS}
      variants { edges { node { ${VARIANT_FIELDS} } } }
      metafields(keys: ${MF_KEYS}) { edges { node { id namespace key value } } }
    } }
  }
}`;

export const BULK_CUSTOMERS = `{
  customers { edges { node { ${CUSTOMER_FIELDS} } } }
}`;

export const BULK_ORDERS = `{
  orders {
    edges { node {
      ${ORDER_FIELDS}
      lineItems { edges { node { ${LINE_FIELDS} } } }
    } }
  }
}`;

export const BULK_QUERIES = {
  products: BULK_PRODUCTS,
  customers: BULK_CUSTOMERS,
  orders: BULK_ORDERS,
} as const;
export type BulkResource = keyof typeof BULK_QUERIES;

export const RUN_BULK = `#graphql
mutation RunBulk($query: String!) {
  bulkOperationRunQuery(query: $query, groupObjects: false) {
    bulkOperation { id status }
    userErrors { field message code }
  }
}`;

export const GET_BULK = `#graphql
query GetBulk($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
  }
}`;

// ── Single-record refetch after a webhook (webhook payloads have no metafields) ──

export const GET_PRODUCT = `#graphql
query GetProduct($id: ID!) {
  product(id: $id) {
    ${PRODUCT_FIELDS}
    variants(first: 100) { nodes { ${VARIANT_FIELDS} } }
    metafields(first: 30, keys: ${MF_KEYS}) { nodes { id namespace key value } }
  }
}`;

export const GET_CUSTOMER = `#graphql
query GetCustomer($id: ID!) {
  customer(id: $id) { ${CUSTOMER_FIELDS} }
}`;

export const GET_ORDER = `#graphql
query GetOrder($id: ID!) {
  order(id: $id) {
    ${ORDER_FIELDS}
    lineItems(first: 250) { nodes { ${LINE_FIELDS} } }
  }
}`;

export const GET_INVENTORY_ITEM = `#graphql
query GetInventoryItem($id: ID!) {
  inventoryItem(id: $id) {
    id
    variant { id inventoryQuantity availableForSale }
  }
}`;

export const GET_SHOP = `#graphql
query GetShop { shop { name currencyCode ianaTimezone myshopifyDomain } }`;
