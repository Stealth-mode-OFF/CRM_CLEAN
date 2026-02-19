import { describe, expect, it } from "vitest";
import { scoreLead } from "../src/scoring.js";

describe("scoreLead", () => {
  it("returns 100 for a richly qualified lead", () => {
    const score = scoreLead(
      {
        add_time: new Date().toISOString(),
        label_ids: ["hot"]
      },
      {
        email: [{ value: "sales@example.com" }],
        phone: [{ value: "+420777123456" }]
      },
      {
        domain: "example.com"
      }
    );

    expect(score).toBe(100);
  });

  it("returns low score for missing signals", () => {
    const score = scoreLead(
      {
        add_time: "2020-01-01T00:00:00.000Z",
        label_ids: []
      },
      {
        email: []
      },
      null
    );

    expect(score).toBe(0);
  });

  it("adds points for org presence even without domain", () => {
    const score = scoreLead(
      {
        add_time: "2020-01-01T00:00:00.000Z"
      },
      null,
      {
        website: null
      }
    );

    expect(score).toBe(20);
  });
});
