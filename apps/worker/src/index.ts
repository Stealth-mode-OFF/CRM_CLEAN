import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import { PipedriveClient } from "@autopilot/pipedrive";
import { AUTOPILOT_QUEUE, JOB_NAMES, loadEnv, logger, stableHash } from "@autopilot/shared";
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

const schedulerQueue = new Queue(AUTOPILOT_QUEUE, {
  connection: {
    url: env.redisUrl
  }
});

await Promise.all([
  schedulerQueue.add(
    JOB_NAMES.slaSweep,
    { source: "nightly", requestHash: stableHash({ job: JOB_NAMES.slaSweep }) },
    {
      jobId: "repeat:slaSweep",
      repeat: {
        pattern: "0 4 * * *"
      }
    }
  ),
  schedulerQueue.add(
    JOB_NAMES.leadSweep,
    { source: "nightly", requestHash: stableHash({ job: JOB_NAMES.leadSweep }) },
    {
      jobId: "repeat:leadSweep",
      repeat: {
        pattern: env.leadSweepCron
      }
    }
  )
]);

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

logger.info({ leadSweepCron: env.leadSweepCron }, "Worker started");

const shutdown = async () => {
  await worker.close();
  await schedulerQueue.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
