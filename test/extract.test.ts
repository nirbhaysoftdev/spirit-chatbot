// Fixtures are real products from thespiritsembassy.com (titles, tags and metafields as stored in Shopify).
import { describe, expect, it } from "vitest";
import { extractAttributes, extractAbv, extractAge, extractOutturn, extractVintage, stripHtml } from "~/lib/catalog/extract";
import { tasteVector, cosine, TASTE_DIMENSIONS } from "~/lib/catalog/taste";

describe("metafields win over tags and text", () => {
  it("Singleton of Dufftown 12 Year Old", () => {
    const a = extractAttributes({
      title: "Singleton of Dufftown 12 Year Old",
      productType: "Whisky",
      vendor: "Singleton",
      tags: ["Bourbon / Oak Cask", "Pear Apple", "Product", "Single Malt", "Singleton", "Speyside"],
      description: "This smooth, naturally rich Single Malt Scotch Whisky has sweet fruity notes...",
      metafields: {
        "custom.malt": "Single Malt Scotch Whisky",
        "custom.speyside": "Speyside",
        "custom.age": "12 Years Old",
        "custom.exclusive_to_spirit_embassy": "No",
      },
    });
    expect(a.region).toBe("Speyside");
    expect(a.sources.region).toBe("metafield");
    expect(a.style).toBe("Single Malt");
    expect(a.ageYears).toBe(12);
    expect(a.sources.ageYears).toBe("metafield");
    expect(a.caskTypes).toEqual(["Bourbon"]);
    expect(a.flavours).toEqual(["Pear & Apple"]);
    expect(a.exclusive).toBe(false);
  });

  it("Monkey Shoulder Smokey Monkey: flavour + cask metafields, peat from tags", () => {
    const a = extractAttributes({
      title: "Monkey Shoulder Smokey Monkey",
      productType: "Whisky",
      tags: ["Blend", "Heavily Peated", "Monkey Shoulder", "Peaty Smokey"],
      metafields: {
        "custom.brand": "Monkey Shoulder",
        "custom.cask_type": "Bourbon/American Oak",
        "custom.size": "Regular Bottle",
        "custom.abv": "40.0",
        "custom.malt": "Blended Malt Scotch Whisky",
        "custom.flavor": "Peaty Smokey",
        "custom.limited_edition": "No",
      },
    });
    expect(a.style).toBe("Blended Malt");
    expect(a.abv).toBe(40);
    expect(a.caskTypes).toEqual(["Bourbon"]);
    expect(a.flavours).toEqual(["Smokey & Peaty"]);
    expect(a.peated).toBe(true);
    expect(a.volumeMl).toBe(700);
    expect(a.limitedEdition).toBe(false);
    expect(a.distillery).toBe("Monkey Shoulder");
  });

  it("Balvenie Doublewood quarter bottle: size from subtitle, FBT links kept", () => {
    const a = extractAttributes({
      title: "Balvenie Doublewood 12 Year Old Quarter Bottle",
      tags: ["Balvenie", "Bourbon / Oak Cask", "Product", "Single Malt", "Speyside"],
      description: "...sherry casks... This is a 20cl Bottle.",
      metafields: {
        "custom.abv": "40.0",
        "custom.size": "Quarter Bottle",
        "custom.age": "12 Years Old",
        "descriptors.subtitle": "20cl",
        "custom.fbt": '["gid://shopify/Product/6991488745507"]',
      },
    });
    expect(a.volumeMl).toBe(200);
    expect(a.sources.volumeMl).toBe("metafield");
    expect(a.sizeLabel).toBe("Quarter Bottle");
    expect(a.fbtProductIds).toEqual(["gid://shopify/Product/6991488745507"]);
  });

  it("Oban Little Bay: No Age Statement is recorded, not guessed", () => {
    const a = extractAttributes({
      title: "Oban Little Bay Whisky",
      tags: ["Bourbon / Oak Cask", "Highland", "Oban", "Product", "Single Malt"],
      description: "For two centuries Oban’s bustling fishing village...",
      metafields: { "custom.age": "No Age Statement", "descriptors.subtitle": "70cl" },
    });
    expect(a.noAgeStatement).toBe(true);
    expect(a.ageYears).toBeNull();
    expect(a.volumeMl).toBe(700);
    expect(a.region).toBe("Highland");
    expect(a.sources.region).toBe("tag");
  });
});

describe("text rules fill gaps when metafields are missing", () => {
  it("Octomore 17.2 (no metafields)", () => {
    const a = extractAttributes({
      title: "Octomore 17.2",
      tags: ["Islay", "Product", "Single Malt"],
      description:
        "Edition 17.2 is a compelling second step in the 17 Series journey, a double wood maturation of super heavily peated single malt. Aged for 5 years - 4 years in second fill French oak, latterly maturing Bourbon, finished in first fill Port Barriques. Bottled at 59.5% ABV.",
    });
    expect(a.abv).toBe(59.5);
    expect(a.sources.abv).toBe("text");
    expect(a.region).toBe("Islay");
    expect(a.peated).toBe(true);
    expect(a.caskTypes).toContain("Port");
  });

  it("Glen Garioch 14 Whisky Craft: outturn + cask strength + PX/Oloroso", () => {
    const d =
      "1 of only 239 bottles. A 14-year-old Highland single malt finished for 16 months in a first-fill Oloroso barrique. Bottled at cask strength 55.2%.";
    const a = extractAttributes({ title: "Glen Garioch 14 Year Old Whisky Craft", tags: ["Highland", "Single Malt"], description: d });
    expect(a.ageYears).toBe(14);
    expect(a.outturn).toBe(239);
    expect(a.abv).toBe(55.2);
    expect(a.caskTypes).toEqual(["Oloroso"]);
  });

  it("Isle of Raasay unpeated is not marked peated", () => {
    const a = extractAttributes({
      title: "Isle of Raasay Na Sia 7 Years Evolved Red Wine Single Cask Unpeated",
      tags: ["Highland", "Single Malt"],
      description: "this unpeated spirit has spent seven years in hand-selected ex-Bordeaux Red Wine Casks. Cask no: 19/468 (Unpeated) ABV: 60.1% Outturn: 284",
    });
    expect(a.peated).toBe(false);
    expect(a.abv).toBe(60.1);
    expect(a.outturn).toBe(284);
    expect(a.singleCask).toBe(true);
    expect(a.caskTypes).toContain("Wine");
  });
});

describe("single-field helpers", () => {
  it("ABV patterns", () => {
    expect(extractAbv("Bottled at 48% ABV")).toBe(48);
    expect(extractAbv("cask strength of 43.1%, unchill-filtered")).toBe(43.1);
    expect(extractAbv("Save 15% today")).toBeNull();
  });
  it("age patterns", () => {
    expect(extractAge("Tomintoul 40 Years Old Second Edition", "")).toBe(40);
    expect(extractAge("RAREST RESERVE BOWMORE 1982 AGED 42 YEARS", "")).toBe(42);
    expect(extractAge("Octomore 17.3", "")).toBeNull();
  });
  it("vintage and outturn", () => {
    expect(extractVintage("The Accolade Macallan 1990 26510", "")).toBe(1990);
    expect(extractVintage("Ledaig 19 Year Old", "distilled in 2007 by Gordon & Macphail")).toBe(2007);
    expect(extractOutturn("Limited to only 165 bottles")).toBe(165);
    expect(extractOutturn("Yielding only 253 decanters")).toBe(253);
  });
  it("strips HTML", () => {
    expect(stripHtml("<p>Lush &amp; sweet</p><div>sea salt</div>")).toBe("Lush & sweet\nsea salt");
  });
});

describe("taste vectors", () => {
  const smoky = extractAttributes({
    title: "Monkey Shoulder Smokey Monkey",
    tags: ["Heavily Peated", "Peaty Smokey"],
    metafields: { "custom.cask_type": "Bourbon/American Oak" },
  });
  const sherried = extractAttributes({
    title: "The Balvenie DoubleWood 12 Year Old",
    tags: ["Dried Fruits Sherry", "Speyside"],
    metafields: { "custom.cask_type": "Sherry" },
  });
  const islay = extractAttributes({ title: "Laphroaig 7 Year Old", tags: ["Islay", "Peaty Smokey"] });

  it("has 12 dimensions in range 0-5", () => {
    const v = tasteVector(smoky);
    expect(v).toHaveLength(TASTE_DIMENSIONS.length);
    expect(v.every((x) => x >= 0 && x <= 5)).toBe(true);
  });
  it("smoky whiskies are closer to each other than to a sherried one", () => {
    const s = tasteVector(smoky);
    expect(cosine(s, tasteVector(islay))).toBeGreaterThan(cosine(s, tasteVector(sherried)));
  });
});
