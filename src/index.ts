import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";

import { settings } from "./config.js";
import { analyzeRoutes } from "./routes/analyze.js";
import { healthRoutes } from "./routes/health.js";
import { shareRoutes } from "./routes/share.js";
import { storageService } from "./services/storage.js";

async function main() {
  const app = Fastify({
    logger: settings.debug,
    bodyLimit: 20 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await app.register(multipart, {
    limits: {
      fileSize: 20 * 1024 * 1024,
    },
  });

  await app.register(fastifyStatic, {
    root: storageService.uploadDir,
    prefix: "/uploads/",
  });

  await app.register(healthRoutes);
  await app.register(analyzeRoutes, { prefix: settings.apiPrefix });
  await app.register(shareRoutes, { prefix: settings.apiPrefix });

  await app.listen({ port: settings.port, host: settings.host });
  app.log.info(
    `Vision Agent API listening on http://${settings.host}:${settings.port}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
