import { Prisma } from "@prisma/client";
import {
  AUTOPILOT_PREFIX,
  JOB_NAMES,
  acquireIdempotencyKey,
  addBusinessDays,
  dateToYyyyMmDd,
  dayKey,
  hasActivityWithinDays,
  hasFutureActivity,
  markIdempotencyStatus
} from "@autopilot/shared";
import type { Job } from "bullmq";
import type { PipedriveActivity, PipedriveDeal } from "@autopilot/pipedrive";
import type { SweepStats, WorkerDeps } from "../types.js";
import {
  asPersonOrOrgId,
  hasAutopilotPrefix,
  parseWebhookPayload,
  stageAllowed
} from "../helpers.js";

const AUTOPILOT_ECHO_WINDOW_MINUTES = 10;

async function writeAudit(
  deps: WorkerDeps,
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

async function isRecentAutopilotTouch(
  deps: WorkerDeps,
  entity: { dealId?: number; leadId?: string }
): Promise<boolean> {
  const since = Date.now() - AUTOPILOT_ECHO_WINDOW_MINUTES * 60 * 1000;

  const notes = await deps.pipedrive.notes.list({
    deal_id: entity.dealId,
    lead_id: entity.leadId,
    limit: 20,
    sort: "add_time DESC"
  });

  for (const note of notes) {
    if (!hasAutopilotPrefix(note.content)) {
      continue;
    }
    const addTime = note.add_time ? Date.parse(note.add_time) : 0;
    if (addTime >= since) {
      return true;
    }
  }

  return false;
}

function isOpenDeal(deal: PipedriveDeal, activeStageIds?: number[]): boolean {
  const isOpen = deal.status === "open" || !deal.status;
  if (!isOpen) {
    return false;
  }

  return stageAllowed(activeStageIds, deal.stage_id);
}

async function maybeCreateActivityAndNote(
  deps: WorkerDeps,
  input: {
    source: "webhook" | "nightly" | "manual";
    entityType: "deal" | "lead";
    entityId: string;
    subject: string;
    dueDate: string;
    dealId?: number;
    leadId?: string;
    noteText: string;
    action: "sla_enforce" | "lead_triage";
    beforeJson: unknown;
  }
): Promise<{ createdActivityId?: number; dryRun: boolean }> {
  if (deps.env.dryRun) {
    await writeAudit(deps, {
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      source: input.source,
      beforeJson: input.beforeJson,
      afterJson: {
        dryRun: true,
        wouldCreate: {
          subject: input.subject,
          dueDate: input.dueDate,
          noteText: input.noteText,
          dealId: input.dealId,
          leadId: input.leadId
        }
      }
    });

    return { dryRun: true };
  }

  const activity = await deps.pipedrive.activities.create({
    subject: `${AUTOPILOT_PREFIX} ${input.subject}`,
    due_date: input.dueDate,
    type: "task",
    deal_id: input.dealId,
    lead_id: input.leadId
  });

  await deps.pipedrive.notes.create({
    deal_id: input.dealId,
    lead_id: input.leadId,
    content: `${AUTOPILOT_PREFIX} ${input.noteText}`
  });

  await writeAudit(deps, {
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    source: input.source,
    beforeJson: input.beforeJson,
    afterJson: {
      dryRun: false,
      createdActivityId: activity.id,
      dueDate: input.dueDate
    }
  });

  return { createdActivityId: activity.id, dryRun: false };
}

export async function processWebhookEventJob(
  deps: WorkerDeps,
  eventHash: string
): Promise<void> {
  const event = await deps.prisma.webhookEvent.findUnique({ where: { eventHash } });
  if (!event) {
    deps.logger.warn({ eventHash }, "WebhookEvent not found");
    return;
  }

  if (event.status === "processed") {
    return;
  }

  try {
    const parsed = parseWebhookPayload(event.payloadJson);

    if (parsed.type === "deal") {
      if (await isRecentAutopilotTouch(deps, { dealId: parsed.id })) {
        deps.logger.info({ dealId: parsed.id }, "Skipping deal webhook echo from autopilot touch");
      } else {
        await slaDealEnforceJob(deps, parsed.id, "webhook");
      }
    }

    if (parsed.type === "lead") {
      if (await isRecentAutopilotTouch(deps, { leadId: parsed.id })) {
        deps.logger.info({ leadId: parsed.id }, "Skipping lead webhook echo from autopilot touch");
      } else {
        await leadTriageEnforceJob(deps, parsed.id, "webhook");
      }
    }

    await deps.prisma.webhookEvent.update({
      where: { eventHash },
      data: {
        status: "processed",
        processedAt: new Date()
      }
    });
  } catch (error) {
    await deps.prisma.webhookEvent.update({
      where: { eventHash },
      data: {
        status: "failed",
        processedAt: new Date()
      }
    });
    throw error;
  }
}

export async function slaDealEnforceJob(
  deps: WorkerDeps,
  dealId: number,
  source: "webhook" | "nightly" | "manual"
): Promise<{ created: boolean; skipped: boolean }> {
  const key = `${dealId}:${dayKey()}`;
  const scope = `job:${JOB_NAMES.slaDealEnforce}`;

  const idempotency = await acquireIdempotencyKey(deps.prisma, scope, key, { dealId, source });
  if (!idempotency.acquired) {
    return { created: false, skipped: true };
  }

  try {
    const deal = await deps.pipedrive.deals.get(dealId);
    if (!isOpenDeal(deal, deps.env.activeStageIds)) {
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: false, skipped: true };
    }

    const activities = await deps.pipedrive.activities.list({
      deal_id: dealId,
      done: 0,
      limit: 100
    });

    if (hasFutureActivity(activities)) {
      await writeAudit(deps, {
        entityType: "deal",
        entityId: String(dealId),
        action: "sla_enforce",
        source,
        beforeJson: { futureActivityExists: true },
        afterJson: { skipped: true }
      });
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: false, skipped: true };
    }

    const dueDate = dateToYyyyMmDd(addBusinessDays(new Date(), 2));
    const result = await maybeCreateActivityAndNote(deps, {
      source,
      entityType: "deal",
      entityId: String(dealId),
      subject: "Follow-up",
      dueDate,
      dealId,
      noteText: "No future activity found for open deal. Added follow-up task.",
      action: "sla_enforce",
      beforeJson: {
        deal,
        activitiesChecked: activities.length
      }
    });

    await markIdempotencyStatus(deps.prisma, scope, key, "done");
    return { created: Boolean(result.createdActivityId) || result.dryRun, skipped: false };
  } catch (error) {
    await markIdempotencyStatus(deps.prisma, scope, key, "failed");
    throw error;
  }
}

function extractOrgDomain(org: Record<string, unknown> | null): string | null {
  if (!org) {
    return null;
  }

  const knownKeys = ["website", "domain", "web"]; 
  for (const key of knownKeys) {
    const value = org[key];
    if (typeof value === "string" && value.includes(".")) {
      return value;
    }
  }

  return null;
}

function extractPersonEmail(person: { email?: Array<{ value?: string }> } | null): string | null {
  if (!person || !Array.isArray(person.email)) {
    return null;
  }
  for (const row of person.email) {
    if (row.value && row.value.includes("@")) {
      return row.value;
    }
  }
  return null;
}

export async function leadTriageEnforceJob(
  deps: WorkerDeps,
  leadId: string,
  source: "webhook" | "nightly" | "manual"
): Promise<{ created: boolean; skipped: boolean }> {
  const key = `${leadId}:${dayKey()}`;
  const scope = `job:${JOB_NAMES.leadTriageEnforce}`;

  const idempotency = await acquireIdempotencyKey(deps.prisma, scope, key, { leadId, source });
  if (!idempotency.acquired) {
    return { created: false, skipped: true };
  }

  try {
    const lead = await deps.pipedrive.leads.get(leadId);
    const personId = asPersonOrOrgId(lead.person_id);
    const orgId = asPersonOrOrgId(lead.organization_id);

    const person = personId ? await deps.pipedrive.persons.get(personId) : null;
    const org = orgId ? await deps.pipedrive.orgs.get(orgId) : null;

    const email = extractPersonEmail(person);
    const orgDomain = extractOrgDomain((org ?? null) as Record<string, unknown> | null);
    const missingSignals = !email && !orgDomain && !personId;

    const activities = await deps.pipedrive.activities.list({
      lead_id: leadId,
      done: 0,
      limit: 100
    });

    const hasQualActivitySoon = hasActivityWithinDays(
      activities,
      deps.env.slaFutureActivityDays,
      new Date()
    );

    if (!missingSignals && hasQualActivitySoon) {
      await writeAudit(deps, {
        entityType: "lead",
        entityId: leadId,
        action: "lead_triage",
        source,
        beforeJson: {
          missingSignals,
          hasQualActivitySoon
        },
        afterJson: { skipped: true }
      });
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: false, skipped: true };
    }

    const dueDate = dateToYyyyMmDd(addBusinessDays(new Date(), 2));
    const noteText = missingSignals
      ? "Missing key lead info (email/person/org domain). Added qualification activity."
      : "No qualification activity in SLA window. Added qualification activity.";

    const result = await maybeCreateActivityAndNote(deps, {
      source,
      entityType: "lead",
      entityId: leadId,
      subject: "Lead qualification",
      dueDate,
      leadId,
      noteText,
      action: "lead_triage",
      beforeJson: {
        lead,
        missingSignals,
        hasQualActivitySoon,
        personId,
        orgId,
        email,
        orgDomain
      }
    });

    await markIdempotencyStatus(deps.prisma, scope, key, "done");
    return { created: Boolean(result.createdActivityId) || result.dryRun, skipped: false };
  } catch (error) {
    await markIdempotencyStatus(deps.prisma, scope, key, "failed");
    throw error;
  }
}

export async function slaSweepJob(deps: WorkerDeps, source: "nightly" | "manual"): Promise<SweepStats> {
  const started = await deps.prisma.jobRun.create({
    data: {
      jobName: JOB_NAMES.slaSweep,
      status: "running"
    }
  });

  const stats: SweepStats = {
    processed: 0,
    createdActivities: 0,
    skipped: 0,
    errors: 0
  };

  try {
    const deals = await deps.pipedrive.deals.list({
      status: "open",
      pipeline_id: deps.env.pipelineId
    });

    for (const deal of deals) {
      if (!isOpenDeal(deal, deps.env.activeStageIds)) {
        continue;
      }

      stats.processed += 1;

      try {
        const result = await slaDealEnforceJob(deps, deal.id, source);
        if (result.created) {
          stats.createdActivities += 1;
        }
        if (result.skipped) {
          stats.skipped += 1;
        }
      } catch (error) {
        stats.errors += 1;
        deps.logger.error(
          { dealId: deal.id, error: error instanceof Error ? error.message : String(error) },
          "slaSweep deal failed"
        );
      }
    }

    await deps.prisma.jobRun.update({
      where: { id: started.id },
      data: {
        status: "success",
        finishedAt: new Date(),
        statsJson: stats as Prisma.InputJsonValue
      }
    });

    return stats;
  } catch (error) {
    await deps.prisma.jobRun.update({
      where: { id: started.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
        statsJson: {
          ...stats,
          error: error instanceof Error ? error.message : String(error)
        } as Prisma.InputJsonValue
      }
    });
    throw error;
  }
}

export async function mergeReviewJob(deps: WorkerDeps, reviewQueueId: string): Promise<void> {
  // Merge automation intentionally deferred for safety; this keeps queue/event flow complete for MVP.
  await deps.prisma.auditLog.create({
    data: {
      entityType: "review_queue",
      entityId: reviewQueueId,
      action: "merge",
      source: "manual",
      beforeJson: Prisma.JsonNull,
      afterJson: {
        status: "approved",
        note: "Merge execution deferred in MVP."
      }
    }
  });
}

export async function dispatchJob(
  deps: WorkerDeps,
  job: Job
): Promise<void> {
  if (job.name === JOB_NAMES.processWebhookEvent) {
    await processWebhookEventJob(deps, String(job.data.eventHash));
    return;
  }

  if (job.name === JOB_NAMES.slaDealEnforce) {
    await slaDealEnforceJob(deps, Number(job.data.dealId), job.data.source ?? "manual");
    return;
  }

  if (job.name === JOB_NAMES.leadTriageEnforce) {
    if (job.data.sweep) {
      const leads = await deps.pipedrive.leads.list();
      for (const lead of leads) {
        await leadTriageEnforceJob(deps, lead.id, "manual");
      }
      return;
    }

    await leadTriageEnforceJob(deps, String(job.data.leadId), job.data.source ?? "manual");
    return;
  }

  if (job.name === JOB_NAMES.slaSweep) {
    await slaSweepJob(deps, job.data.source ?? "nightly");
    return;
  }

  if (job.name === JOB_NAMES.mergeReview) {
    await mergeReviewJob(deps, String(job.data.reviewQueueId));
    return;
  }

  throw new Error(`Unsupported job ${job.name}`);
}
