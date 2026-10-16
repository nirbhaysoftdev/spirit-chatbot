// 12-dimension taste vector (0–5 per dimension) built from the store's own structured data.
// Same dimensions for products and customers, so "matches my taste" is a cosine similarity.
// Phase 2 refines these with AI-read tasting notes; this version is free and deterministic.
import type { Extracted } from "./extract";

export const TASTE_DIMENSIONS = [
  "smoke",
  "medicinal",
  "sherry",
  "fresh_fruit",
  "tropical",
  "floral",
  "honey",
  "spice",
  "oak",
  "maritime",
  "sweetness",
  "body",
] as const;
export type TasteDimension = (typeof TASTE_DIMENSIONS)[number];
type Partial12 = Partial<Record<TasteDimension, number>>;

const FLAVOUR_PROFILE: Record<string, Partial12> = {
  "Dried Fruits & Sherry": { sherry: 4, spice: 2, sweetness: 2, body: 3 },
  "Floral & Herbal": { floral: 4, fresh_fruit: 1 },
  "Light & Grassy": { floral: 2, fresh_fruit: 2, body: -1 },
  "Grassy & Citrus": { fresh_fruit: 3, floral: 2, body: -1 },
  "Fruit, Nuts & Cereals": { fresh_fruit: 2, oak: 1, body: 2 },
  "Fresh Fruits": { fresh_fruit: 4, sweetness: 1 },
  "Pear & Apple": { fresh_fruit: 4, sweetness: 1 },
  "Smokey & Peaty": { smoke: 4, medicinal: 2, maritime: 1, body: 2 },
  "Sweet Smoke": { smoke: 3, sweetness: 2, honey: 1 },
  "Toffee, Honey & Vanilla": { honey: 4, sweetness: 3 },
  "Toffee & Vanilla": { honey: 3, sweetness: 3 },
  "Nutty & Oily": { body: 3, oak: 1 },
  "Woody & Spicy": { oak: 3, spice: 3 },
  "Smooth & Fruity": { fresh_fruit: 3, sweetness: 2 },
};

const CASK_PROFILE: Record<string, Partial12> = {
  Sherry: { sherry: 3, spice: 1, body: 1 },
  Oloroso: { sherry: 4, spice: 1, body: 2 },
  "Pedro Ximenez": { sherry: 4, sweetness: 2, body: 2 },
  "Palo Cortado": { sherry: 3, oak: 1 },
  Moscatel: { sherry: 2, sweetness: 2, floral: 1 },
  Amoroso: { sherry: 3, sweetness: 1 },
  Port: { fresh_fruit: 2, sweetness: 2, body: 1 },
  Bourbon: { honey: 2, sweetness: 1, oak: 1 },
  Wine: { fresh_fruit: 2, spice: 1 },
  Sauternes: { sweetness: 3, honey: 1 },
  Rum: { tropical: 2, sweetness: 2 },
  Mizunara: { oak: 2, spice: 2, floral: 1 },
  Brandy: { fresh_fruit: 1, sweetness: 1 },
  "Virgin Oak": { oak: 3, spice: 2 },
  Madeira: { sweetness: 2, fresh_fruit: 1 },
};

const REGION_PROFILE: Record<string, Partial12> = {
  Islay: { smoke: 2, maritime: 3, medicinal: 1 },
  Islands: { maritime: 2, smoke: 1 },
  Campbeltown: { maritime: 2, body: 1 },
  Speyside: { fresh_fruit: 1, honey: 1 },
  Highland: { body: 1 },
  Lowland: { floral: 1, body: -1 },
};

const clamp = (v: number) => Math.max(0, Math.min(5, Math.round(v * 10) / 10));

export function tasteVector(a: Pick<Extracted, "flavours" | "caskTypes" | "peated" | "region" | "abv" | "ageYears">): number[] {
  const acc: Record<TasteDimension, number> = Object.fromEntries(TASTE_DIMENSIONS.map((d) => [d, 0])) as never;
  const add = (p: Partial12 | undefined, weight = 1) => {
    if (!p) return;
    for (const [k, v] of Object.entries(p)) acc[k as TasteDimension] += (v ?? 0) * weight;
  };

  // The team's flavour group is the strongest signal; casks and region add shading.
  for (const f of a.flavours) add(FLAVOUR_PROFILE[f], 1);
  for (const c of a.caskTypes) add(CASK_PROFILE[c], a.flavours.length ? 0.5 : 1);
  if (a.region) add(REGION_PROFILE[a.region], 0.5);
  if (a.peated === true) acc.smoke = Math.max(acc.smoke, 3);
  if (a.peated === false) acc.smoke = Math.min(acc.smoke, 0.5);
  if (a.abv && a.abv >= 50) acc.body += 1; // cask strength feels bigger
  if (a.ageYears && a.ageYears >= 18) acc.oak += 1;

  return TASTE_DIMENSIONS.map((d) => clamp(acc[d]));
}

/** True when there is enough structured data for the vector to mean something. */
export function hasTasteSignal(a: Pick<Extracted, "flavours" | "caskTypes" | "peated">): boolean {
  return a.flavours.length > 0 || a.caskTypes.length > 0 || a.peated !== null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
