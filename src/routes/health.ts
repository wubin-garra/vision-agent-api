import type { FastifyInstance } from "fastify";

import { settings } from "../config.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    return {
      status: "ok",
      app: settings.appName,
      llm_provider: settings.llmProvider,
      llm_enabled: settings.llmEnabled,
      llm_model: settings.llmEnabled ? settings.llmModel : null,
      vision_provider: settings.visionProvider,
      vision_enabled: settings.visionEnabled,
      vision_model:
        settings.visionProvider === "openai"
          ? settings.openaiVisionModel
          : settings.dashscopeVisionModel,
      demo_mode: settings.demoMode,
      runtime: "nodejs",
    };
  });
}
