import { z } from "zod";

const envSchema = z.object({
  PIPEDRIVE_API_TOKEN: z.string().min(1),
  WEBHOOK_SECRET: z.string().min(1),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  DRY_RUN: z
    .string()
    .transform((value) => value.toLowerCase() === "true")
    .default("true"),
  DEFAULT_TIMEZONE: z.string().default("UTC"),
  SLA_FUTURE_ACTIVITY_DAYS: z.coerce.number().int().positive().default(3),
  STALE_DAYS: z.coerce.number().int().positive().default(7),
  BOT_USER_ID: z.string().optional(),
  MERGE_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  PIPEDRIVE_COMPANY_DOMAIN: z.string().trim().min(1).optional(),
  CADENCE_COLD_DAYS: z.coerce.number().int().positive().default(7),
  CADENCE_COOLING_DAYS: z.coerce.number().int().positive().default(3),
  LEAD_SWEEP_CRON: z.string().default("0 5 * * *"),
  PIPELINE_ID: z.string().optional(),
  ACTIVE_STAGE_IDS: z.string().optional()
});

export type AppEnv = {
  pipedriveApiToken: string;
  webhookSecret: string;
  databaseUrl: string;
  redisUrl: string;
  dryRun: boolean;
  defaultTimezone: string;
  slaFutureActivityDays: number;
  staleDays: number;
  botUserId?: number;
  mergeConfidenceThreshold: number;
  pipedriveCompanyDomain?: string;
  cadenceColdDays: number;
  cadenceCoolingDays: number;
  leadSweepCron: string;
  pipelineId?: number;
  activeStageIds?: number[];
};

export function loadEnv(raw: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = envSchema.parse(raw);

  const botUserId =
    parsed.BOT_USER_ID && parsed.BOT_USER_ID.trim() !== ""
      ? Number(parsed.BOT_USER_ID)
      : undefined;

  return {
    pipedriveApiToken: parsed.PIPEDRIVE_API_TOKEN,
    webhookSecret: parsed.WEBHOOK_SECRET,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    dryRun: parsed.DRY_RUN,
    defaultTimezone: parsed.DEFAULT_TIMEZONE,
    slaFutureActivityDays: parsed.SLA_FUTURE_ACTIVITY_DAYS,
    staleDays: parsed.STALE_DAYS,
    botUserId: Number.isFinite(botUserId) ? botUserId : undefined,
    mergeConfidenceThreshold: parsed.MERGE_CONFIDENCE_THRESHOLD,
    pipedriveCompanyDomain: parsed.PIPEDRIVE_COMPANY_DOMAIN,
    cadenceColdDays: parsed.CADENCE_COLD_DAYS,
    cadenceCoolingDays: parsed.CADENCE_COOLING_DAYS,
    leadSweepCron: parsed.LEAD_SWEEP_CRON,
    pipelineId: parsed.PIPELINE_ID ? Number(parsed.PIPELINE_ID) : undefined,
    activeStageIds: parsed.ACTIVE_STAGE_IDS
      ? parsed.ACTIVE_STAGE_IDS.split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
      : undefined
  };
}
