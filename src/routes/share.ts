import type { FastifyInstance } from "fastify";
import OpenAI from "openai";

import { settings } from "../config.js";
import {
  sharePosterRequestSchema,
  structuredInsightSchema,
  ttsRequestSchema,
  type StructuredInsight,
} from "../schemas/insight.js";
import { memoryRepository } from "../services/database.js";
import { vlmService } from "../services/vlm.js";

function buildPosterFromInsight(
  insight: StructuredInsight,
  memoryId: string,
) {
  const share = insight.share_card;
  const headline =
    share?.headline || insight.title;
  const quote =
    share?.quote || insight.subtitle || insight.narrative || "";
  const cta =
    share?.cta ||
    insight.context.practical ||
    "随手拍一张传上来，Vision Agent 随时准备为你带来惊喜。";

  return {
    memory_id: memoryId,
    poster: {
      headline,
      subtitle: insight.subtitle || insight.category,
      quote,
      cta,
      category: insight.category,
      brand: "Vision Agent",
      tagline: "看见它，理解它",
      signature: "Seeing with Vision Agent",
    },
  };
}

export async function shareRoutes(app: FastifyInstance): Promise<void> {
  app.post("/tts", async (request, reply) => {
    const body = ttsRequestSchema.parse(request.body);

    if (vlmService.demoMode) {
      return {
        mode: "client",
        text: body.text,
        locale: body.locale,
        message: "Use expo-speech on client for TTS playback.",
      };
    }

    try {
      const client = new OpenAI({ apiKey: settings.openaiApiKey });
      const response = await client.audio.speech.create({
        model: "tts-1",
        voice: "nova",
        input: body.text.slice(0, 500),
      });
      const arrayBuffer = await response.arrayBuffer();
      const audioBase64 = Buffer.from(arrayBuffer).toString("base64");
      return {
        mode: "server",
        audio_base64: audioBase64,
        format: "mp3",
      };
    } catch (exc) {
      return reply.code(500).send({
        detail: exc instanceof Error ? exc.message : String(exc),
      });
    }
  });

  app.post("/share/poster", async (request) => {
    const body = sharePosterRequestSchema.parse(request.body);
    const record = memoryRepository.get(body.memory_id);
    if (record) {
      const insight = structuredInsightSchema.parse(
        JSON.parse(record.insight_json) as unknown,
      );
      return buildPosterFromInsight(insight, body.memory_id);
    }

    return {
      memory_id: body.memory_id,
      poster: {
        headline: body.title,
        subtitle: body.category,
        quote: body.summary,
        cta: body.summary,
        category: body.category,
        brand: "Vision Agent",
        tagline: "看见它，理解它",
        signature: "Seeing with Vision Agent",
      },
    };
  });
}
