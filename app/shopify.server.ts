import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { GET_SHOP } from "./lib/sync/queries";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // Private app for one store (The Spirits Embassy), not listed on the App Store.
  distribution: AppDistribution.SingleMerchant,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    // Runs after install and after every re-auth. Records the shop; the first full sync is
    // started by a person from the app's home page, not automatically.
    afterAuth: async ({ session, admin }) => {
      const res = await admin.graphql(GET_SHOP);
      const { data } = (await res.json()) as {
        data?: { shop: { name: string; currencyCode: string; ianaTimezone: string } };
      };
      const info = {
        name: data?.shop.name ?? null,
        currency: data?.shop.currencyCode ?? null,
        ianaTimezone: data?.shop.ianaTimezone ?? null,
        uninstalledAt: null,
      };
      await prisma.shop.upsert({
        where: { domain: session.shop },
        create: { domain: session.shop, ...info },
        update: info,
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
