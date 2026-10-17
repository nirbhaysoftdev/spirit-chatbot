import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  MUP_PENCE,
  checkCheckout,
  checkDiscount,
  checkProduct,
  filterCandidates,
  mupFloor,
  withinLicensedHours,
  type CandidateProduct,
  type ComplianceContext,
} from "~/lib/brain/compliance";

const jur = new Map<string, { shippingEnabled: boolean; minimumAge: number }>([
  ["GB", { shippingEnabled: true, minimumAge: 18 }],
  ["DE", { shippingEnabled: false, minimumAge: 18 }],
  ["US", { shippingEnabled: false, minimumAge: 21 }],
]);
const ctx = (over: Partial<ComplianceContext> = {}): ComplianceContext => ({
  countryCode: "GB",
  jurisdictions: jur,
  ...over,
});
const p = (over: Partial<CandidateProduct> = {}): CandidateProduct => ({
  id: "gid://shopify/Product/1",
  title: "Test whisky",
  abv: new Prisma.Decimal("40"),
  volumeMl: 700,
  availableForSale: true,
  inventoryQuantity: 5,
  status: "ACTIVE",
  price: new Prisma.Decimal("25.00"),
  compareAtPrice: null,
  ...over,
});

describe("MUP floor", () => {
  it("sets a 700ml 40% whisky at £18.20 (Scottish Government example)", () => {
    expect(MUP_PENCE).toBe(65);
    expect(mupFloor(40, 700)).toBe(18.2);
  });
  it("scales with ABV and volume", () => {
    expect(mupFloor(37.5, 700)).toBeCloseTo(17.06, 2); // vodka/gin
    expect(mupFloor(40, 200)).toBeCloseTo(5.2, 2); // Quarter Bottle
  });
});

describe("per-product gate", () => {
  it("passes a stocked, in-floor UK product", () => {
    expect(checkProduct(p(), ctx())).toBeNull();
  });
  it("blocks sold-out or deleted products", () => {
    expect(checkProduct(p({ availableForSale: false }), ctx())).toBe("OUT_OF_STOCK");
    expect(checkProduct(p({ inventoryQuantity: 0 }), ctx())).toBe("OUT_OF_STOCK");
    expect(checkProduct(p({ status: "ARCHIVED" }), ctx())).toBe("NOT_ACTIVE");
  });
  it("blocks a miniature priced below MUP floor", () => {
    const mini = p({ volumeMl: 50, abv: 40, price: new Prisma.Decimal("1.00") });
    expect(checkProduct(mini, ctx())).toBe("MUP_FLOOR"); // floor = 0.65 × 40 × 0.05 = £1.30
    const ok = p({ volumeMl: 50, abv: 40, price: new Prisma.Decimal("1.30") });
    expect(checkProduct(ok, ctx())).toBeNull();
  });
  it("blocks shipping to a country that is not enabled", () => {
    expect(checkProduct(p(), ctx({ countryCode: "DE" }))).toBe("SHIP_BLOCKED");
  });
  it("blocks underage shoppers using the country's minimum age (US = 21)", () => {
    const usCtx = ctx({ countryCode: "US" });
    expect(checkProduct(p(), usCtx)).toBe("SHIP_BLOCKED"); // US off
    jur.set("US", { shippingEnabled: true, minimumAge: 21 });
    expect(checkProduct(p(), ctx({ countryCode: "US", shopperAge: 20 }))).toBe("AGE_BLOCKED");
    expect(checkProduct(p(), ctx({ countryCode: "US", shopperAge: 21 }))).toBeNull();
    jur.set("US", { shippingEnabled: false, minimumAge: 21 }); // restore
  });
});

describe("discount gate", () => {
  it("blocks multibuy / bundle regardless of price", () => {
    expect(checkDiscount({ product: p(), discountedPrice: 25, kind: "multibuy" })).toBe("MULTIBUY_BLOCKED");
    expect(checkDiscount({ product: p(), discountedPrice: 25, kind: "bundle" })).toBe("MULTIBUY_BLOCKED");
  });
  it("blocks a percentage discount that pushes below MUP", () => {
    expect(checkDiscount({ product: p(), discountedPrice: 18.0, kind: "percentage" })).toBe("MUP_FLOOR");
    expect(checkDiscount({ product: p(), discountedPrice: 18.2, kind: "percentage" })).toBeNull();
  });
});

describe("licensed hours (Europe/London)", () => {
  it("allows checkout at 15:00 UK time, blocks at 23:00 and 06:00", () => {
    // Build dates in Europe/London by using a known offset day in July (BST = UTC+1).
    const summerDate = (hour: number) => new Date(`2026-07-15T${String(hour - 1).padStart(2, "0")}:00:00Z`);
    expect(withinLicensedHours(summerDate(15))).toBe(true);
    expect(withinLicensedHours(summerDate(23))).toBe(false);
    expect(withinLicensedHours(summerDate(6))).toBe(false);
    expect(withinLicensedHours(summerDate(10))).toBe(true); // boundary (opens 10:00)
    expect(withinLicensedHours(summerDate(22))).toBe(false); // boundary (closes 22:00)
  });
  it("checkCheckout surfaces LICENSED_HOURS outside the window", () => {
    const closed = new Date("2026-07-15T22:30:00Z"); // 23:30 BST
    expect(checkCheckout(ctx({ now: closed }))).toBe("LICENSED_HOURS");
    const open = new Date("2026-07-15T14:00:00Z"); // 15:00 BST
    expect(checkCheckout(ctx({ now: open }))).toBeNull();
  });
});

describe("filterCandidates batches blocked items", () => {
  it("separates kept from blocked and keeps the reason", () => {
    const list = [
      p({ id: "gid://shopify/Product/a" }),
      p({ id: "gid://shopify/Product/b", availableForSale: false }),
      p({ id: "gid://shopify/Product/c", volumeMl: 50, price: new Prisma.Decimal("1.00") }),
    ];
    const r = filterCandidates(list, ctx());
    expect(r.kept.map((x) => x.id)).toEqual(["gid://shopify/Product/a"]);
    expect(r.blocked.map((x) => x.reason).sort()).toEqual(["MUP_FLOOR", "OUT_OF_STOCK"]);
  });
});
