import { describe, expect, it } from "vitest";
import { hasActivityWithinDays, hasFutureActivity } from "../src/time.js";

describe("future activity checks", () => {
  const now = new Date("2026-02-18T12:00:00.000Z");

  it("treats missing time as end-of-day UTC", () => {
    expect(
      hasFutureActivity(
        [
          {
            due_date: "2026-02-18",
            due_time: null,
            done: false
          }
        ],
        now
      )
    ).toBe(true);
  });

  it("detects activity inside business-day window", () => {
    const activities = [
      { due_date: "2026-02-19", due_time: "09:00", done: false },
      { due_date: "2026-02-25", due_time: "09:00", done: false }
    ];
    expect(hasActivityWithinDays(activities, 3, now)).toBe(true);
    expect(hasActivityWithinDays(activities, 1, now)).toBe(true);
  });
});
