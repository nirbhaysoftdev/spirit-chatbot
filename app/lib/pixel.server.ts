// Switch storefront tracking on/off. Tracking is OFF by default; only a person in the app's
// home page can switch it on. Off = the pixel record is deleted, so nothing loads on the storefront.
import type { PrismaClient } from "@prisma/client";
import type { AdminGraphql } from "./sync/bulk.server";

const CREATE = `#graphql
mutation PixelCreate($settings: JSON!) {
  webPixelCreate(webPixel: { settings: $settings }) {
    webPixel { id }
    userErrors { field message code }
  }
}`;

const UPDATE = `#graphql
mutation PixelUpdate($id: ID!, $settings: JSON!) {
  webPixelUpdate(id: $id, webPixel: { settings: $settings }) {
    webPixel { id }
    userErrors { field message code }
  }
}`;

const DELETE = `#graphql
mutation PixelDelete($id: ID!) {
  webPixelDelete(id: $id) {
    deletedWebPixelId
    userErrors { field message code }
  }
}`;

type UserError = { message: string; code?: string };

async function run<T>(admin: AdminGraphql, query: string, variables: Record<string, unknown>) {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: unknown };
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data as T;
}

export function pixelSettings(appUrl: string, shop: string) {
  return JSON.stringify({ endpoint: `${appUrl.replace(/\/$/, "")}/api/events`, shop });
}

export async function enableTracking(db: PrismaClient, admin: AdminGraphql, shop: string, appUrl: string) {
  const settings = pixelSettings(appUrl, shop);
  const existing = await db.shop.findUnique({ where: { domain: shop }, select: { pixelId: true } });

  let pixelId: string | undefined;
  let errors: UserError[] = [];
  if (existing?.pixelId) {
    const data = await run<{ webPixelUpdate: { webPixel: { id: string } | null; userErrors: UserError[] } }>(
      admin, UPDATE, { id: existing.pixelId, settings },
    );
    pixelId = data.webPixelUpdate.webPixel?.id;
    errors = data.webPixelUpdate.userErrors;
  }
  if (!pixelId) {
    const data = await run<{ webPixelCreate: { webPixel: { id: string } | null; userErrors: UserError[] } }>(
      admin, CREATE, { settings },
    );
    pixelId = data.webPixelCreate.webPixel?.id;
    errors = data.webPixelCreate.userErrors;
  }
  if (!pixelId) throw new Error(`Could not switch tracking on: ${errors.map((e) => e.message).join("; ")}`);

  await db.shop.update({ where: { domain: shop }, data: { pixelId, trackingEnabled: true } });
  return pixelId;
}

export async function disableTracking(db: PrismaClient, admin: AdminGraphql, shop: string) {
  const existing = await db.shop.findUnique({ where: { domain: shop }, select: { pixelId: true } });
  if (existing?.pixelId) {
    await run(admin, DELETE, { id: existing.pixelId });
  }
  await db.shop.update({ where: { domain: shop }, data: { pixelId: null, trackingEnabled: false } });
}
