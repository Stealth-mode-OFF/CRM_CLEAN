import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  dateToYyyyMmDd,
  dayKey,
  toUtcDate,
  activityDueAtUtc,
  hasFutureActivity,
  hasActivityWithinDays
} from "../src/time.js";

// ---------------------------------------------------------------------------
// addBusinessDays
// ---------------------------------------------------------------------------
describe("addBusinessDays", () => {
  it("adds days skipping weekends (Mon + 3 → Thu)", () => {
    // 2026-02-16 is a Monday
    const monday = new Date("2026-02-16T10:00:00Z");
    const result = addBusinessDays(monday, 3);
    expect(result.getUTCDay()).toBe(4); // Thursday
    expect(dateToYyyyMmDd(result)).toBe("2026-02-19");
  });

  it("rolls across a weekend (Thu + 2 → Mon)", () => {
    // 2026-02-19 is a Thursday
    const thursday = new Date("2026-02-19T10:00:00Z");
    const result = addBusinessDays(thursday, 2);
    expect(result.getUTCDay()).toBe(1); // Monday
    expect(dateToYyyyMmDd(result)).toBe("2026-02-23");
  });

  it("adds 0 business days → same date", () => {
    const date = new Date("2026-02-18T12:00:00Z");
    expect(dateToYyyyMmDd(addBusinessDays(date, 0))).toBe("2026-02-18");
  });

  it("starts on Saturday, skips entire weekend", () => {
    const saturday = new Date("2026-02-21T08:00:00Z");
    const result = addBusinessDays(saturday, 1);
    expect(result.getUTCDay()).toBe(1); // Monday
    expect(dateToYyyyMmDd(result)).toBe("2026-02-23");
  });

  it("starts on Sunday, skips rest of weekend", () => {
    const sunday = new Date("2026-02-22T08:00:00Z");
    const result = addBusinessDays(sunday, 1);
    expect(result.getUTCDay()).toBe(1); // Monday
    expect(dateToYyyyMmDd(result)).toBe("2026-02-23");
  });

  it("handles a full 5-business-day (one week) span", () => {
    const monday = new Date("2026-02-16T09:00:00Z");
    const result = addBusinessDays(monday, 5);
    expect(dateToYyyyMmDd(result)).toBe("2026-02-23"); // next Monday
  });

  it("handles 10 business days (two working weeks)", () => {
    const monday = new Date("2026-02-16T09:00:00Z");
    const result = addBusinessDays(monday, 10);
    expect(dateToYyyyMmDd(result)).toBe("2026-03-02");
  });
});

// ---------------------------------------------------------------------------
// dateToYyyyMmDd
// ---------------------------------------------------------------------------
describe("dateToYyyyMmDd", () => {
  it("formats correctly", () => {
    expect(dateToYyyyMmDd(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
  });

  it("zero-pads single-digit month and day", () => {
    expect(dateToYyyyMmDd(new Date("2026-03-02T00:00:00Z"))).toBe("2026-03-02");
  });
});

// ---------------------------------------------------------------------------
// dayKey
// ---------------------------------------------------------------------------
describe("dayKey", () => {
  it("returns YYYY-MM-DD for supplied date", () => {
    expect(dayKey(new Date("2026-02-18T14:30:00Z"))).toBe("2026-02-18");
  });

  it("defaults to today when no date given", () => {
    const today = dateToYyyyMmDd(new Date());
    expect(dayKey()).toBe(today);
  });
});

// ---------------------------------------------------------------------------
// toUtcDate
// ---------------------------------------------------------------------------
describe("toUtcDate", () => {
  it("converts string to Date", () => {
    const result = toUtcDate("2026-02-18T10:00:00.000Z");
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2026-02-18T10:00:00.000Z");
  });

  it("normalises an existing Date through toISOString round-trip", () => {
    const input = new Date("2026-02-18T10:00:00Z");
    const result = toUtcDate(input);
    expect(result.toISOString()).toBe(input.toISOString());
  });
});

// ---------------------------------------------------------------------------
// activityDueAtUtc
// ---------------------------------------------------------------------------
describe("activityDueAtUtc", () => {
  it("returns null when due_date is missing", () => {
    expect(activityDueAtUtc({})).toBeNull();
    expect(activityDueAtUtc({ due_date: null })).toBeNull();
  });

  it("parses date + time", () => {
    const result = activityDueAtUtc({ due_date: "2026-02-20", due_time: "14:30" });
    expect(result?.toISOString()).toBe("2026-02-20T14:30:00.000Z");
  });

  it("defaults time to 23:59 when due_time is missing", () => {
    const result = activityDueAtUtc({ due_date: "2026-02-20" });
    expect(result?.toISOString()).toBe("2026-02-20T23:59:00.000Z");
  });

  it("returns null for invalid date string", () => {
    expect(activityDueAtUtc({ due_date: "not-a-date" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// hasFutureActivity
// ---------------------------------------------------------------------------
describe("hasFutureActivity", () => {
  const now = new Date("2026-02-18T12:00:00Z");

  it("returns true when an undone activity is in the future", () => {
    const activities = [{ due_date: "2026-02-20", due_time: "10:00", done: false }];
    expect(hasFutureActivity(activities, now)).toBe(true);
  });

  it("returns false when activity is done", () => {
    const activities = [{ due_date: "2026-02-20", due_time: "10:00", done: true }];
    expect(hasFutureActivity(activities, now)).toBe(false);
  });

  it("returns false when activity is in the past", () => {
    const activities = [{ due_date: "2026-02-17", due_time: "10:00", done: false }];
    expect(hasFutureActivity(activities, now)).toBe(false);
  });

  it("returns false for empty list", () => {
    expect(hasFutureActivity([], now)).toBe(false);
  });

  it("returns true if any one activity qualifies among a mix", () => {
    const activities = [
      { due_date: "2026-02-15", due_time: "08:00", done: false }, // past
      { due_date: "2026-02-20", due_time: "10:00", done: true },  // done
      { due_date: "2026-02-25", due_time: "14:00", done: false }  // ← qualifies
    ];
    expect(hasFutureActivity(activities, now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasActivityWithinDays
// ---------------------------------------------------------------------------
describe("hasActivityWithinDays", () => {
  const now = new Date("2026-02-18T12:00:00Z"); // Wednesday

  it("returns true when activity falls within business-day window", () => {
    // 2 business days from Wed → Fri 2026-02-20
    const activities = [{ due_date: "2026-02-20", due_time: "10:00", done: false }];
    expect(hasActivityWithinDays(activities, 2, now)).toBe(true);
  });

  it("returns false when activity is in the past", () => {
    const activities = [{ due_date: "2026-02-16", due_time: "10:00", done: false }];
    expect(hasActivityWithinDays(activities, 3, now)).toBe(false);
  });

  it("returns false when activity is done", () => {
    const activities = [{ due_date: "2026-02-20", due_time: "10:00", done: true }];
    expect(hasActivityWithinDays(activities, 3, now)).toBe(false);
  });

  it("returns false when activity is beyond the window", () => {
    // 3 business days from Wed → Mon 2026-02-23, upper bound adds 1 day → Tue 2026-02-24
    const activities = [{ due_date: "2026-03-10", due_time: "10:00", done: false }];
    expect(hasActivityWithinDays(activities, 3, now)).toBe(false);
  });

  it("returns false for empty list", () => {
    expect(hasActivityWithinDays([], 5, now)).toBe(false);
  });
});
