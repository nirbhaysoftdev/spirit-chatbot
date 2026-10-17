// Scorer + rule + diversity tests (unit).
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  applyRules,
  buildList,
  diversify,
  mergeCandidates,
  priceBandFromRows,
  scoreAll,
  type Rule,
} from "~/lib/brain/score";
import type { Candidate } from "~/lib/brain/candidates.server";

const c = (over: Partial<Candidate> = {}): Candidate => ({
  id: over.id ?? "gid://shopify/Product/a",
  title: over.title ?? "Test",
  shop: "s.myshopify.com",
  vendor: "V",
  region: "Islay",
  style: "Single Malt",
  abv: new Prisma.Decimal("46"),
  volumeMl: 700,
  status: "ACTIVE",
  availableForSale: true,
  inventoryQuantity: 10,
  price: new Prisma.Decimal("50"),
  compareAtPrice: null,
  tasteVector: [5, 2, 0, 0, 0, 0, 0, 1, 1, 2, 1, 2],
  flavours: ["Smokey & Peaty"],
  caskTypes: ["Bourbon"],
  peated: true,
  outturn: null,
  ageYears: 12,
  singleCask: false,
  limitedEdition: false,
  exclusive: false,
  publishedAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  reason: "TRENDING",
  rawScore: 0.5,
  ...over,
});

describe("mergeCandidates", () => {
  it("keeps the single best-reasoned row per product and remembers the rest", () => {
    const trend = c({ id: "gid://shopify/Product/1", reason: "TRENDING", rawScore: 1 });
    const taste = c({ id: "gid://shopify/Product/1", reason: "TASTE_MATCH", rawScore: 0.9 });
    const merged = mergeCandidates([[trend], [taste]]);
    expect(merged).toHaveLength(1);
    // TASTE_MATCH has a higher base weight (0.35) than TRENDING (0.12), so it wins
    expect(merged[0].reason).toBe("TASTE_MATCH");
  });
});

describe("scoring", () => {
  it("adds source + taste + price_fit + quality + novelty, never double-counting taste", () => {
    const r = scoreAll([c()], { tasteVector: c().tasteVector, priceBand: { low: 40, high: 80 } })[0];
    expect(r.score).toBeGreaterThan(0);
    expect(r.components.taste).toBeGreaterThan(0);
    // TASTE_MATCH suppresses the taste component to avoid double counting
    const t = scoreAll([c({ reason: "TASTE_MATCH" })], { tasteVector: c().tasteVector })[0];
    expect(t.components.taste).toBe(0);
  });
});

describe("rules", () => {
  const now = new Date("2026-06-15T12:00:00Z");
  const base: Rule = { id: "r1", action: "BLOCK", targetType: "PRODUCT", targetId: "gid://shopify/Product/1", value: null, priority: 0, startsAt: null, endsAt: null, scope: null };
  const scored = scoreAll([c({ id: "gid://shopify/Product/1" }), c({ id: "gid://shopify/Product/2" })], {});

  it("BLOCK removes a product", () => {
    const r = applyRules(scored, [base], {}, now);
    expect(r.pool.find((x) => x.id === "gid://shopify/Product/1")).toBeUndefined();
    expect(r.blocked).toHaveLength(1);
  });

  it("BOOST multiplies the score (defaulting to 1.5x) and records the rule", () => {
    const r = applyRules(scored, [{ ...base, action: "BOOST", value: 2 }], {}, now);
    const hit = r.pool.find((x) => x.id === "gid://shopify/Product/1")!;
    const other = r.pool.find((x) => x.id === "gid://shopify/Product/2")!;
    expect(hit.score).toBeCloseTo(other.score * 2, 5);
    expect(hit.appliedRule).toMatchObject({ action: "BOOST", value: 2 });
  });

  it("PIN takes its slot in the final list", () => {
    const r = applyRules(scored, [{ ...base, action: "PIN", value: 1 }], {}, now);
    const built = buildList(r, 2);
    expect(built.items[0].id).toBe("gid://shopify/Product/1");
    expect(built.items[0].appliedRule?.action).toBe("PIN");
  });

  it("rule scope filters by chip, country and dates", () => {
    const chipOnly: Rule = { ...base, action: "BOOST", scope: { chip: "rarest" } };
    const inScope = applyRules(scored, [chipOnly], { chip: "rarest" }, now);
    const outScope = applyRules(scored, [chipOnly], { chip: "trending" }, now);
    expect(inScope.pool[0].score).not.toBe(outScope.pool[0].score);
    const expired: Rule = { ...base, action: "BOOST", endsAt: new Date("2025-01-01") };
    const skipped = applyRules(scored, [expired], {}, now);
    expect(skipped.pool.every((x) => !x.appliedRule)).toBe(true);
  });

  it("higher priority wins when two rules match", () => {
    const low: Rule = { ...base, id: "low", action: "BURY", value: 0.5, priority: 1 };
    const high: Rule = { ...base, id: "hi", action: "BOOST", value: 2, priority: 10 };
    const r = applyRules(scored, [low, high], {}, now);
    expect(r.pool.find((x) => x.id === "gid://shopify/Product/1")!.appliedRule?.ruleId).toBe("hi");
  });
});

describe("diversity (MMR)", () => {
  it("prefers variety over 5 near-identical bottles", () => {
    // Three identical smoky Islays plus one sherried Speyside, all equal score.
    const smoky1 = scoreAll([c({ id: "a", tasteVector: [5, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1] })], {})[0];
    const smoky2 = scoreAll([c({ id: "b", tasteVector: [5, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1] })], {})[0];
    const smoky3 = scoreAll([c({ id: "c", tasteVector: [5, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1] })], {})[0];
    const sherry = scoreAll([c({ id: "d", tasteVector: [0, 0, 5, 2, 0, 0, 0, 2, 1, 0, 2, 2] })], {})[0];
    const picks = diversify([smoky1, smoky2, smoky3, sherry], 2, 0.5);
    const ids = picks.map((p) => p.id).sort();
    // 2nd pick should be the sherry (the diverse one), not another smoky
    expect(ids).toContain("d");
  });
});

describe("priceBandFromRows", () => {
  it("returns Q1 and 1.5× Q3 of past purchase prices", () => {
    const rows = [10, 20, 30, 40, 50].map((p) => ({ price: new Prisma.Decimal(p) }));
    const band = priceBandFromRows(rows)!;
    expect(band.low).toBe(20); // 25th percentile ≈ 20
    expect(band.high).toBeCloseTo(60, 0); // 40 (75th) × 1.5
  });
});
