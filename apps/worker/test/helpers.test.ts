import { describe, expect, it } from "vitest";
import {
  parseWebhookPayload,
  parseWebhookMeta,
  stageAllowed,
  asPersonOrOrgId,
  hasAutopilotPrefix
} from "../src/helpers.js";

// ---------------------------------------------------------------------------
// parseWebhookPayload
// ---------------------------------------------------------------------------
describe("parseWebhookPayload", () => {
  it("parses deal webhook from meta.object", () => {
    const result = parseWebhookPayload({
      meta: { object: "deal", action: "updated" },
      current: { id: 42 }
    });
    expect(result).toEqual({ type: "deal", id: 42, action: "updated" });
  });

  it("parses lead webhook from meta.object", () => {
    const result = parseWebhookPayload({
      meta: { object: "lead", action: "created" },
      current: { id: "abc-123" }
    });
    expect(result).toEqual({ type: "lead", id: "abc-123", action: "created" });
  });

  it("returns unknown for unrecognized payload", () => {
    const result = parseWebhookPayload({ foo: "bar" });
    expect(result.type).toBe("unknown");
  });

  it("returns unknown for non-object input", () => {
    expect(parseWebhookPayload(null).type).toBe("unknown");
    expect(parseWebhookPayload(undefined).type).toBe("unknown");
    expect(parseWebhookPayload("string").type).toBe("unknown");
  });

  it("handles numeric deal id passed as string", () => {
    const result = parseWebhookPayload({
      meta: { object: "deal" },
      current: { id: "99" }
    });
    expect(result).toEqual({ type: "deal", id: 99, action: "" });
  });
});

// ---------------------------------------------------------------------------
// parseWebhookMeta
// ---------------------------------------------------------------------------
describe("parseWebhookMeta", () => {
  it("extracts user id and bulk flag", () => {
    const result = parseWebhookMeta({
      meta: { user_id: 77, is_bulk_update: true }
    });

    expect(result).toEqual({ userId: 77, isBulkUpdate: true });
  });

  it("returns defaults for missing meta", () => {
    expect(parseWebhookMeta({})).toEqual({ userId: undefined, isBulkUpdate: false });
  });
});

// ---------------------------------------------------------------------------
// stageAllowed
// ---------------------------------------------------------------------------
describe("stageAllowed", () => {
  it("returns true when no active stage IDs configured", () => {
    expect(stageAllowed(undefined, 5)).toBe(true);
    expect(stageAllowed([], 5)).toBe(true);
  });

  it("returns true when stage is in the allowed list", () => {
    expect(stageAllowed([1, 2, 3], 2)).toBe(true);
  });

  it("returns false when stage is not in the allowed list", () => {
    expect(stageAllowed([1, 2, 3], 9)).toBe(false);
  });

  it("returns false when stageId is not a number", () => {
    expect(stageAllowed([1, 2], "2")).toBe(false);
    expect(stageAllowed([1], undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// asPersonOrOrgId
// ---------------------------------------------------------------------------
describe("asPersonOrOrgId", () => {
  it("returns number directly", () => {
    expect(asPersonOrOrgId(42)).toBe(42);
  });

  it("extracts value from object (Pipedrive nested id format)", () => {
    expect(asPersonOrOrgId({ value: 7 })).toBe(7);
  });

  it("returns undefined for non-numeric values", () => {
    expect(asPersonOrOrgId("abc")).toBeUndefined();
    expect(asPersonOrOrgId(null)).toBeUndefined();
    expect(asPersonOrOrgId(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// hasAutopilotPrefix
// ---------------------------------------------------------------------------
describe("hasAutopilotPrefix", () => {
  it("detects autopilot prefix in content", () => {
    expect(hasAutopilotPrefix("[AUTOPILOT] Follow-up created")).toBe(true);
  });

  it("returns false for regular content", () => {
    expect(hasAutopilotPrefix("Just a normal note")).toBe(false);
  });

  it("returns false for null/undefined/empty", () => {
    expect(hasAutopilotPrefix(null)).toBe(false);
    expect(hasAutopilotPrefix(undefined)).toBe(false);
    expect(hasAutopilotPrefix("")).toBe(false);
  });
});
