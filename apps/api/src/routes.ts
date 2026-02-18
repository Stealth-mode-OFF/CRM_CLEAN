import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { JOB_NAMES, stableHash } from "@autopilot/shared";
import type { ApiDeps } from "./types.js";

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

  app.post("/admin/jobs/run/:name", async (request, reply) => {
    const params = request.params as { name: string };
    if (params.name === JOB_NAMES.slaSweep) {
      await deps.queue.add(JOB_NAMES.slaSweep, { source: "manual", requestHash: stableHash(params) });
      return { ok: true, enqueued: JOB_NAMES.slaSweep };
    }

    if (params.name === "leadSweep") {
      await deps.queue.add(JOB_NAMES.leadTriageEnforce, {
        source: "manual",
        sweep: true,
        requestHash: stableHash(params)
      });
      return { ok: true, enqueued: JOB_NAMES.leadTriageEnforce };
    }

    reply.code(400);
    return { ok: false, error: "unsupported_job" };
  });
}
