// Scorer + merchant rule applier + MMR diversity. Pure functions; no I/O.
// Order of operations (compliance has already run upstream):
//   1. Merge duplicates across generators, keeping the best source reason.
//   2. Apply the final score formula.
//   3. BLOCK rules remove products.
//   4. PIN rules take their slots first.
//   5. BOOST/BURY multiply the score.
//   6. MMR picks the final list for diversity.

import { Prisma } from "@prisma/client";
import type { Candidate, ReasonCode } from "./candidates.server";
import { cosine } from "../catalog/taste";
import { toNumber } from "./compliance";

// Rule rows from the DB (shape of the Rule model).
export interface Rule {
  id: string;
  action: "PIN" | "BOOST" | "BURY" | "BLOCK";
  targetType: "PRODUCT" | "VENDOR" | "TAG" | "COLLECTION";
  targetId: string;
  value: number | null; // boost multiplier (×n) or pin slot (1-based)
  priority: number;
  startsAt: Date | null;
  endsAt: Date | null;
  scope: { chip?: string; segment?: string; countries?: string[] } | null;
}

export interface ScoreContext {
  chip?: string;
  countryCode?: string | null;
  segment?: string | null;
  /** The shopper's spend band (min/max). Candidates far outside get a price-fit penalty. */
  priceBand?: { low: number; high: number } | null;
  /** The shopper's taste vector (0..5 per dim), when known. */
  tasteVector?: number[];
}

/** Final score components, kept per-candidate so the UI can show the "why". */
export interface Scored extends Candidate {
  score: number;
  components: Record<string, number>;
  appliedRule?: { ruleId: string; action: Rule["action"]; value?: number };
}

// Reason → base weight. Higher = this generator's signal is more trustworthy.
const REASON_WEIGHT: Record<ReasonCode, number> = {
  TASTE_MATCH: 0.35,
  BOUGHT_SIMILAR: 0.30,
  STORE_FBT: 0.25, // the team's own data: trust it
  STORE_UPSELL: 0.20,
  COBUY: 0.15,
  COMPLEMENTS: 0.15,
  TRENDING: 0.12,
  RARE_FIND: 0.10,
  RARE_LOW_STOCK: 0.12,
  RESTOCK_DUE: 0.15,
  RETURNING_FAVOURITE: 0.20,
  BESTSELLER: 0.10,
  NEW_ARRIVAL: 0.08,
  ON_SALE: 0.10,
  SEARCHED_TERM: 0.15,
};

// Merge duplicates: keep the single row with the highest base-weighted score.
// Keeps all reasons seen (second-best as a note), useful for logging and the UI.
export function mergeCandidates(lists: Candidate[][]): Candidate[] {
  const best = new Map<string, Candidate & { otherReasons: ReasonCode[] }>();
  for (const list of lists) {
    for (const c of list) {
      const prev = best.get(c.id);
      const w = REASON_WEIGHT[c.reason] * c.rawScore;
      const prevW = prev ? REASON_WEIGHT[prev.reason] * prev.rawScore : -Infinity;
      if (!prev) {
        best.set(c.id, { ...c, otherReasons: [] });
      } else if (w > prevW) {
        best.set(c.id, { ...c, otherReasons: [prev.reason, ...prev.otherReasons.filter((r) => r !== c.reason)] });
      } else if (!prev.otherReasons.includes(c.reason) && prev.reason !== c.reason) {
        prev.otherReasons.push(c.reason);
      }
    }
  }
  return [...best.values()];
}

/** Price fit: 1 at the centre of the shopper's band, decaying smoothly outside it. */
function priceFit(price: number, band?: { low: number; high: number } | null): number {
  if (!band) return 0.5;
  if (price >= band.low && price <= band.high) return 1;
  const dist = price < band.low ? band.low - price : price - band.high;
  const span = Math.max(1, band.high - band.low);
  return Math.max(0, 1 - dist / (span * 2));
}

function quality(c: Candidate): number {
  // Light proxy: cask-strength ABV, age statement and limited edition add polish.
  let q = 0.5;
  const abv = toNumber(c.abv);
  if (abv != null && abv >= 46) q += 0.1;
  if (abv != null && abv >= 55) q += 0.1;
  if (c.ageYears && c.ageYears >= 12) q += 0.1;
  if (c.limitedEdition) q += 0.1;
  if (c.exclusive) q += 0.1;
  return Math.min(1, q);
}

function novelty(c: Candidate): number {
  if (!c.publishedAt) return 0.3;
  const days = (Date.now() - c.publishedAt.getTime()) / 86400_000;
  return Math.max(0, Math.min(1, 1 - days / 365));
}

/** Final score for one candidate. */
export function scoreOne(c: Candidate, ctx: ScoreContext): Scored {
  const price = toNumber(c.price) ?? 0;
  const components: Record<string, number> = {
    source: REASON_WEIGHT[c.reason] * c.rawScore,
    taste: ctx.tasteVector?.length && c.tasteVector?.length ? 0.20 * cosine(ctx.tasteVector, c.tasteVector) : 0,
    price_fit: 0.10 * priceFit(price, ctx.priceBand),
    quality: 0.10 * quality(c),
    novelty: 0.05 * novelty(c),
  };
  // Avoid double-scoring the exact same taste signal when the source is already TASTE_MATCH.
  if (c.reason === "TASTE_MATCH") components.taste = 0;
  const score = Object.values(components).reduce((a, b) => a + b, 0);
  return { ...c, score, components };
}

export function scoreAll(cs: Candidate[], ctx: ScoreContext): Scored[] {
  return cs.map((c) => scoreOne(c, ctx));
}

// ── Merchant rules ──────────────────────────────────────────────────────────

export function ruleApplies(rule: Rule, ctx: ScoreContext, now = new Date()): boolean {
  if (rule.startsAt && now < rule.startsAt) return false;
  if (rule.endsAt && now > rule.endsAt) return false;
  const scope = rule.scope ?? {};
  if (scope.chip && scope.chip !== ctx.chip) return false;
  if (scope.segment && scope.segment !== (ctx.segment ?? "")) return false;
  if (scope.countries?.length && (!ctx.countryCode || !scope.countries.includes(ctx.countryCode))) return false;
  return true;
}

export function matches(rule: Rule, c: Candidate, collectionIds?: Set<string>): boolean {
  switch (rule.targetType) {
    case "PRODUCT": return c.id === rule.targetId;
    case "VENDOR": return !!c.vendor && c.vendor === rule.targetId;
    case "TAG": {
      // the Candidate type does not include tags; the caller passes a map of productId -> tags
      return (c as unknown as { tags?: string[] }).tags?.includes(rule.targetId) ?? false;
    }
    case "COLLECTION": return collectionIds?.has(c.id) ?? false;
  }
}

export interface ApplyRulesResult {
  blocked: Scored[];
  pinned: { slot: number; candidate: Scored; rule: Rule }[];
  pool: Scored[];
}

/** Apply BLOCK, PIN, BOOST and BURY to the scored list, in rule order (highest priority first). */
export function applyRules(scored: Scored[], rules: Rule[], ctx: ScoreContext, now = new Date()): ApplyRulesResult {
  const active = rules.filter((r) => ruleApplies(r, ctx, now)).sort((a, b) => b.priority - a.priority);

  // 1. BLOCK
  const blocked: Scored[] = [];
  let pool = scored.filter((c) => {
    for (const r of active) {
      if (r.action === "BLOCK" && matches(r, c)) {
        blocked.push({ ...c, appliedRule: { ruleId: r.id, action: "BLOCK" } });
        return false;
      }
    }
    return true;
  });

  // 2. BOOST / BURY (multiplies the score; cheapest for the UI since order is still a sort)
  pool = pool.map((c) => {
    for (const r of active) {
      if ((r.action === "BOOST" || r.action === "BURY") && matches(r, c)) {
        const mul = r.value ?? (r.action === "BOOST" ? 1.5 : 0.5);
        return { ...c, score: c.score * mul, appliedRule: { ruleId: r.id, action: r.action, value: mul } };
      }
    }
    return c;
  });

  // 3. PIN (slots 1..N; a pinned product skips scoring and sits at that slot)
  const pinned: ApplyRulesResult["pinned"] = [];
  const pinnedIds = new Set<string>();
  for (const r of active) {
    if (r.action !== "PIN") continue;
    const slot = Math.max(1, Math.round(r.value ?? 1));
    const hit = pool.find((c) => matches(r, c) && !pinnedIds.has(c.id));
    if (hit) {
      pinned.push({ slot, candidate: { ...hit, appliedRule: { ruleId: r.id, action: "PIN", value: slot } }, rule: r });
      pinnedIds.add(hit.id);
    }
  }
  pool = pool.filter((c) => !pinnedIds.has(c.id));

  return { blocked, pinned, pool };
}

// ── Diversity (MMR) ─────────────────────────────────────────────────────────

/** Maximal Marginal Relevance over taste vectors. Prevents 5 near-identical bottles in a row. */
export function diversify(scored: Scored[], n: number, lambda = 0.7): Scored[] {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const out: Scored[] = [];
  while (out.length < n && sorted.length) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      const sim = out.length === 0
        ? 0
        : Math.max(...out.map((o) => c.tasteVector.length && o.tasteVector.length ? cosine(c.tasteVector, o.tasteVector) : 0));
      const mmr = lambda * c.score - (1 - lambda) * sim;
      if (mmr > bestVal) {
        bestVal = mmr;
        bestIdx = i;
      }
    }
    out.push(sorted[bestIdx]);
    sorted.splice(bestIdx, 1);
  }
  return out;
}

// ── Final list builder ──────────────────────────────────────────────────────

export interface BuildResult {
  items: Scored[];
  blockedByRule: Scored[];
}

/** Combine pins, MMR'd pool, and ensure no duplicate occupies a pinned slot. */
export function buildList(result: ApplyRulesResult, n: number): BuildResult {
  const diverse = diversify(result.pool, n);
  const out: (Scored | undefined)[] = new Array(n);
  for (const { slot, candidate } of result.pinned) {
    if (slot >= 1 && slot <= n && !out[slot - 1]) out[slot - 1] = candidate;
  }
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (out[i]) continue;
    while (j < diverse.length && out.includes(diverse[j])) j++;
    out[i] = diverse[j++];
  }
  return { items: out.filter((x): x is Scored => !!x), blockedByRule: result.blocked };
}

/** Price band inferred from a customer's spend. 1.5× cap matches the design doc. */
export function priceBandFromRows(rows: { price: Prisma.Decimal | number }[]): { low: number; high: number } | null {
  const prices = rows.map((r) => (typeof r.price === "number" ? r.price : Number(r.price.toString()))).filter((n) => n > 0).sort((a, b) => a - b);
  if (prices.length < 2) return null;
  const q = (p: number) => prices[Math.floor((prices.length - 1) * p)];
  return { low: q(0.25), high: q(0.75) * 1.5 };
}
