import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { JOB_NAMES, stableHash } from "@autopilot/shared";
import type { PipedriveOrg, PipedrivePerson } from "@autopilot/pipedrive";
import type { ApiDeps } from "./types.js";
import { registerDashboardRoutes } from "./dashboard-routes.js";

async function refreshFieldMaps(deps: ApiDeps): Promise<{ upserted: number }> {
  const entityTypes = ["deal", "lead", "person", "org"] as const;
  let upserted = 0;

  for (const entityType of entityTypes) {
    const fields = await deps.pipedrive.fields.list(entityType);
    for (const field of fields) {
      await deps.prisma.fieldMap.upsert({
        where: {
          entityType_fieldKey: {
            entityType,
            fieldKey: field.key
          }
        },
        update: {
          name: field.name,
          fieldType: field.field_type ?? "unknown",
          optionsJson: field.options ?? Prisma.JsonNull
        },
        create: {
          entityType,
          fieldKey: field.key,
          name: field.name,
          fieldType: field.field_type ?? "unknown",
          optionsJson: field.options ?? Prisma.JsonNull
        }
      });
      upserted += 1;
    }
  }

  return { upserted };
}

function parseTimestamp(input?: string | null): number | null {
  if (!input) {
    return null;
  }
  const value = Date.parse(input);
  return Number.isNaN(value) ? null : value;
}

function isWithin24h(record: PipedrivePerson | PipedriveOrg): boolean {
  const timestamp = parseTimestamp(record.update_time ?? null) ?? parseTimestamp(record.add_time ?? null);
  if (timestamp === null) {
    return false;
  }
  return Date.now() - timestamp < 24 * 60 * 60 * 1000;
}

async function getEntityRecord(
  deps: ApiDeps,
  entityType: string,
  entityId: number
): Promise<PipedrivePerson | PipedriveOrg> {
  if (entityType === "person") {
    return deps.pipedrive.persons.get(entityId);
  }

  return deps.pipedrive.orgs.get(entityId);
}

async function getOpenDealsForEntity(
  deps: ApiDeps,
  entityType: string,
  entityId: number
): Promise<number> {
  const query = entityType === "person" ? { status: "open", person_id: entityId } : { status: "open", org_id: entityId };
  const deals = await deps.pipedrive.deals.list(query);
  return deals.length;
}

async function countTouches(
  deps: ApiDeps,
  entityType: string,
  entityId: number
): Promise<{ activities: number; notes: number }> {
  const query = entityType === "person" ? { person_id: entityId } : { org_id: entityId };
  const [activities, notes] = await Promise.all([
    deps.pipedrive.activities.list(query),
    deps.pipedrive.notes.list(query)
  ]);

  return {
    activities: activities.length,
    notes: notes.length
  };
}

async function writeAudit(
  deps: ApiDeps,
  input: {
    entityType: string;
    entityId: string;
    action: string;
    source: string;
    beforeJson?: unknown;
    afterJson?: unknown;
  }
): Promise<void> {
  await deps.prisma.auditLog.create({
    data: {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      source: input.source,
      beforeJson: (input.beforeJson as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      afterJson: (input.afterJson as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull
    }
  });
}

export async function registerRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.post("/webhooks/pipedrive", async (request, reply) => {
    const token = request.headers["x-autopilot-token"];
    if (token !== deps.env.webhookSecret) {
      reply.code(401);
      return { ok: false, error: "unauthorized" };
    }

    const payload = request.body;
    const eventHash = stableHash(payload);

    try {
      await deps.prisma.webhookEvent.create({
        data: {
          eventHash,
          payloadJson: payload as Prisma.InputJsonValue,
          status: "queued"
        }
      });
    } catch (error) {
      const isUniqueError =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
      if (isUniqueError) {
        return { ok: true, deduped: true, eventHash };
      }
      throw error;
    }

    await deps.queue.add(
      JOB_NAMES.processWebhookEvent,
      { eventHash },
      {
        jobId: eventHash
      }
    );

    reply.code(202);
    return { ok: true, eventHash };
  });

  app.post("/admin/fieldmap/refresh", async () => {
    const result = await refreshFieldMaps(deps);
    return { ok: true, ...result };
  });

  app.get("/admin/review-queue", async () => {
    const items = await deps.prisma.reviewQueue.findMany({
      where: { status: "open" },
      orderBy: { createdAt: "asc" }
    });
    return { ok: true, items };
  });

  app.post("/admin/review-queue/:id/approve", async (request, reply) => {
    const params = request.params as { id: string };
    const row = await deps.prisma.reviewQueue.findUnique({ where: { id: params.id } });
    if (!row) {
      reply.code(404);
      return { ok: false, error: "not_found" };
    }

    await deps.prisma.reviewQueue.update({
      where: { id: params.id },
      data: { status: "approved" }
    });

    await deps.queue.add(JOB_NAMES.mergeReview, { reviewQueueId: params.id });

    return { ok: true };
  });

  app.post("/admin/merge/:id/execute", async (request, reply) => {
    const params = request.params as { id: string };
    const candidate = await deps.prisma.mergeCandidate.findUnique({ where: { id: params.id } });
    if (!candidate) {
      reply.code(404);
      return { ok: false, error: "not_found" };
    }

    if (candidate.status === "executed") {
      return { ok: true, alreadyExecuted: true };
    }

    const [sourceEntity, targetEntity, openDeals, sourceTouches, targetTouches] = await Promise.all([
      getEntityRecord(deps, candidate.entityType, candidate.sourceId),
      getEntityRecord(deps, candidate.entityType, candidate.targetId),
      getOpenDealsForEntity(deps, candidate.entityType, candidate.sourceId),
      countTouches(deps, candidate.entityType, candidate.sourceId),
      countTouches(deps, candidate.entityType, candidate.targetId)
    ]);

    if (candidate.confidenceScore < deps.env.mergeConfidenceThreshold) {
      reply.code(400);
      return { ok: false, error: "confidence_threshold_not_met" };
    }

    if (openDeals > 0) {
      reply.code(409);
      return { ok: false, error: "source_has_open_deals", openDeals };
    }

    if (isWithin24h(sourceEntity) || isWithin24h(targetEntity)) {
      reply.code(409);
      return { ok: false, error: "cooldown_window_active" };
    }

    if (deps.env.dryRun) {
      await deps.prisma.mergeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "approved",
          reviewedAt: new Date()
        }
      });

      await writeAudit(deps, {
        entityType: candidate.entityType,
        entityId: String(candidate.sourceId),
        action: "merge_execute",
        source: "manual",
        beforeJson: {
          candidateId: candidate.id,
          sourceTouches,
          targetTouches
        },
        afterJson: {
          dryRun: true,
          planned: {
            sourceId: candidate.sourceId,
            targetId: candidate.targetId
          }
        }
      });

      return { ok: true, dryRun: true };
    }

    if (candidate.entityType === "person") {
      await deps.pipedrive.persons.merge(candidate.sourceId, candidate.targetId);
    } else {
      await deps.pipedrive.orgs.merge(candidate.sourceId, candidate.targetId);
    }

    const touchesAfter = await countTouches(deps, candidate.entityType, candidate.targetId);
    const expectedActivities = sourceTouches.activities + targetTouches.activities;
    const expectedNotes = sourceTouches.notes + targetTouches.notes;
    const activitiesPreserved = touchesAfter.activities >= expectedActivities;
    const notesPreserved = touchesAfter.notes >= expectedNotes;

    if (!activitiesPreserved || !notesPreserved) {
      await deps.prisma.mergeCandidate.update({
        where: { id: candidate.id },
        data: {
          status: "rejected",
          reviewedAt: new Date()
        }
      });

      await writeAudit(deps, {
        entityType: candidate.entityType,
        entityId: String(candidate.sourceId),
        action: "merge_execute",
        source: "manual",
        beforeJson: {
          candidateId: candidate.id,
          sourceTouches,
          targetTouches
        },
        afterJson: {
          dryRun: false,
          rejected: true,
          reason: "activity_preservation_failed",
          touchesAfter
        }
      });

      reply.code(409);
      return { ok: false, error: "activity_preservation_failed" };
    }

    await deps.prisma.mergeCandidate.update({
      where: { id: candidate.id },
      data: {
        status: "executed",
        reviewedAt: new Date(),
        executedAt: new Date()
      }
    });

    await writeAudit(deps, {
      entityType: candidate.entityType,
      entityId: String(candidate.sourceId),
      action: "merge_execute",
      source: "manual",
      beforeJson: {
        candidateId: candidate.id,
        sourceTouches,
        targetTouches
      },
      afterJson: {
        dryRun: false,
        executed: true,
        touchesAfter
      }
    });

    return { ok: true };
  });

  app.post("/admin/jobs/run/:name", async (request, reply) => {
    const params = request.params as { name: string };
    if (params.name === JOB_NAMES.slaSweep) {
      await deps.queue.add(JOB_NAMES.slaSweep, { source: "manual", requestHash: stableHash(params) });
      return { ok: true, enqueued: JOB_NAMES.slaSweep };
    }

    if (params.name === JOB_NAMES.leadSweep || params.name === "leadSweep") {
      await deps.queue.add(JOB_NAMES.leadSweep, {
        source: "manual",
        requestHash: stableHash(params)
      });
      return { ok: true, enqueued: JOB_NAMES.leadSweep };
    }

    if (params.name === JOB_NAMES.staleDealNudge) {
      await deps.queue.add(JOB_NAMES.staleDealNudge, {
        source: "manual",
        dealId: Number((request.body as { dealId?: number } | undefined)?.dealId),
        requestHash: stableHash(params)
      });
      return { ok: true, enqueued: JOB_NAMES.staleDealNudge };
    }

    reply.code(400);
    return { ok: false, error: "unsupported_job" };
  });

  await registerDashboardRoutes(app, deps);
}
