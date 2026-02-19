import type { PrismaClient } from "@prisma/client";
import type { PipedriveClient } from "@autopilot/pipedrive";
import type { AppEnv, Logger } from "@autopilot/shared";

export type WorkerDeps = {
  env: AppEnv;
  prisma: PrismaClient;
  pipedrive: PipedriveClient;
  logger: Logger;
};

export type SweepStats = {
  processed: number;
  createdActivities: number;
  staleNudges: number;
  skipped: number;
  errors: number;
};
