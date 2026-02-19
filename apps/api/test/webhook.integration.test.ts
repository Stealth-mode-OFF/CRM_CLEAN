import { beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { logger, type AppEnv, JOB_NAMES } from "@autopilot/shared";
import { createServer } from "../src/server.js";
import { processWebhookEventJob } from "../../worker/src/jobs/autopilot.js";

class InMemoryPrisma {
  webhookEvents = new Map<string, { eventHash: string; payloadJson: Prisma.JsonValue; status: string; processedAt?: Date | null }>();
  idempotency = new Map<string, { id: string; scope: string; key: string; requestHash: string; status: string }>();
  audits: Array<{ action: string; entityType: string; entityId: string; source: string; afterJson?: Prisma.JsonValue }> = [];

  webhookEvent = {
    create: async ({ data }: any) => {
      if (this.webhookEvents.has(data.eventHash)) {
        const err = new Error("Unique") as Error & { code?: string };
        err.code = "P2002";
        throw err;
      }
      this.webhookEvents.set(data.eventHash, {
        eventHash: data.eventHash,
        payloadJson: data.payloadJson,
        status: data.status,
        processedAt: null
      });
      return data;
    },
    findUnique: async ({ where }: any) => this.webhookEvents.get(where.eventHash) ?? null,
    update: async ({ where, data }: any) => {
      const row = this.webhookEvents.get(where.eventHash);
      if (!row) {
        return null;
      }
      const updated = { ...row, ...data };
      this.webhookEvents.set(where.eventHash, updated);
      return updated;
    }
  };

  idempotencyKey = {
    create: async ({ data }: any) => {
      const mapKey = `${data.scope}:${data.key}`;
      if (this.idempotency.has(mapKey)) {
        throw new Error("exists");
      }
      const row = {
        id: mapKey,
        scope: data.scope,
        key: data.key,
        requestHash: data.requestHash,
        status: data.status
      };
      this.idempotency.set(mapKey, row);
      return row;
    },
    findUnique: async ({ where }: any) => {
      const mapKey = `${where.scope_key.scope}:${where.scope_key.key}`;
      return this.idempotency.get(mapKey) ?? null;
    },
    update: async ({ where, data }: any) => {
      const mapKey = `${where.scope_key.scope}:${where.scope_key.key}`;
      const existing = this.idempotency.get(mapKey);
      if (!existing) {
        throw new Error("missing");
      }
      const updated = { ...existing, ...data };
      this.idempotency.set(mapKey, updated);
      return updated;
    }
  };

  auditLog = {
    create: async ({ data }: any) => {
      this.audits.push(data);
      return data;
    }
  };

  reviewQueue = {
    findMany: async () => [],
    findUnique: async () => null,
    update: async () => null
  };

  mergeCandidate = {
    findUnique: async () => null,
    update: async () => null
  };

  dealSnapshot = {
    create: async () => null
  };

  fieldMap = {
    upsert: async () => null
  };

  jobRun = {
    create: async () => ({ id: "jr-1" }),
    update: async () => null
  };

  $queryRaw = async () => [{ ok: 1 }];
}

function createFakePipedrive() {
  return {
    deals: {
      get: async () => ({ id: 123, status: "open", stage_id: 1 }),
      list: async () => []
    },
    leads: {
      get: async () => ({ id: "lead-1" }),
      list: async () => []
    },
    activities: {
      list: async () => [],
      create: async () => ({ id: 999 })
    },
    notes: {
      list: async () => [],
      create: async () => ({ id: 555 })
    },
    persons: {
      get: async () => ({ id: 1, email: [] })
    },
    orgs: {
      get: async () => ({ id: 1 })
    },
    fields: {
      list: async () => []
    }
  };
}

describe("webhook integration dry-run", () => {
  let prisma: InMemoryPrisma;

  const env: AppEnv = {
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
    leadSweepCron: "0 5 * * *",
    activeStageIds: [1]
  };

  beforeEach(() => {
    prisma = new InMemoryPrisma();
  });

  it("accepts webhook, enqueues processing, and writes dry-run SLA audit", async () => {
    const pipedrive = createFakePipedrive();

    const queue = {
      add: async (name: string, data: any) => {
        if (name === JOB_NAMES.processWebhookEvent) {
          await processWebhookEventJob(
            {
              env,
              prisma: prisma as any,
              pipedrive: pipedrive as any,
              logger
            },
            data.eventHash
          );
        }
      },
      getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 })
    };

    const app = await createServer({
      env,
      prisma: prisma as any,
      queue: queue as any,
      pipedrive: pipedrive as any,
      logger
    });

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/pipedrive",
      headers: {
        "x-autopilot-token": "secret"
      },
      payload: {
        meta: { object: "deal", action: "updated" },
        current: { id: 123 }
      }
    });

    expect(response.statusCode).toBe(202);
    const slaAudit = prisma.audits.find((entry) => entry.action === "sla_enforce");
    expect(slaAudit).toBeTruthy();
    expect((slaAudit?.afterJson as any).dryRun).toBe(true);

    await app.close();
  });
});
