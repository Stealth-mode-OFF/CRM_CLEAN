import { describe, expect, it } from "vitest";
import { stableHash, stableStringify } from "../src/hash.js";
import { dayKey } from "../src/time.js";

describe("stable hashing", () => {
  it("produces same hash for different key order", () => {
    const a = { x: 1, nested: { b: 2, a: 1 } };
    const b = { nested: { a: 1, b: 2 }, x: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(stableHash(a)).toBe(stableHash(b));
  });

  it("formats day key in UTC yyyy-mm-dd", () => {
    expect(dayKey(new Date("2026-01-02T03:04:05.000Z"))).toBe("2026-01-02");
  });
});
