import { describe, expect, it } from "vitest";
import { buildPipedrivePath, buildPipedriveUrl } from "../src/deep-link.js";

describe("buildPipedrivePath", () => {
  it("builds a deal path", () => {
    expect(buildPipedrivePath("deal", 123)).toBe("/deal/123");
  });

  it("builds a lead path", () => {
    expect(buildPipedrivePath("lead", "lead-1")).toBe("/leads/inbox/lead-1");
  });

  it("builds an activity path with user", () => {
    expect(buildPipedrivePath("activity", 44, { userId: 7 })).toBe("/activities/list/user/7/44");
  });
});

describe("buildPipedriveUrl", () => {
  it("defaults to app.pipedrive.com", () => {
    expect(buildPipedriveUrl("deal", 10)).toBe("https://app.pipedrive.com/deal/10");
  });

  it("uses workspace subdomain", () => {
    expect(buildPipedriveUrl("lead", "abc", "mycompany")).toBe(
      "https://mycompany.pipedrive.com/leads/inbox/abc"
    );
  });
});
