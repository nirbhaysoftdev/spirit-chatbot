import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logDataRequest, redactCustomer, redactShop } from "../lib/sync/store.server";
import { normaliseTopic } from "../lib/sync/webhooks.server";

// Mandatory privacy webhooks (UK GDPR / EU GDPR). Shopify sends these when a customer asks for
// their data or asks to be forgotten, and 48 hours after the app is uninstalled.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  switch (normaliseTopic(String(topic))) {
    case "CUSTOMERS_DATA_REQUEST":
      await logDataRequest(db, shop, payload);
      break;

    case "CUSTOMERS_REDACT": {
      const customerId = payload.customer?.id ? `gid://shopify/Customer/${payload.customer.id}` : null;
      const orderIds: string[] = (payload.orders_to_redact ?? []).map((id: number | string) => `gid://shopify/Order/${id}`);
      if (customerId) await redactCustomer(db, shop, customerId, orderIds);
      await db.complianceLog.create({
        data: { shop, rule: "CUSTOMER_REDACTED", subject: customerId ?? "unknown", detail: { orders: orderIds.length } },
      });
      break;
    }

    case "SHOP_REDACT":
      await redactShop(db, shop);
      break;
  }

  return new Response();
};
