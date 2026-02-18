import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Worker } from "bullmq";
import { PipedriveClient } from "@autopilot/pipedrive";
import { AUTOPILOT_QUEUE, loadEnv, logger } from "@autopilot/shared";
import { dispatchJob } from "./jobs/autopilot.js";
import type { WorkerDeps } from "./types.js";

const env = loadEnv();
const prisma = new PrismaClient();
const pipedrive = new PipedriveClient({ token: env.pipedriveApiToken });

const deps: WorkerDeps = {
  env,
  prisma,
  pipedrive,
  logger
};

const worker = new Worker(
  AUTOPILOT_QUEUE,
  async (job) => {
    await dispatchJob(deps, job);
  },
  {
    connection: {
      url: env.redisUrl
    },
    concurrency: 5
  }
);

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, name: job.name }, "Job completed");
});

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err: err.message }, "Job failed");
});

logger.info("Worker started");

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
