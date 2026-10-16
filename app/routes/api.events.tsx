import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { ingest, MAX_BODY_BYTES } from "../lib/events/ingest.server";

// Public endpoint the storefront pixel posts to. Accepts events only for a shop that has tracking
// switched ON. Holds no personal data beyond Shopify's anonymous clientId and customer id.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS" };

// Very small per-instance rate limit: 120 events per minute per client IP.
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    if (hits.size > 50_000) hits.clear();
    return false;
  }
  h.n += 1;
  return h.n > 120;
}

export const loader = () => new Response(null, { status: 405, headers: CORS });

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "unknown";
  if (limited(ip)) return new Response(null, { status: 429, headers: CORS });

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413, headers: CORS });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400, headers: CORS });
  }

  try {
    const { status } = await ingest(db, body);
    return new Response(null, { status, headers: CORS });
  } catch (e) {
    console.error("[events] ingest failed", e);
    return new Response(null, { status: 500, headers: CORS });
  }
};
