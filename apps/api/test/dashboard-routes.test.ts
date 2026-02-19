import { describe, expect, it } from "vitest";
import { logger, type AppEnv } from "@autopilot/shared";
import { createServer } from "../src/server.js";

function makeEnv(): AppEnv {
  return {
    pipedriveApiToken: "token",
    webhookSecret: "secret",
    databaseUrl: "postgresql://localhost:5432/test",
    redisUrl: "redis://localhost:6379",
    dryRun: true,
    defaultTimezone: "UTC",
    slaFutureActivityDays: 3,
    staleDays: 7,
    mergeConfidenceThreshold: 0.85,
    cadenceColdDays: 7,
    cadenceCoolingDays: 3,
    leadSweepCron: "0 5 * * *"
  };
}

function createMinimalPrisma() {
  return {
    webhookEvent: { create: async () => null, findUnique: async () => null, update: async () => null },
    idempotencyKey: { create: async () => null, findUnique: async () => null, update: async () => null },
    auditLog: { create: async () => null },
    reviewQueue: { findMany: async () => [], findUnique: async () => null, update: async () => null },
    mergeCandidate: { findUnique: async () => null, update: async () => null },
    fieldMap: { upsert: async () => null },
    dealSnapshot: { create: async () => null },
    jobRun: { create: async () => ({ id: "jr-1" }), update: async () => null },
    $queryRaw: async () => [{ ok: 1 }]
  };
}

describe("dashboard routes", () => {
  it("returns pipeline velocity payload", async () => {
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();

    const pipedrive = {
      deals: {
        list: async (query: Record<string, unknown>) => {
          if (query.status === "open") {
            return [
              { id: 1, stage_id: 10, stage_change_time: old, add_time: old, status: "open" },
              { id: 2, stage_id: 10, stage_change_time: recent, add_time: recent, status: "open" }
            ];
          }

          if (query.status === "won") {
            return [
              {
                id: 11,
                add_time: new Date(now - 12 * 24 * 60 * 60 * 1000).toISOString(),
                won_time: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
                value: 1000,
                status: "won"
              }
            ];
          }

          if (query.status === "lost") {
            return [
              {
                id: 12,
                add_time: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(),
                lost_time: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
                status: "lost"
              }
            ];
          }

          return [];
        }
      },
      leads: { list: async () => [] },
      activities: { list: async () => [] },
      notes: { list: async () => [] },
      persons: { get: async () => null },
      orgs: { get: async () => null },
      fields: { list: async () => [] }
    };

    const app = await createServer({
      env: makeEnv(),
      prisma: createMinimalPrisma() as any,
      queue: { add: async () => null, getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 }) } as any,
      pipedrive: pipedrive as any,
      logger
    });

    const response = await app.inject({ method: "GET", url: "/admin/dashboard/velocity" });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.staleDealIds).toContain(1);
    expect(body.conversionRate).toBe(0.5);

    await app.close();
  });

  it("returns leads sorted by score", async () => {
    const pipedrive = {
      deals: { list: async () => [] },
      leads: {
        list: async () => [
          { id: "l-low", title: "Low", label_ids: [] },
          { id: "l-high", title: "High", add_time: new Date().toISOString(), label_ids: ["x"], person_id: 7, organization_id: 9 }
        ]
      },
      activities: { list: async () => [] },
      notes: { list: async () => [] },
      persons: {
        get: async () => ({ id: 7, email: [{ value: "x@example.com" }], phone: [{ value: "+420111" }] })
      },
      orgs: {
        get: async () => ({ id: 9, domain: "example.com" })
      },
      fields: { list: async () => [] }
    };

    const app = await createServer({
      env: makeEnv(),
      prisma: createMinimalPrisma() as any,
      queue: { add: async () => null, getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 }) } as any,
      pipedrive: pipedrive as any,
      logger
    });

    const response = await app.inject({ method: "GET", url: "/admin/dashboard/leads" });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.leads[0].id).toBe("l-high");
    expect(body.leads[0].score).toBeGreaterThan(body.leads[1].score);

    await app.close();
  });
});
