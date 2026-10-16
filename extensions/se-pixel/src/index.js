import { register } from "@shopify/web-pixels-extension";

// Sends a small, privacy-safe summary of each storefront event to the app.
// No names, emails, phone numbers or addresses are sent: only product/variant ids, the search
// term, the page URL, Shopify's anonymous clientId, and (when logged in) the customer id.

const EVENTS = [
  "page_viewed",
  "product_viewed",
  "collection_viewed",
  "search_submitted",
  "product_added_to_cart",
  "product_removed_from_cart",
  "cart_viewed",
  "checkout_started",
  "checkout_completed",
];

register(({ analytics, settings, init }) => {
  const endpoint = settings.endpoint;
  const shop = settings.shop;
  if (!endpoint || !shop) return;

  const loggedInCustomerId = init?.data?.customer?.id ?? null;

  const send = (payload) => {
    // text/plain keeps this a "simple" request (no CORS preflight); keepalive survives navigation.
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  };

  const summarise = (event) => {
    const d = event.data || {};
    const base = {
      shop,
      id: event.id,
      name: event.name,
      clientId: event.clientId,
      ts: event.timestamp,
      url: event.context?.document?.location?.href ?? null,
      customerId: loggedInCustomerId,
    };

    switch (event.name) {
      case "product_viewed":
        return {
          ...base,
          productId: d.productVariant?.product?.id ?? null,
          variantId: d.productVariant?.id ?? null,
          price: d.productVariant?.price?.amount ?? null,
        };
      case "product_added_to_cart":
      case "product_removed_from_cart":
        return {
          ...base,
          productId: d.cartLine?.merchandise?.product?.id ?? null,
          variantId: d.cartLine?.merchandise?.id ?? null,
          quantity: d.cartLine?.quantity ?? null,
        };
      case "collection_viewed":
        return { ...base, collectionId: d.collection?.id ?? null };
      case "search_submitted":
        return { ...base, query: d.searchResult?.query ?? null };
      case "checkout_started":
      case "checkout_completed":
        return {
          ...base,
          orderId: d.checkout?.order?.id ?? null,
          orderCustomerId: d.checkout?.order?.customer?.id ?? null,
          productIds: (d.checkout?.lineItems ?? [])
            .map((l) => l.variant?.product?.id)
            .filter(Boolean),
          total: d.checkout?.totalPrice?.amount ?? null,
          currency: d.checkout?.currencyCode ?? null,
        };
      default:
        return base;
    }
  };

  for (const name of EVENTS) {
    analytics.subscribe(name, (event) => send(summarise(event)));
  }

  // Chat panel interactions, published by the theme embed as Shopify custom events.
  analytics.subscribe("se_chat", (event) => {
    const d = event.customData || {};
    send({
      shop,
      id: event.id,
      name: "chat_" + String(d.action || "unknown"),
      clientId: event.clientId,
      ts: event.timestamp,
      url: event.context?.document?.location?.href ?? null,
      customerId: loggedInCustomerId,
      key: d.key ?? null,
      view: d.view ?? null,
      source: d.source ?? null,
    });
  });
});
