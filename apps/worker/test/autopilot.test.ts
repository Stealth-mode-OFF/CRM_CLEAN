import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { logger, type AppEnv } from "@autopilot/shared";
import { processWebhookEventJob } from "../src/jobs/autopilot.js";

class InMemoryPrisma {
  webhookEvents = new Map<string, { eventHash: string; payloadJson: Prisma.JsonValue; status: string; processedAt?: Date | null }>();
  audits: Array<{ action: string; entityType: string; entityId: string; source: string; afterJson?: Prisma.JsonValue }> = [];

  webhookEvent = {
    findUnique: async ({ where }: any) => this.webhookEvents.get(where.eventHash) ?? null,
    update: async ({ where, data }: any) => {
      const current = this.webhookEvents.get(where.eventHash);
      if (!current) {
        return null;
      }

      const updated = { ...current, ...data };
      this.webhookEvents.set(where.eventHash, updated);
      return updated;
    }
  };

  auditLog = {
    create: async ({ data }: any) => {
      this.audits.push(data);
      return data;
    }
  };
}

const baseEnv: AppEnv = {
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

describe("processWebhookEventJob loop-protection", () => {
  it("short-circuits when webhook meta.user_id matches BOT_USER_ID", async () => {
    const prisma = new InMemoryPrisma();
    prisma.webhookEvents.set("hash-1", {
      eventHash: "hash-1",
      payloadJson: {
        meta: { object: "deal", action: "updated", user_id: 77 },
        current: { id: 123 }
      },
      status: "queued",
      processedAt: null
    });

    const pipedrive = {
      notes: {
        list: async () => {
          throw new Error("notes.list should not be called when BOT_USER_ID matches");
        }
      }
    };

    await processWebhookEventJob(
      {
        env: { ...baseEnv, botUserId: 77 },
        prisma: prisma as any,
        pipedrive: pipedrive as any,
        logger
      },
      "hash-1"
    );

    const event = prisma.webhookEvents.get("hash-1");
    expect(event?.status).toBe("processed");
    expect(prisma.audits.some((entry) => entry.action === "loop_protection_bot_user")).toBe(true);
  });

  it("skips bulk update events before echo detection", async () => {
    const prisma = new InMemoryPrisma();
    prisma.webhookEvents.set("hash-2", {
      eventHash: "hash-2",
      payloadJson: {
        meta: { object: "lead", action: "updated", is_bulk_update: true },
        current: { id: "lead-1" }
      },
      status: "queued",
      processedAt: null
    });

    const pipedrive = {
      notes: {
        list: async () => {
          throw new Error("notes.list should not be called for bulk update");
        }
      }
    };

    await processWebhookEventJob(
      {
        env: { ...baseEnv },
        prisma: prisma as any,
        pipedrive: pipedrive as any,
        logger
      },
      "hash-2"
    );

    const event = prisma.webhookEvents.get("hash-2");
    expect(event?.status).toBe("processed");
    expect(prisma.audits.some((entry) => entry.action === "skip_bulk_update")).toBe(true);
  });
});
