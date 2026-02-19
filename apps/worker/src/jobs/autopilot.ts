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
import type {
  PipedriveActivity,
  PipedriveDeal,
  PipedriveOrg,
  PipedrivePerson
} from "@autopilot/pipedrive";
import type { SweepStats, WorkerDeps } from "../types.js";
import {
  asPersonOrOrgId,
  hasAutopilotPrefix,
  parseWebhookMeta,
  parseWebhookPayload,
  stageAllowed
} from "../helpers.js";

const AUTOPILOT_ECHO_WINDOW_MINUTES = 10;
const STALE_NOTE_WINDOW_DAYS = 7;
const MERGE_COOLDOWN_HOURS = 24;

type MergeEntityType = "person" | "org";

type MergeReviewInput = {
  entityType: MergeEntityType;
  sourceId: number;
  targetId: number;
  confidenceScore: number;
};

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

function parseTimestamp(input?: string | null): number | null {
  if (!input) {
    return null;
  }

  const value = Date.parse(input);
  return Number.isNaN(value) ? null : value;
}

function diffDays(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / (24 * 60 * 60 * 1000);
}

function latestDealTouchTimestamp(deal: PipedriveDeal): number | null {
  const candidates = [deal.stage_change_time, deal.update_time, deal.add_time].map(parseTimestamp);
  return candidates.find((value): value is number => typeof value === "number") ?? null;
}

function toNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function normalizeMergeEntityType(value: unknown): MergeEntityType | null {
  const candidate = String(value ?? "").toLowerCase();
  if (candidate.includes("person")) {
    return "person";
  }
  if (candidate.includes("org")) {
    return "org";
  }
  return null;
}

function parseMergeReviewPayload(payload: unknown): MergeReviewInput | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const entityType = normalizeMergeEntityType(value.entityType ?? value.type ?? value.objectType);
  const sourceId = toNumeric(value.sourceId ?? value.loserId ?? value.duplicateId);
  const targetId = toNumeric(value.targetId ?? value.winnerId ?? value.masterId);
  const confidenceScore =
    toNumeric(value.confidenceScore ?? value.confidence ?? value.score) ?? 0;

  if (!entityType || sourceId === null || targetId === null) {
    return null;
  }

  return {
    entityType,
    sourceId,
    targetId,
    confidenceScore
  };
}

async function setReviewQueueStatus(
  deps: WorkerDeps,
  reviewQueueId: string,
  status: string
): Promise<void> {
  await deps.prisma.reviewQueue.update({
    where: { id: reviewQueueId },
    data: { status }
  });
}

async function getEntityRecordForMerge(
  deps: WorkerDeps,
  entityType: MergeEntityType,
  id: number
): Promise<PipedrivePerson | PipedriveOrg> {
  if (entityType === "person") {
    return deps.pipedrive.persons.get(id);
  }

  return deps.pipedrive.orgs.get(id);
}

async function countEntityTouches(
  deps: WorkerDeps,
  entityType: MergeEntityType,
  id: number
): Promise<{ activities: number; notes: number }> {
  const query = entityType === "person" ? { person_id: id } : { org_id: id };
  const [activities, notes] = await Promise.all([
    deps.pipedrive.activities.list(query),
    deps.pipedrive.notes.list(query)
  ]);

  return {
    activities: activities.length,
    notes: notes.length
  };
}

async function getOpenDealsForEntity(
  deps: WorkerDeps,
  entityType: MergeEntityType,
  id: number
): Promise<PipedriveDeal[]> {
  const query = entityType === "person" ? { status: "open", person_id: id } : { status: "open", org_id: id };
  return deps.pipedrive.deals.list(query);
}

function isWithinCooldown(record: PipedrivePerson | PipedriveOrg, nowMs: number): boolean {
  const updateTs = parseTimestamp(record.update_time ?? null) ?? parseTimestamp(record.add_time ?? null);
  if (updateTs === null) {
    return false;
  }

  return nowMs - updateTs < MERGE_COOLDOWN_HOURS * 60 * 60 * 1000;
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

async function snapshotDeal(deps: WorkerDeps, deal: PipedriveDeal): Promise<void> {
  if (typeof deal.stage_id !== "number") {
    return;
  }

  await deps.prisma.dealSnapshot.create({
    data: {
      dealId: deal.id,
      stageId: deal.stage_id,
      pipelineId: deal.pipeline_id,
      value: typeof deal.value === "number" ? deal.value : null
    }
  });
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
    const meta = parseWebhookMeta(event.payloadJson);

    if (typeof deps.env.botUserId === "number" && meta.userId === deps.env.botUserId) {
      await writeAudit(deps, {
        entityType: parsed.type,
        entityId: parsed.type === "unknown" ? "unknown" : String(parsed.id),
        action: "loop_protection_bot_user",
        source: "webhook",
        beforeJson: {
          userId: meta.userId,
          botUserId: deps.env.botUserId
        },
        afterJson: { skipped: true }
      });

      await deps.prisma.webhookEvent.update({
        where: { eventHash },
        data: {
          status: "processed",
          processedAt: new Date()
        }
      });
      return;
    }

    if (meta.isBulkUpdate) {
      await writeAudit(deps, {
        entityType: parsed.type,
        entityId: parsed.type === "unknown" ? "unknown" : String(parsed.id),
        action: "skip_bulk_update",
        source: "webhook",
        beforeJson: {
          isBulkUpdate: true
        },
        afterJson: { skipped: true }
      });

      await deps.prisma.webhookEvent.update({
        where: { eventHash },
        data: {
          status: "processed",
          processedAt: new Date()
        }
      });
      return;
    }

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

export async function staleDealNudgeJob(
  deps: WorkerDeps,
  dealId: number,
  source: "nightly" | "manual"
): Promise<{ created: boolean; skipped: boolean }> {
  const key = `${dealId}:${dayKey()}`;
  const scope = `job:${JOB_NAMES.staleDealNudge}`;

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

    const touchTs = latestDealTouchTimestamp(deal);
    if (touchTs === null) {
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: false, skipped: true };
    }

    const age = diffDays(touchTs, Date.now());
    if (age <= deps.env.staleDays) {
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: false, skipped: true };
    }

    const recentWindow = Date.now() - STALE_NOTE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const notes = await deps.pipedrive.notes.list({
      deal_id: dealId,
      limit: 25,
      sort: "add_time DESC"
    });

    const hasRecentStaleNudge = notes.some((note) => {
      if (!note.content || !note.content.includes("Stale deal")) {
        return false;
      }
      if (!hasAutopilotPrefix(note.content)) {
        return false;
      }
      const timestamp = parseTimestamp(note.add_time);
      return typeof timestamp === "number" && timestamp >= recentWindow;
    });

    if (hasRecentStaleNudge) {
      await writeAudit(deps, {
        entityType: "deal",
        entityId: String(dealId),
        action: "stale_deal_nudge",
        source,
        beforeJson: { dealId, ageDays: age },
        afterJson: { skipped: true, reason: "recent_nudge_exists" }
      });
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: false, skipped: true };
    }

    const content = `${AUTOPILOT_PREFIX} Stale deal - consider advancing or closing`;
    if (deps.env.dryRun) {
      await writeAudit(deps, {
        entityType: "deal",
        entityId: String(dealId),
        action: "stale_deal_nudge",
        source,
        beforeJson: { dealId, ageDays: age },
        afterJson: { dryRun: true, content }
      });
      await markIdempotencyStatus(deps.prisma, scope, key, "done");
      return { created: true, skipped: false };
    }

    await deps.pipedrive.notes.create({
      deal_id: dealId,
      content
    });

    await writeAudit(deps, {
      entityType: "deal",
      entityId: String(dealId),
      action: "stale_deal_nudge",
      source,
      beforeJson: { dealId, ageDays: age },
      afterJson: { dryRun: false, created: true }
    });

    await markIdempotencyStatus(deps.prisma, scope, key, "done");
    return { created: true, skipped: false };
  } catch (error) {
    await markIdempotencyStatus(deps.prisma, scope, key, "failed");
    throw error;
  }
}

export async function leadSweepJob(deps: WorkerDeps, source: "nightly" | "manual"): Promise<SweepStats> {
  const started = await deps.prisma.jobRun.create({
    data: {
      jobName: JOB_NAMES.leadSweep,
      status: "running"
    }
  });

  const stats: SweepStats = {
    processed: 0,
    createdActivities: 0,
    staleNudges: 0,
    skipped: 0,
    errors: 0
  };

  try {
    const leads = await deps.pipedrive.leads.list();

    for (const lead of leads) {
      stats.processed += 1;
      try {
        const result = await leadTriageEnforceJob(deps, lead.id, source);
        if (result.created) {
          stats.createdActivities += 1;
        }
        if (result.skipped) {
          stats.skipped += 1;
        }
      } catch (error) {
        stats.errors += 1;
        deps.logger.error(
          { leadId: lead.id, error: error instanceof Error ? error.message : String(error) },
          "leadSweep lead failed"
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
    staleNudges: 0,
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
        await snapshotDeal(deps, deal);

        const result = await slaDealEnforceJob(deps, deal.id, source);
        if (result.created) {
          stats.createdActivities += 1;
        }
        if (result.skipped) {
          stats.skipped += 1;
        }

        const staleResult = await staleDealNudgeJob(deps, deal.id, source);
        if (staleResult.created) {
          stats.staleNudges += 1;
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
  const review = await deps.prisma.reviewQueue.findUnique({ where: { id: reviewQueueId } });
  if (!review) {
    deps.logger.warn({ reviewQueueId }, "ReviewQueue item not found");
    return;
  }

  const parsed = parseMergeReviewPayload(review.payloadJson);
  if (!parsed) {
    await writeAudit(deps, {
      entityType: "review_queue",
      entityId: reviewQueueId,
      action: "merge_review_invalid_payload",
      source: "manual",
      beforeJson: review.payloadJson,
      afterJson: { skipped: true }
    });
    await setReviewQueueStatus(deps, reviewQueueId, "open");
    return;
  }

  if (parsed.confidenceScore < deps.env.mergeConfidenceThreshold) {
    await deps.prisma.mergeCandidate.create({
      data: {
        entityType: parsed.entityType,
        sourceId: parsed.sourceId,
        targetId: parsed.targetId,
        confidenceScore: parsed.confidenceScore,
        status: "rejected",
        reviewedAt: new Date()
      }
    });

    await writeAudit(deps, {
      entityType: parsed.entityType,
      entityId: String(parsed.sourceId),
      action: "merge_review_rejected_confidence",
      source: "manual",
      beforeJson: parsed,
      afterJson: {
        skipped: true,
        threshold: deps.env.mergeConfidenceThreshold
      }
    });
    await setReviewQueueStatus(deps, reviewQueueId, "rejected");
    return;
  }

  const openDeals = await getOpenDealsForEntity(deps, parsed.entityType, parsed.sourceId);
  if (openDeals.length > 0) {
    await deps.prisma.mergeCandidate.create({
      data: {
        entityType: parsed.entityType,
        sourceId: parsed.sourceId,
        targetId: parsed.targetId,
        confidenceScore: parsed.confidenceScore,
        status: "pending",
        reviewedAt: new Date()
      }
    });

    await writeAudit(deps, {
      entityType: parsed.entityType,
      entityId: String(parsed.sourceId),
      action: "merge_review_requires_human_open_deals",
      source: "manual",
      beforeJson: parsed,
      afterJson: {
        skipped: true,
        openDealCount: openDeals.length
      }
    });
    await setReviewQueueStatus(deps, reviewQueueId, "open");
    return;
  }

  const [sourceEntity, targetEntity] = await Promise.all([
    getEntityRecordForMerge(deps, parsed.entityType, parsed.sourceId),
    getEntityRecordForMerge(deps, parsed.entityType, parsed.targetId)
  ]);

  const nowMs = Date.now();
  if (isWithinCooldown(sourceEntity, nowMs) || isWithinCooldown(targetEntity, nowMs)) {
    await deps.prisma.mergeCandidate.create({
      data: {
        entityType: parsed.entityType,
        sourceId: parsed.sourceId,
        targetId: parsed.targetId,
        confidenceScore: parsed.confidenceScore,
        status: "pending",
        reviewedAt: new Date()
      }
    });

    await writeAudit(deps, {
      entityType: parsed.entityType,
      entityId: String(parsed.sourceId),
      action: "merge_review_requires_human_cooldown",
      source: "manual",
      beforeJson: parsed,
      afterJson: {
        skipped: true,
        cooldownHours: MERGE_COOLDOWN_HOURS
      }
    });
    await setReviewQueueStatus(deps, reviewQueueId, "open");
    return;
  }

  const [sourceTouches, targetTouches] = await Promise.all([
    countEntityTouches(deps, parsed.entityType, parsed.sourceId),
    countEntityTouches(deps, parsed.entityType, parsed.targetId)
  ]);

  const candidate = await deps.prisma.mergeCandidate.create({
    data: {
      entityType: parsed.entityType,
      sourceId: parsed.sourceId,
      targetId: parsed.targetId,
      confidenceScore: parsed.confidenceScore,
      status: "pending",
      reviewedAt: new Date()
    }
  });

  await writeAudit(deps, {
    entityType: parsed.entityType,
    entityId: String(parsed.sourceId),
    action: "merge_review_planned",
    source: "manual",
    beforeJson: {
      reviewQueueId,
      mergeInput: parsed
    },
    afterJson: {
      mergeCandidateId: candidate.id,
      dryRun: true,
      sourceTouches,
      targetTouches
    }
  });

  await setReviewQueueStatus(deps, reviewQueueId, "approved");
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
    await leadTriageEnforceJob(deps, String(job.data.leadId), job.data.source ?? "manual");
    return;
  }

  if (job.name === JOB_NAMES.slaSweep) {
    await slaSweepJob(deps, job.data.source ?? "nightly");
    return;
  }

  if (job.name === JOB_NAMES.leadSweep) {
    await leadSweepJob(deps, job.data.source ?? "nightly");
    return;
  }

  if (job.name === JOB_NAMES.staleDealNudge) {
    await staleDealNudgeJob(deps, Number(job.data.dealId), job.data.source ?? "manual");
    return;
  }

  if (job.name === JOB_NAMES.mergeReview) {
    await mergeReviewJob(deps, String(job.data.reviewQueueId));
    return;
  }

  throw new Error(`Unsupported job ${job.name}`);
}
