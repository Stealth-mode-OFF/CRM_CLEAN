import fastify, { type FastifyInstance } from "fastify";
import type { ApiDeps } from "./types.js";
import { registerRoutes } from "./routes.js";

export async function createServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = fastify({
    logger: false
  });

  await registerRoutes(app, deps);

  app.get("/health", async () => {
    const [pipedriveReachable, postgresConnected, redisData] = await Promise.all([
      deps.pipedrive.deals
        .list({ limit: 1 })
        .then(() => true)
        .catch(() => false),
      deps.prisma.$queryRaw`SELECT 1`
        .then(() => true)
        .catch(() => false),
      deps.queue
        .getJobCounts("waiting", "active", "delayed", "failed")
        .then((counts) => ({ connected: true, counts }))
        .catch(() => ({ connected: false, counts: { waiting: 0, active: 0, delayed: 0, failed: 0 } }))
    ]);

    return {
      ok: pipedriveReachable && postgresConnected && redisData.connected,
      subsystems: {
        pipedriveReachable,
        postgresConnected,
        redisConnected: redisData.connected
      },
      queueDepth: redisData.counts
    };
  });

  return app;
}
