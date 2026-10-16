// Whisky attributes for every product, from three sources in priority order:
//   1. the store's own custom.* metafields (the team maintains these: abv, age, region, cask...)
//   2. product tags (region, flavour group, cask, "Heavily Peated")
//   3. text rules over title + description (fills only what 1 and 2 left empty)
// This is the FREE first pass of the brain. The AI enrichment step (phase 2) only fills what
// is still empty, and the team reviews low-confidence values. Nothing here writes to Shopify.

/** Metafields keyed "namespace.key" → raw string value, as Shopify returns them. */
export type MetafieldMap = Record<string, string | null | undefined>;

export interface ExtractInput {
  title: string;
  description?: string | null;
  tags?: string[];
  productType?: string | null;
  vendor?: string | null;
  metafields?: MetafieldMap;
}

export type Source = "metafield" | "tag" | "text";

export interface Extracted {
  region: string | null;
  style: string | null;
  distillery: string | null;
  ageYears: number | null;
  noAgeStatement: boolean;
  abv: number | null;
  volumeMl: number | null;
  sizeLabel: string | null;
  caskTypes: string[];
  flavours: string[];
  peated: boolean | null;
  outturn: number | null;
  vintage: number | null;
  singleCask: boolean | null;
  limitedEdition: boolean | null;
  exclusive: boolean | null;
  tastingNotes: string | null;
  fbtProductIds: string[];
  upsellIds: string[];
  /** Which source filled each field, so the team can see what to fix in Shopify. */
  sources: Partial<Record<keyof Omit<Extracted, "sources">, Source>>;
}

/** The store's flavour groups (from its "Shop by Flavour" menus and tags). */
export const FLAVOUR_GROUPS = [
  "Dried Fruits & Sherry",
  "Floral & Herbal",
  "Light & Grassy",
  "Grassy & Citrus",
  "Fruit, Nuts & Cereals",
  "Fresh Fruits",
  "Pear & Apple",
  "Smokey & Peaty",
  "Sweet Smoke",
  "Toffee, Honey & Vanilla",
  "Toffee & Vanilla",
  "Nutty & Oily",
  "Woody & Spicy",
  "Smooth & Fruity",
] as const;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

const FLAVOUR_LOOKUP = new Map<string, string>([
  ...FLAVOUR_GROUPS.map((f) => [norm(f), f] as [string, string]),
  // Tag spellings seen in the catalogue that differ from the menu labels
  [norm("Peaty Smokey"), "Smokey & Peaty"],
  [norm("Dried Fruits Sherry"), "Dried Fruits & Sherry"],
  [norm("Toffee Honey Vanilla"), "Toffee, Honey & Vanilla"],
  [norm("Fruit Nuts Cereals"), "Fruit, Nuts & Cereals"],
]);

export function normaliseFlavour(value: string): string | null {
  return FLAVOUR_LOOKUP.get(norm(value)) ?? null;
}

function yesNo(v: string | null | undefined): boolean | null {
  if (v == null) return null;
  const s = v.trim().toLowerCase();
  if (["yes", "true", "y", "1"].includes(s)) return true;
  if (["no", "false", "n", "0"].includes(s)) return false;
  return null;
}

function gidList(v: string | null | undefined): string[] {
  if (!v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const SIZE_TO_ML: Record<string, number> = {
  regularbottle: 700,
  quarterbottle: 200,
  halfbottle: 350,
  miniature: 50,
  magnum: 1500,
  litre: 1000,
};

const REGIONS: [RegExp, string][] = [
  [/\bislay\b/i, "Islay"],
  [/\bspeyside\b/i, "Speyside"],
  [/\bcampbeltown\b/i, "Campbeltown"],
  [/\blowland\b/i, "Lowland"],
  [/\bhighland\b/i, "Highland"],
  [/\b(islands?|orkney|skye|mull|jura|arran|raasay|harris)\b/i, "Islands"],
];

const STYLES: [RegExp, string][] = [
  [/\bsingle\s+grain\b/i, "Single Grain"],
  [/\bsingle\s+malt\b/i, "Single Malt"],
  [/\bblended\s+malt\b/i, "Blended Malt"],
  [/\bblended\s+scotch\b|\bblend\b/i, "Blended Scotch"],
  [/\bbourbon\s+whisk(e)?y\b|\bkentucky\b/i, "Bourbon"],
  [/\brye\b/i, "Rye"],
  [/\bgin\b/i, "Gin"],
  [/\brum\b/i, "Rum"],
  [/\bvodka\b/i, "Vodka"],
  [/\btequila\b/i, "Tequila"],
  [/\bliqueur\b/i, "Liqueur"],
];

const CASKS: [RegExp, string][] = [
  [/\boloroso\b/i, "Oloroso"],
  [/\bpedro\s+xim[eé]nez\b|\bPX\b/, "Pedro Ximenez"],
  [/\bpalo\s+cortado\b/i, "Palo Cortado"],
  [/\bmoscatel\b/i, "Moscatel"],
  [/\bamoroso\b/i, "Amoroso"],
  [/\bsherry\b/i, "Sherry"],
  [/\bport\b/i, "Port"],
  [/\bbourbon\s+(cask|barrel|hogshead)s?\b|\bex-bourbon\b|\bfirst[- ]fill\s+bourbon\b/i, "Bourbon"],
  [/\b(red\s+)?wine\s+cask\b|\bbordeaux\b|\bpinot\b|\bsyrah\b/i, "Wine"],
  [/\bsauternes\b/i, "Sauternes"],
  [/\brum\s+(cask|finish|barrel)\b/i, "Rum"],
  [/\bmizunara\b/i, "Mizunara"],
  [/\bbrandy\b|\bcognac\b|\barmagnac\b/i, "Brandy"],
  [/\bvirgin\s+(american\s+|scottish\s+)?oak\b/i, "Virgin Oak"],
  [/\bmadeira\b/i, "Madeira"],
];

function textOf(input: ExtractInput) {
  return [input.title, input.productType ?? "", (input.tags ?? []).join(" "), input.description ?? ""].join(" \n ");
}

export function extractAbv(text: string): number | null {
  // "59.5% ABV", "ABV: 60.1%", "Bottled at 48% ABV", "cask strength 55.2%"
  const patterns = [
    /(\d{2}(?:\.\d{1,2})?)\s?%\s?(?:abv|vol|alc)/i,
    /abv[:\s]+(\d{2}(?:\.\d{1,2})?)\s?%/i,
    /(?:bottled at|strength(?: of)?|at)\s+(\d{2}(?:\.\d{1,2})?)\s?%/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = Number(m[1]);
      if (v >= 15 && v <= 80) return Math.round(v * 10) / 10;
    }
  }
  return null;
}

export function extractAge(title: string, text: string): number | null {
  // Prefer the title ("Glengoyne 12 Year Old", "Tomintoul 40 Years Old", "Aged 42 Years")
  const p = /(\d{1,2})\s?(?:-\s?)?(?:years?|yrs?|yo)\b(?:\s+old)?|aged\s+(\d{1,2})\s+years?/i;
  for (const src of [title, text]) {
    const m = src.match(p);
    if (m) {
      const v = Number(m[1] ?? m[2]);
      if (v >= 3 && v <= 80) return v;
    }
  }
  return null;
}

export function extractVintage(title: string, text: string): number | null {
  // A 4-digit year in the title is usually the vintage ("Macallan 1990", "Bowmore 1982").
  // In the description only trust "distilled in 2007" / "distilled June 2014" / "vintage 2016".
  const thisYear = new Date().getFullYear();
  const titleYear = title.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  if (titleYear) {
    const y = Number(titleYear[1]);
    if (y <= thisYear - 3) return y;
  }
  const descYear = text.match(/(?:distilled(?:\s+(?:in|on))?(?:\s+\w+)?|vintage)\s+(19[5-9]\d|20[0-2]\d)\b/i);
  if (descYear) {
    const y = Number(descYear[1]);
    if (y <= thisYear - 3) return y;
  }
  return null;
}

export function extractOutturn(text: string): number | null {
  // "1 of only 239 bottles", "Limited to only 165 bottles", "Outturn: 284", "just 155 bottles", "Yielding only 253 decanters"
  const patterns = [
    /outturn[:\s]+(\d{2,5})/i,
    /(?:only|just|limited to(?: only)?)\s+([\d,]{2,7})\s+(?:bottles|decanters)/i,
    /([\d,]{2,7})\s+bottles\s+(?:released|available|in the world)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = Number(m[1].replace(/,/g, ""));
      if (v > 0 && v < 1_000_000) return v;
    }
  }
  return null;
}

export function extractVolume(text: string): number | null {
  const m = text.match(/\b(\d{1,4}(?:\.\d)?)\s?(cl|ml|l(?:itre)?)\b/i);
  if (!m) {
    if (/quarter bottle/i.test(text)) return 200;
    if (/miniature/i.test(text)) return 50;
    return null;
  }
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ml = unit === "cl" ? n * 10 : unit.startsWith("l") ? n * 1000 : n;
  return ml >= 30 && ml <= 4500 ? Math.round(ml) : null;
}

export function extractPeated(text: string): boolean | null {
  if (/\bunpeated\b|\bnon-peated\b/i.test(text)) return false;
  if (/\bpeat(ed|y)?\b|\bsmok(y|ey|e)\b|\bppm\b/i.test(text)) return true;
  return null;
}

function firstMatch(table: [RegExp, string][], ...sources: string[]): string | null {
  for (const src of sources) {
    for (const [re, name] of table) if (re.test(src)) return name;
  }
  return null;
}

function casksFrom(text: string): string[] {
  const found = CASKS.filter(([re]) => re.test(text)).map(([, name]) => name);
  // "Sherry" is redundant when a specific sherry style was found.
  const specificSherry = ["Oloroso", "Pedro Ximenez", "Palo Cortado", "Moscatel", "Amoroso"];
  return found.some((c) => specificSherry.includes(c)) ? found.filter((c) => c !== "Sherry") : found;
}

export function extractAttributes(input: ExtractInput): Extracted {
  const mf = input.metafields ?? {};
  const tags = input.tags ?? [];
  const tagText = tags.join(" | ");
  const text = textOf(input);
  const sources: Extracted["sources"] = {};
  const set = <K extends keyof Extracted["sources"]>(key: K, src: Source) => {
    sources[key] = src;
  };

  // ── Region: custom.speyside (named "Region" in admin) → tag → title/description
  let region: string | null = null;
  const mfRegion = mf["custom.speyside"];
  if (mfRegion) {
    region = firstMatch(REGIONS, mfRegion) ?? mfRegion.trim();
    set("region", "metafield");
  } else if ((region = firstMatch(REGIONS, tagText))) {
    set("region", "tag");
  } else if ((region = firstMatch(REGIONS, input.title, input.description ?? ""))) {
    set("region", "text");
  }

  // ── Style: custom.malt ("Spirit Type") → title/tags/product type
  let style: string | null = null;
  if (mf["custom.malt"] && (style = firstMatch(STYLES, mf["custom.malt"]))) {
    set("style", "metafield");
  } else if ((style = firstMatch(STYLES, tagText))) {
    set("style", "tag");
  } else if ((style = firstMatch(STYLES, input.title, input.productType ?? ""))) {
    set("style", "text");
  }

  // ── Distillery: custom.distillery → custom.brand → vendor (vendor is often the bottler, so last)
  let distillery: string | null = mf["custom.distillery"]?.trim() || null;
  if (distillery) set("distillery", "metafield");
  else if ((distillery = mf["custom.brand"]?.trim() || null)) set("distillery", "metafield");

  // ── Age: custom.age ("12 Years Old" | "No Age Statement") → "21 Years" tag → text
  let ageYears: number | null = null;
  let noAgeStatement = false;
  const mfAge = mf["custom.age"];
  if (mfAge && /no age statement|\bNAS\b/i.test(mfAge)) {
    noAgeStatement = true;
    set("noAgeStatement", "metafield");
  } else if (mfAge && (ageYears = extractAge(mfAge, ""))) {
    set("ageYears", "metafield");
  } else if ((ageYears = extractAge(tags.filter((t) => /\byears?\b/i.test(t)).join(" "), ""))) {
    set("ageYears", "tag");
  } else if ((ageYears = extractAge(input.title, text))) {
    set("ageYears", "text");
  }

  // ── ABV: custom.abv (number_decimal) → text
  let abv: number | null = null;
  const mfAbv = Number(mf["custom.abv"]);
  if (mf["custom.abv"] && Number.isFinite(mfAbv) && mfAbv > 0 && mfAbv <= 80) {
    abv = mfAbv;
    set("abv", "metafield");
  } else if ((abv = extractAbv(text))) {
    set("abv", "text");
  }

  // ── Volume: descriptors.subtitle ("70cl") → text → custom.size label
  let volumeMl: number | null = null;
  const sizeLabel = mf["custom.size"]?.trim() || null;
  if (mf["descriptors.subtitle"] && (volumeMl = extractVolume(mf["descriptors.subtitle"]))) {
    set("volumeMl", "metafield");
  } else if ((volumeMl = extractVolume(input.title + " " + (input.description ?? "")))) {
    set("volumeMl", "text");
  } else if (sizeLabel && SIZE_TO_ML[norm(sizeLabel)]) {
    volumeMl = SIZE_TO_ML[norm(sizeLabel)];
    set("volumeMl", "metafield");
  }

  // ── Casks: custom.cask_type + cask_type_2 + cask tags; text only if nothing structured
  const structuredCasks = casksFrom(
    [mf["custom.cask_type"], mf["custom.cask_type_2"], tags.filter((t) => /cask|oak/i.test(t)).join(" ")]
      .filter(Boolean)
      .join(" | ")
      .replace(/bourbon\s*\/\s*(american\s+)?oak(\s+cask)?/gi, "bourbon cask"),
  );
  let caskTypes = structuredCasks;
  if (caskTypes.length) set("caskTypes", mf["custom.cask_type"] ? "metafield" : "tag");
  else if ((caskTypes = casksFrom(text)).length) set("caskTypes", "text");

  // ── Flavours: custom.flavor + flavour tags (the store's own groups only)
  const flavours = Array.from(
    new Set(
      [mf["custom.flavor"], ...tags]
        .filter((v): v is string => !!v)
        .map(normaliseFlavour)
        .filter((v): v is string => !!v),
    ),
  );
  if (flavours.length) set("flavours", mf["custom.flavor"] ? "metafield" : "tag");

  // ── Peat: "Heavily Peated" tag or smoky flavour group → text
  let peated: boolean | null = null;
  if (/heavily peated|\bpeated\b/i.test(tagText) || flavours.includes("Smokey & Peaty") || flavours.includes("Sweet Smoke")) {
    peated = true;
    set("peated", "tag");
  } else if ((peated = extractPeated(text)) !== null) {
    set("peated", "text");
  }

  // ── Vintage: custom.vintage → title/description
  let vintage: number | null = null;
  const mfVintage = mf["custom.vintage"]?.match(/\b(19\d\d|20\d\d)\b/);
  if (mfVintage) {
    vintage = Number(mfVintage[1]);
    set("vintage", "metafield");
  } else if ((vintage = extractVintage(input.title, text))) {
    set("vintage", "text");
  }

  const outturn = extractOutturn(text);
  if (outturn) set("outturn", "text");

  // ── Yes/No flags and the team's own product links
  const singleCask = yesNo(mf["custom.single_cask"]) ?? (/\bsingle cask\b/i.test(input.title) ? true : null);
  if (singleCask !== null) set("singleCask", mf["custom.single_cask"] ? "metafield" : "text");
  const limitedEdition = yesNo(mf["custom.limited_edition"]);
  if (limitedEdition !== null) set("limitedEdition", "metafield");
  const exclusive = yesNo(mf["custom.exclusive_to_spirit_embassy"]);
  if (exclusive !== null) set("exclusive", "metafield");
  const tastingNotes = mf["custom.tasting_notes"]?.trim() || null;
  if (tastingNotes) set("tastingNotes", "metafield");
  const fbtProductIds = gidList(mf["custom.fbt"]);
  if (fbtProductIds.length) set("fbtProductIds", "metafield");
  const upsellIds = gidList(mf["custom.product_upsell"]);
  if (upsellIds.length) set("upsellIds", "metafield");

  return {
    region,
    style,
    distillery,
    ageYears,
    noAgeStatement,
    abv,
    volumeMl,
    sizeLabel,
    caskTypes,
    flavours,
    peated,
    outturn,
    vintage,
    singleCask,
    limitedEdition,
    exclusive,
    tastingNotes,
    fbtProductIds,
    upsellIds,
    sources,
  };
}

/** Metafields this app reads. Used in the bulk query and the webhook refetch. */
export const PRODUCT_METAFIELD_KEYS = [
  "custom.abv",
  "custom.age",
  "custom.speyside",
  "custom.malt",
  "custom.flavor",
  "custom.cask_type",
  "custom.cask_type_2",
  "custom.size",
  "custom.distillery",
  "custom.brand",
  "custom.vintage",
  "custom.single_cask",
  "custom.limited_edition",
  "custom.exclusive_to_spirit_embassy",
  "custom.tasting_notes",
  "custom.fbt",
  "custom.product_upsell",
  "descriptors.subtitle",
] as const;

export function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&eacute;/g, "é")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}
