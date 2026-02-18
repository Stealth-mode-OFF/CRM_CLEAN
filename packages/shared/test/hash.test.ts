import { describe, expect, it } from "vitest";
import { stableHash, stableStringify } from "../src/hash.js";

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------
describe("stableStringify", () => {
  it("produces identical output regardless of key order", () => {
    const a = stableStringify({ z: 1, a: 2 });
    const b = stableStringify({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  it("handles nested objects with different key orders", () => {
    const a = stableStringify({ outer: { b: 1, a: 2 }, x: 0 });
    const b = stableStringify({ x: 0, outer: { a: 2, b: 1 } });
    expect(a).toBe(b);
  });

  it("handles arrays (preserves element order)", () => {
    const a = stableStringify([3, 1, 2]);
    const b = stableStringify([3, 1, 2]);
    expect(a).toBe(b);
  });

  it("different array orders produce different output", () => {
    const a = stableStringify([1, 2]);
    const b = stableStringify([2, 1]);
    expect(a).not.toBe(b);
  });

  it("handles primitives", () => {
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(true)).toBe("true");
  });

  it("handles empty objects and arrays", () => {
    expect(stableStringify({})).toBe("{}");
    expect(stableStringify([])).toBe("[]");
  });
});

// ---------------------------------------------------------------------------
// stableHash
// ---------------------------------------------------------------------------
describe("stableHash", () => {
  it("returns a 64-char hex string (sha256)", () => {
    const hash = stableHash({ test: true });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for same input", () => {
    const input = { foo: "bar", baz: [1, 2, 3] };
    expect(stableHash(input)).toBe(stableHash(input));
  });

  it("produces same hash for object with reordered keys", () => {
    const a = stableHash({ z: 1, a: 2 });
    const b = stableHash({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  it("produces different hashes for different data", () => {
    const a = stableHash({ x: 1 });
    const b = stableHash({ x: 2 });
    expect(a).not.toBe(b);
  });

  it("handles deeply nested structures", () => {
    const obj = { a: { b: { c: { d: [1, { e: "f" }] } } } };
    const hash = stableHash(obj);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stableHash(obj)).toBe(hash);
  });
});
