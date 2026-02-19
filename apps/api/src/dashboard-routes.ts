import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import {
  AUTOPILOT_PREFIX,
  addBusinessDays,
  buildPipedrivePath,
  buildPipedriveUrl,
  dateToYyyyMmDd,
  scoreLead
} from "@autopilot/shared";
import type { PipedriveActivity, PipedriveDeal, PipedriveLead } from "@autopilot/pipedrive";
import type { ApiDeps } from "./types.js";

const DASHBOARD_CACHE_TTL_MS = 60_000;
const dashboardCache = new Map<string, { data: unknown; expires: number }>();

type CadenceStatus = "healthy" | "cooling" | "cold";

type BriefingItem = {
  priority: number;
  type: "overdue_task" | "stale_deal" | "cold_outreach" | "lead_qualification" | "follow_up_today";
  entityType: "deal" | "lead" | "activity";
  entityId: string;
  title: string;
  reason: string;
  pipedriveLinkPath: string;
  pipedriveUrl: string;
};

function parseTimestamp(input?: string | null): number | null {
  if (!input) {
    return null;
  }
  const timestamp = Date.parse(input);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function diffDays(fromMs: number, toMs: number): number {
  return (toMs - fromMs) / (24 * 60 * 60 * 1000);
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ninetyDaysAgoMs(nowMs: number): number {
  return nowMs - 90 * 24 * 60 * 60 * 1000;
}

function thirtyDaysAgoMs(nowMs: number): number {
  return nowMs - 30 * 24 * 60 * 60 * 1000;
}

function todayYyyyMmDd(): string {
  return dateToYyyyMmDd(new Date());
}

function touchTimeFromActivity(activity: PipedriveActivity): number | null {
  const dueDate = activity.due_date ? parseTimestamp(`${activity.due_date}T00:00:00.000Z`) : null;
  return (
    parseTimestamp(activity.done_date ? `${activity.done_date}T00:00:00.000Z` : null) ??
    parseTimestamp(activity.update_time ?? null) ??
    parseTimestamp(activity.add_time ?? null) ??
    dueDate
  );
}

function dealStageAgingDays(deal: PipedriveDeal, nowMs: number): number | null {
  const stageTimestamp =
    parseTimestamp(deal.stage_change_time ?? null) ??
    parseTimestamp(deal.update_time ?? null) ??
    parseTimestamp(deal.add_time ?? null);

  if (stageTimestamp === null) {
    return null;
  }

  return diffDays(stageTimestamp, nowMs);
}

function setCacheHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "max-age=60");
}

function getFromCache<T>(key: string): T | null {
  const row = dashboardCache.get(key);
  if (!row) {
    return null;
  }

  if (row.expires < Date.now()) {
    dashboardCache.delete(key);
    return null;
  }

  return row.data as T;
}

async function withCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const cached = getFromCache<T>(key);
  if (cached !== null) {
    return cached;
  }

  const data = await loader();
  dashboardCache.set(key, {
    data,
    expires: Date.now() + DASHBOARD_CACHE_TTL_MS
  });
  return data;
}

function clearDashboardCache(): void {
  dashboardCache.clear();
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

async function loadVelocity(deps: ApiDeps): Promise<{
  avgDaysInStage: Record<string, number>;
  staleDealIds: number[];
  pipelineVelocity: number;
  conversionRate: number;
}> {
  const nowMs = Date.now();
  const [openDeals, wonDeals, lostDeals] = await Promise.all([
    withCache("deals:open", () => deps.pipedrive.deals.list({ status: "open", pipeline_id: deps.env.pipelineId })),
    withCache("deals:won", () => deps.pipedrive.deals.list({ status: "won", pipeline_id: deps.env.pipelineId })),
    withCache("deals:lost", () => deps.pipedrive.deals.list({ status: "lost", pipeline_id: deps.env.pipelineId }))
  ]);

  const stageBuckets = new Map<number, number[]>();
  const staleDealIds: number[] = [];

  for (const deal of openDeals) {
    if (typeof deal.stage_id !== "number") {
      continue;
    }

    const ageDays = dealStageAgingDays(deal, nowMs);
    if (ageDays === null) {
      continue;
    }

    const rows = stageBuckets.get(deal.stage_id) ?? [];
    rows.push(ageDays);
    stageBuckets.set(deal.stage_id, rows);

    if (ageDays > deps.env.staleDays) {
      staleDealIds.push(deal.id);
    }
  }

  const avgDaysInStage: Record<string, number> = {};
  for (const [stageId, values] of stageBuckets.entries()) {
    avgDaysInStage[String(stageId)] = average(values);
  }

  const cutoffMs = ninetyDaysAgoMs(nowMs);

  const wonIn90Days = wonDeals.filter((deal) => {
    const closedAt = parseTimestamp(deal.won_time ?? deal.close_time ?? deal.update_time ?? null);
    return typeof closedAt === "number" && closedAt >= cutoffMs;
  });

  const lostIn90Days = lostDeals.filter((deal) => {
    const closedAt = parseTimestamp(deal.lost_time ?? deal.close_time ?? deal.update_time ?? null);
    return typeof closedAt === "number" && closedAt >= cutoffMs;
  });

  const pipelineVelocity = average(
    wonIn90Days
      .map((deal) => {
        const created = parseTimestamp(deal.add_time ?? null);
        const won = parseTimestamp(deal.won_time ?? deal.close_time ?? deal.update_time ?? null);
        if (created === null || won === null) {
          return null;
        }
        return diffDays(created, won);
      })
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
  );

  const conversionDenominator = wonIn90Days.length + lostIn90Days.length;
  const conversionRate = conversionDenominator === 0 ? 0 : wonIn90Days.length / conversionDenominator;

  return {
    avgDaysInStage,
    staleDealIds,
    pipelineVelocity,
    conversionRate
  };
}

async function loadCadence(deps: ApiDeps): Promise<{
  deals: Array<{
    dealId: number;
    title: string;
    daysSinceLastTouch: number;
    touchCount30d: number;
    cadenceStatus: CadenceStatus;
  }>;
}> {
  const nowMs = Date.now();
  const openDeals = await withCache("deals:open", () =>
    deps.pipedrive.deals.list({ status: "open", pipeline_id: deps.env.pipelineId })
  );

  const deals = await Promise.all(
    openDeals.map(async (deal) => {
      const [activities, notes] = await Promise.all([
        deps.pipedrive.activities.list({ deal_id: deal.id, limit: 100 }),
        deps.pipedrive.notes.list({ deal_id: deal.id, limit: 100, sort: "add_time DESC" })
      ]);

      const activityTouches = activities
        .map(touchTimeFromActivity)
        .filter((value): value is number => typeof value === "number");
      const noteTouches = notes
        .map((note) => parseTimestamp(note.add_time ?? null))
        .filter((value): value is number => typeof value === "number");

      const allTouches = [...activityTouches, ...noteTouches];
      const lastTouch = allTouches.length > 0 ? Math.max(...allTouches) : parseTimestamp(deal.add_time ?? null) ?? nowMs;
      const daysSinceLastTouch = Math.max(0, Math.floor(diffDays(lastTouch, nowMs)));

      const thresholdMs = thirtyDaysAgoMs(nowMs);
      const touchCount30d = allTouches.filter((timestamp) => timestamp >= thresholdMs).length;

      let cadenceStatus: CadenceStatus = "healthy";
      if (daysSinceLastTouch > deps.env.cadenceColdDays) {
        cadenceStatus = "cold";
      } else if (daysSinceLastTouch >= deps.env.cadenceCoolingDays) {
        cadenceStatus = "cooling";
      }

      return {
        dealId: deal.id,
        title: deal.title ?? `Deal #${deal.id}`,
        daysSinceLastTouch,
        touchCount30d,
        cadenceStatus
      };
    })
  );

  deals.sort((a, b) => b.daysSinceLastTouch - a.daysSinceLastTouch);
  return { deals };
}

async function loadLeadsWithScore(deps: ApiDeps): Promise<{
  leads: Array<{
    id: string;
    title: string;
    score: number;
  }>;
}> {
  const leads = await withCache("leads:all", () => deps.pipedrive.leads.list());

  const rows = await Promise.all(
    leads.map(async (lead) => {
      const personId =
        typeof lead.person_id === "number"
          ? lead.person_id
          : lead.person_id && typeof lead.person_id === "object" && "value" in lead.person_id
            ? (lead.person_id as { value?: number }).value
            : undefined;

      const orgId =
        typeof lead.organization_id === "number"
          ? lead.organization_id
          : lead.organization_id && typeof lead.organization_id === "object" && "value" in lead.organization_id
            ? (lead.organization_id as { value?: number }).value
            : undefined;

      const [person, org] = await Promise.all([
        typeof personId === "number" ? deps.pipedrive.persons.get(personId) : Promise.resolve(null),
        typeof orgId === "number" ? deps.pipedrive.orgs.get(orgId) : Promise.resolve(null)
      ]);

      return {
        id: lead.id,
        title: lead.title ?? `Lead ${lead.id}`,
        score: scoreLead(lead, person, org)
      };
    })
  );

  rows.sort((a, b) => b.score - a.score);
  return { leads: rows };
}

async function loadBriefing(deps: ApiDeps): Promise<{ items: BriefingItem[] }> {
  const [velocity, cadence, leads] = await Promise.all([
    loadVelocity(deps),
    loadCadence(deps),
    loadLeadsWithScore(deps)
  ]);

  const items: BriefingItem[] = [];
  let priority = 1;

  const openActivities = await withCache("activities:open", () => deps.pipedrive.activities.list({ done: 0, limit: 200 }));
  const nowMs = Date.now();
  const today = todayYyyyMmDd();

  const overdueTasks = openActivities
    .filter((activity) => {
      if (!activity.due_date) {
        return false;
      }
      const dueTs = parseTimestamp(`${activity.due_date}T00:00:00.000Z`);
      return typeof dueTs === "number" && dueTs < nowMs;
    })
    .sort((a, b) => {
      const aTs = parseTimestamp(a.due_date ? `${a.due_date}T00:00:00.000Z` : null) ?? 0;
      const bTs = parseTimestamp(b.due_date ? `${b.due_date}T00:00:00.000Z` : null) ?? 0;
      return aTs - bTs;
    });

  for (const activity of overdueTasks) {
    const dueTs = parseTimestamp(activity.due_date ? `${activity.due_date}T00:00:00.000Z` : null) ?? nowMs;
    const overdueDays = Math.max(1, Math.floor(diffDays(dueTs, nowMs)));
    const path = buildPipedrivePath("activity", activity.id);
    items.push({
      priority: priority++,
      type: "overdue_task",
      entityType: "activity",
      entityId: String(activity.id),
      title: activity.subject ?? `Activity #${activity.id}`,
      reason: `Úkol je po termínu ${overdueDays} dnů`,
      pipedriveLinkPath: path,
      pipedriveUrl: buildPipedriveUrl("activity", activity.id, deps.env.pipedriveCompanyDomain)
    });
  }

  const coldDeals = cadence.deals.filter((deal) => deal.daysSinceLastTouch > 7);
  for (const deal of coldDeals) {
    const path = buildPipedrivePath("deal", deal.dealId);
    items.push({
      priority: priority++,
      type: "cold_outreach",
      entityType: "deal",
      entityId: String(deal.dealId),
      title: deal.title,
      reason: `Bez kontaktu ${deal.daysSinceLastTouch} dní`,
      pipedriveLinkPath: path,
      pipedriveUrl: buildPipedriveUrl("deal", deal.dealId, deps.env.pipedriveCompanyDomain)
    });
  }

  for (const dealId of velocity.staleDealIds) {
    const path = buildPipedrivePath("deal", dealId);
    items.push({
      priority: priority++,
      type: "stale_deal",
      entityType: "deal",
      entityId: String(dealId),
      title: `Deal #${dealId}`,
      reason: `Deal je ve fázi déle než ${deps.env.staleDays} dní`,
      pipedriveLinkPath: path,
      pipedriveUrl: buildPipedriveUrl("deal", dealId, deps.env.pipedriveCompanyDomain)
    });
  }

  const followUpsToday = openActivities.filter((activity) => activity.due_date === today);
  for (const activity of followUpsToday) {
    const path = buildPipedrivePath("activity", activity.id);
    items.push({
      priority: priority++,
      type: "follow_up_today",
      entityType: "activity",
      entityId: String(activity.id),
      title: activity.subject ?? `Activity #${activity.id}`,
      reason: "Naplánovaný follow-up na dnešek",
      pipedriveLinkPath: path,
      pipedriveUrl: buildPipedriveUrl("activity", activity.id, deps.env.pipedriveCompanyDomain)
    });
  }

  const lowScoreLeads = leads.leads.filter((lead) => lead.score < 40);
  for (const lead of lowScoreLeads) {
    const path = buildPipedrivePath("lead", lead.id);
    items.push({
      priority: priority++,
      type: "lead_qualification",
      entityType: "lead",
      entityId: lead.id,
      title: lead.title,
      reason: `Lead score ${lead.score}/100 - chybí kvalifikační signály`,
      pipedriveLinkPath: path,
      pipedriveUrl: buildPipedriveUrl("lead", lead.id, deps.env.pipedriveCompanyDomain)
    });
  }

  return {
    items: items.slice(0, 15).map((item, index) => ({ ...item, priority: index + 1 }))
  };
}

function aggregateWindow(
  dealsWon: PipedriveDeal[],
  dealsLost: PipedriveDeal[],
  days: number,
  nowMs: number
): { won: number; lost: number; winRate: number; avgDealValue: number } {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;

  const won = dealsWon.filter((deal) => {
    const closedAt = parseTimestamp(deal.won_time ?? deal.close_time ?? deal.update_time ?? null);
    return typeof closedAt === "number" && closedAt >= cutoff;
  });

  const lost = dealsLost.filter((deal) => {
    const closedAt = parseTimestamp(deal.lost_time ?? deal.close_time ?? deal.update_time ?? null);
    return typeof closedAt === "number" && closedAt >= cutoff;
  });

  const wonValues = won
    .map((deal) => (typeof deal.value === "number" ? deal.value : 0))
    .filter((value) => Number.isFinite(value));

  const denominator = won.length + lost.length;
  return {
    won: won.length,
    lost: lost.length,
    winRate: denominator === 0 ? 0 : won.length / denominator,
    avgDealValue: average(wonValues)
  };
}

async function loadAnalytics(deps: ApiDeps): Promise<{
  last30d: { won: number; lost: number; winRate: number; avgDealValue: number };
  last90d: { won: number; lost: number; winRate: number; avgDealValue: number };
  lostReasons: Array<{ reason: string; count: number }>;
  avgTimeToClose: number;
}> {
  const nowMs = Date.now();
  const [wonDeals, lostDeals] = await Promise.all([
    withCache("deals:won", () => deps.pipedrive.deals.list({ status: "won", pipeline_id: deps.env.pipelineId })),
    withCache("deals:lost", () => deps.pipedrive.deals.list({ status: "lost", pipeline_id: deps.env.pipelineId }))
  ]);

  const last30d = aggregateWindow(wonDeals, lostDeals, 30, nowMs);
  const last90d = aggregateWindow(wonDeals, lostDeals, 90, nowMs);

  const reasonMap = new Map<string, number>();
  for (const deal of lostDeals) {
    const reason = (deal.lost_reason ?? "Neznámý důvod").trim() || "Neznámý důvod";
    reasonMap.set(reason, (reasonMap.get(reason) ?? 0) + 1);
  }

  const lostReasons = [...reasonMap.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const cutoff90 = ninetyDaysAgoMs(nowMs);
  const avgTimeToClose = average(
    wonDeals
      .map((deal) => {
        const created = parseTimestamp(deal.add_time ?? null);
        const closed = parseTimestamp(deal.won_time ?? deal.close_time ?? deal.update_time ?? null);
        if (created === null || closed === null || closed < cutoff90) {
          return null;
        }
        return diffDays(created, closed);
      })
      .filter((value): value is number => typeof value === "number")
  );

  return {
    last30d,
    last90d,
    lostReasons,
    avgTimeToClose
  };
}

function parseAddActivityBody(body: unknown): {
  dealId?: number;
  leadId?: string;
  subject: string;
  dueDate: string;
  type: "call" | "meeting" | "email" | "task";
} {
  const value = (body ?? {}) as Record<string, unknown>;
  const subject = String(value.subject ?? "").trim();
  const dueDate = String(value.dueDate ?? "").trim();
  const type = String(value.type ?? "task") as "call" | "meeting" | "email" | "task";

  if (!subject || !dueDate) {
    throw new Error("subject and dueDate are required");
  }

  const dealId = typeof value.dealId === "number" ? value.dealId : undefined;
  const leadId = typeof value.leadId === "string" ? value.leadId : undefined;

  if (!dealId && !leadId) {
    throw new Error("dealId or leadId is required");
  }

  if (!["call", "meeting", "email", "task"].includes(type)) {
    throw new Error("unsupported activity type");
  }

  return { dealId, leadId, subject, dueDate, type };
}

function parseAddNoteBody(body: unknown): { dealId?: number; leadId?: string; content: string } {
  const value = (body ?? {}) as Record<string, unknown>;
  const content = String(value.content ?? "").trim();
  const dealId = typeof value.dealId === "number" ? value.dealId : undefined;
  const leadId = typeof value.leadId === "string" ? value.leadId : undefined;

  if (!content) {
    throw new Error("content is required");
  }

  if (!dealId && !leadId) {
    throw new Error("dealId or leadId is required");
  }

  return { dealId, leadId, content };
}

function parseSnoozeBody(body: unknown): { dealId: number; days: number } {
  const value = (body ?? {}) as Record<string, unknown>;
  const dealId = typeof value.dealId === "number" ? value.dealId : Number.NaN;
  const days = typeof value.days === "number" ? value.days : Number.NaN;

  if (!Number.isFinite(dealId) || !Number.isFinite(days) || days <= 0) {
    throw new Error("dealId and positive days are required");
  }

  return { dealId, days };
}

export async function registerDashboardRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get("/admin/dashboard/velocity", async (_request, reply) => {
    const payload = await withCache("dashboard:velocity", () => loadVelocity(deps));
    setCacheHeaders(reply);
    return payload;
  });

  app.get("/admin/dashboard/cadence", async (_request, reply) => {
    const payload = await withCache("dashboard:cadence", () => loadCadence(deps));
    setCacheHeaders(reply);
    return payload;
  });

  app.get("/admin/dashboard/briefing", async (_request, reply) => {
    const payload = await withCache("dashboard:briefing", () => loadBriefing(deps));
    setCacheHeaders(reply);
    return payload;
  });

  app.get("/admin/dashboard/leads", async (_request, reply) => {
    const payload = await withCache("dashboard:leads", () => loadLeadsWithScore(deps));
    setCacheHeaders(reply);
    return payload;
  });

  app.get("/admin/dashboard/analytics", async (_request, reply) => {
    const payload = await withCache("dashboard:analytics", () => loadAnalytics(deps));
    setCacheHeaders(reply);
    return payload;
  });

  app.post("/admin/dashboard/quick-action/add-activity", async (request, reply) => {
    try {
      const body = parseAddActivityBody(request.body);

      if (deps.env.dryRun) {
        await writeAudit(deps, {
          entityType: body.dealId ? "deal" : "lead",
          entityId: String(body.dealId ?? body.leadId),
          action: "dashboard_add_activity",
          source: "dashboard",
          beforeJson: body,
          afterJson: { dryRun: true }
        });
        return { ok: true, dryRun: true };
      }

      const activity = await deps.pipedrive.activities.create({
        subject: `${AUTOPILOT_PREFIX} ${body.subject}`,
        due_date: body.dueDate,
        type: body.type,
        deal_id: body.dealId,
        lead_id: body.leadId
      });

      clearDashboardCache();
      await writeAudit(deps, {
        entityType: body.dealId ? "deal" : "lead",
        entityId: String(body.dealId ?? body.leadId),
        action: "dashboard_add_activity",
        source: "dashboard",
        beforeJson: body,
        afterJson: { dryRun: false, activityId: activity.id }
      });

      return { ok: true, activityId: activity.id };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/admin/dashboard/quick-action/add-note", async (request, reply) => {
    try {
      const body = parseAddNoteBody(request.body);

      if (deps.env.dryRun) {
        await writeAudit(deps, {
          entityType: body.dealId ? "deal" : "lead",
          entityId: String(body.dealId ?? body.leadId),
          action: "dashboard_add_note",
          source: "dashboard",
          beforeJson: body,
          afterJson: { dryRun: true }
        });
        return { ok: true, dryRun: true };
      }

      const note = await deps.pipedrive.notes.create({
        deal_id: body.dealId,
        lead_id: body.leadId,
        content: `${AUTOPILOT_PREFIX} ${body.content}`
      });

      clearDashboardCache();
      await writeAudit(deps, {
        entityType: body.dealId ? "deal" : "lead",
        entityId: String(body.dealId ?? body.leadId),
        action: "dashboard_add_note",
        source: "dashboard",
        beforeJson: body,
        afterJson: { dryRun: false, noteId: note.id }
      });

      return { ok: true, noteId: note.id };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post("/admin/dashboard/quick-action/snooze", async (request, reply) => {
    try {
      const body = parseSnoozeBody(request.body);
      const dueDate = dateToYyyyMmDd(addBusinessDays(new Date(), body.days));

      if (deps.env.dryRun) {
        await writeAudit(deps, {
          entityType: "deal",
          entityId: String(body.dealId),
          action: "dashboard_snooze",
          source: "dashboard",
          beforeJson: body,
          afterJson: {
            dryRun: true,
            dueDate
          }
        });
        return { ok: true, dryRun: true, dueDate };
      }

      const activity = await deps.pipedrive.activities.create({
        deal_id: body.dealId,
        subject: `${AUTOPILOT_PREFIX} Snoozed - check back`,
        due_date: dueDate,
        type: "task"
      });

      clearDashboardCache();
      await writeAudit(deps, {
        entityType: "deal",
        entityId: String(body.dealId),
        action: "dashboard_snooze",
        source: "dashboard",
        beforeJson: body,
        afterJson: {
          dryRun: false,
          dueDate,
          activityId: activity.id
        }
      });

      return { ok: true, dueDate, activityId: activity.id };
    } catch (error) {
      reply.code(400);
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
