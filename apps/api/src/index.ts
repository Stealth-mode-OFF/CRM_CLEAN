import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PipedriveClient } from "@autopilot/pipedrive";
import { loadEnv, logger } from "@autopilot/shared";
import { createQueue } from "./lib.js";
import { createServer } from "./server.js";

const env = loadEnv();
const prisma = new PrismaClient();
const pipedrive = new PipedriveClient({ token: env.pipedriveApiToken });
const queue = createQueue(env.redisUrl);

const app = await createServer({ env, prisma, pipedrive, queue, logger });

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
logger.info({ port }, "API server started");

const shutdown = async () => {
  await app.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
