import { useEffect } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { startFullBackfill } from "../lib/sync/bulk.server";
import { disableTracking, enableTracking } from "../lib/pixel.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [info, jobs, products, activeProducts, enriched, customers, orders, events24h, linked] = await Promise.all([
    db.shop.findUnique({ where: { domain: shop } }),
    db.syncJob.findMany({ where: { shop }, orderBy: { startedAt: "desc" }, take: 6 }),
    db.product.count({ where: { shop, deletedAt: null } }),
    db.product.count({ where: { shop, deletedAt: null, status: "ACTIVE" } }),
    db.product.count({ where: { shop, deletedAt: null, NOT: { tasteVector: { isEmpty: true } } } }),
    db.customer.count({ where: { shop, redactedAt: null } }),
    db.order.count({ where: { shop } }),
    db.event.count({ where: { shop, occurredAt: { gte: since } } }),
    db.identityLink.count({ where: { shop } }),
  ]);

  return {
    shop,
    name: info?.name ?? shop,
    trackingEnabled: info?.trackingEnabled ?? false,
    lastFullSyncAt: info?.lastFullSyncAt?.toISOString() ?? null,
    jobs: jobs.map((j) => ({
      id: j.id,
      resource: j.resource,
      status: j.status,
      objectCount: j.objectCount,
      error: j.error,
      startedAt: j.startedAt.toISOString(),
    })),
    counts: { products, activeProducts, enriched, customers, orders, events24h, linked },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "sync") {
      await startFullBackfill(db, admin, session.shop);
      return { ok: true, message: "Full sync started. It runs in the background; refresh to see progress." };
    }
    if (intent === "tracking-on") {
      await enableTracking(db, admin, session.shop, process.env.SHOPIFY_APP_URL || "");
      return { ok: true, message: "Storefront tracking is on." };
    }
    if (intent === "tracking-off") {
      await disableTracking(db, admin, session.shop);
      return { ok: true, message: "Storefront tracking is off." };
    }
    return { ok: false, message: "Unknown action" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
};

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB") : "never");
const tone = (status: string) => (status === "COMPLETED" ? "success" : status === "FAILED" ? "critical" : "info");

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.message) shopify.toast.show(fetcher.data.message, { isError: !fetcher.data.ok });
  }, [fetcher.data, shopify]);

  const submit = (intent: string) => fetcher.submit({ intent }, { method: "POST" });
  const running = data.jobs.some((j) => j.status === "RUNNING");
  const c = data.counts;

  return (
    <s-page heading="Spirits Embassy Assistant">
      <s-button slot="primary-action" onClick={() => submit("sync")} disabled={busy || running} loading={busy && fetcher.formData?.get("intent") === "sync"}>
        {running ? "Sync running…" : "Run full sync"}
      </s-button>

      <s-section heading="Data synced from your store">
        <s-paragraph>
          The app keeps a read-only copy of {data.name}&apos;s catalogue, customers and orders. Changes in
          Shopify arrive automatically by webhook. Last full sync: <s-text type="strong">{fmt(data.lastFullSyncAt)}</s-text>.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Products: {c.products} ({c.activeProducts} active, {c.enriched} with a taste profile)</s-list-item>
          <s-list-item>Customers: {c.customers}</s-list-item>
          <s-list-item>Orders: {c.orders}</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Recent sync jobs">
        {data.jobs.length === 0 ? (
          <s-paragraph>No sync has run yet. Press “Run full sync” to copy the store’s data.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {data.jobs.map((j) => (
              <s-stack key={j.id} direction="inline" gap="small-200" alignItems="center">
                <s-badge tone={tone(j.status)}>{j.status}</s-badge>
                <s-text>
                  {j.resource}: {j.objectCount} records · started {fmt(j.startedAt)}
                  {j.error ? ` · ${j.error}` : ""}
                </s-text>
              </s-stack>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Storefront tracking">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-badge tone={data.trackingEnabled ? "success" : "neutral"}>{data.trackingEnabled ? "On" : "Off"}</s-badge>
          <s-text>
            {c.events24h} events in the last 24 hours · {c.linked} browsers linked to customers
          </s-text>
        </s-stack>
        <s-paragraph>
          When on, the app records product views, searches, cart changes, checkouts and chat clicks for
          visitors who accept analytics cookies. No names, emails or addresses are recorded. This runs on
          the whole storefront (it is not tied to a theme), so switch it on only when you are ready.
        </s-paragraph>
        {data.trackingEnabled ? (
          <s-button tone="critical" variant="secondary" onClick={() => submit("tracking-off")} disabled={busy}>
            Switch tracking off
          </s-button>
        ) : (
          <s-button variant="secondary" onClick={() => submit("tracking-on")} disabled={busy}>
            Switch tracking on
          </s-button>
        )}
      </s-section>

      <s-section slot="aside" heading="Testing the chat privately">
        <s-ordered-list>
          <s-list-item>Online Store › Themes › duplicate the live theme (do not publish the copy).</s-list-item>
          <s-list-item>Customize the copy › App embeds › switch on “Whisky assistant”.</s-list-item>
          <s-list-item>Use the copy’s Preview link. Shoppers on the live theme never see it.</s-list-item>
        </s-ordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
