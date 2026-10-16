import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { claimWebhook, releaseWebhook } from "../lib/sync/store.server";
import { handleSyncWebhook } from "../lib/sync/webhooks.server";

// Every store change (products, stock, collections, customers, orders, bulk exports) lands here.
// Shopify expects a 200 within 5 seconds and retries otherwise, so long work is deferred and
// every delivery is de-duplicated by its webhook id.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, webhookId, payload, admin } = await authenticate.webhook(request);

  if (!admin) {
    // No session: the app was uninstalled. Nothing to sync.
    return new Response();
  }

  if (!(await claimWebhook(db, webhookId, shop, String(topic)))) {
    return new Response(); // duplicate delivery
  }

  try {
    const result = await handleSyncWebhook({
      db,
      admin,
      shop,
      topic: String(topic),
      payload,
      defer: (job) => {
        job().catch((e) => console.error(`[sync] deferred ${topic} for ${shop} failed`, e));
      },
    });
    console.log(`[sync] ${shop} ${topic}: ${result}`);
    return new Response();
  } catch (e) {
    // Let Shopify retry: un-claim and return an error status.
    await releaseWebhook(db, webhookId);
    console.error(`[sync] ${shop} ${topic} failed`, e);
    return new Response("sync failed", { status: 500 });
  }
};
