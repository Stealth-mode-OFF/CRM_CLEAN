import { describe, expect, it } from "vitest";
import { addBusinessDays, dateToYyyyMmDd } from "../src/time.js";

describe("addBusinessDays", () => {
  it("skips weekends", () => {
    const friday = new Date("2026-02-20T10:00:00.000Z");
    const plusTwo = addBusinessDays(friday, 2);
    expect(dateToYyyyMmDd(plusTwo)).toBe("2026-02-24");
  });
});
