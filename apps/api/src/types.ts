import type { PrismaClient } from "@prisma/client";
import type { Queue } from "bullmq";
import type { PipedriveClient } from "@autopilot/pipedrive";
import type { AppEnv, Logger } from "@autopilot/shared";

export type ApiDeps = {
  env: AppEnv;
  prisma: PrismaClient;
  queue: Queue;
  pipedrive: PipedriveClient;
  logger: Logger;
};
