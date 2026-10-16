// Starting rules for The Spirits Embassy. Safe to run more than once (upserts).
//   SHOP=the-spirits-embassy.myshopify.com npm run db:seed
// Shipping defaults are deliberately conservative: UK on, EU and US off until duty, tax
// representative and (for the US) state licences are confirmed. The team changes these later.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const shop = process.env.SHOP;
if (!shop) throw new Error("Set SHOP=<store>.myshopify.com");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const EU = [
  ["AT", "Austria"], ["BE", "Belgium"], ["BG", "Bulgaria"], ["HR", "Croatia"], ["CY", "Cyprus"],
  ["CZ", "Czechia"], ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"],
  ["DE", "Germany"], ["GR", "Greece"], ["HU", "Hungary"], ["IE", "Ireland"], ["IT", "Italy"],
  ["LV", "Latvia"], ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MT", "Malta"], ["NL", "Netherlands"],
  ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["SK", "Slovakia"], ["SI", "Slovenia"],
  ["ES", "Spain"], ["SE", "Sweden"],
];

const JURISDICTIONS = [
  { code: "GB", name: "United Kingdom", shippingEnabled: true, minimumAge: 18, dutyMode: "NONE", licenceStatus: "HELD",
    notes: "Dispatch from Huntly: Scottish rules apply to every order (MUP 65p/unit, no multibuy, payment 10:00-22:00, no delivery 00:00-06:00)." },
  ...EU.map(([code, name]) => ({
    code, name, shippingEnabled: false, minimumAge: 18, dutyMode: "NONE", licenceStatus: "MISSING",
    notes: code === "IE"
      ? "Excise goods must be held at a local facility for inspection. Off until arranged."
      : "Destination excise duty + possible tax representative needed. Off until arranged.",
  })),
  { code: "US", name: "United States", shippingEnabled: false, minimumAge: 21, dutyMode: "NONE", licenceStatus: "MISSING",
    notes: "Enable state by state (code US-XX) only where a retailer licence is held and state excise/sales tax is collected." },
];

const HOME_BUTTONS = [
  ["track_order", "Track my order", "ALGORITHM"],
  ["explore", "Explore Liquor", "ALGORITHM"],
  ["gift", "Find a gift", "ALGORITHM"],
  ["rare_old", "Rare and Old", "ALGORITHM"],
  ["club", "Tasting club and subscriptions", "COLLECTION"],
  ["human", "Talk to a person", "ALGORITHM"],
] as const;

const EXPLORE_CHIPS = [
  ["best_deals", "Best deals this week", { algorithm: "deals", minPriceAgeHours: 72 }],
  ["best_for_me", "Best for me", { algorithm: "personal" }],
  ["matches_taste", "Matches my taste", { algorithm: "taste" }],
  ["rarest", "Rarest of rare", { algorithm: "rarity" }],
  ["trending", "Trending now", { algorithm: "trending", windowHours: 48 }],
  ["most_demanded", "Most demanded", { algorithm: "demand" }],
  ["most_searched", "Most searched", { algorithm: "searched", windowDays: 7 }],
  ["new_arrivals", "New arrivals", { algorithm: "new" }],
] as const;

async function main() {
  for (const j of JURISDICTIONS) {
    await db.jurisdiction.upsert({
      where: { shop_code: { shop: shop!, code: j.code } },
      create: { shop: shop!, ...j },
      update: {}, // never overwrite what the team has changed
    });
  }
  for (const [i, [key, label, source]] of HOME_BUTTONS.entries()) {
    await db.menuItem.upsert({
      where: { shop_kind_key: { shop: shop!, kind: "HOME_BUTTON", key } },
      create: { shop: shop!, kind: "HOME_BUTTON", key, label, source, position: i, countries: [] },
      update: {},
    });
  }
  for (const [i, [key, label, config]] of EXPLORE_CHIPS.entries()) {
    await db.menuItem.upsert({
      where: { shop_kind_key: { shop: shop!, kind: "EXPLORE_CHIP", key } },
      create: { shop: shop!, kind: "EXPLORE_CHIP", key, label, source: "ALGORITHM", config, position: i, countries: [] },
      update: {},
    });
  }
  console.log(`Seeded ${JURISDICTIONS.length} jurisdictions, ${HOME_BUTTONS.length} home buttons, ${EXPLORE_CHIPS.length} chips for ${shop}`);
}

main().finally(() => db.$disconnect());
