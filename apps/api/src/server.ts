import fastify, { type FastifyInstance } from "fastify";
import type { ApiDeps } from "./types.js";
import { registerRoutes } from "./routes.js";

export async function createServer(deps: ApiDeps): Promise<FastifyInstance> {
  const app = fastify({
    logger: false
  });

  await registerRoutes(app, deps);

  app.get("/health", async () => ({ ok: true }));

  return app;
}
