import type { FastifyInstance } from "fastify";

import {
  insightPlanner,
  parseAgentOverride,
  sceneRouter,
} from "../agents/router.js";
import {
  flattenFollowupSuggestions,
  resolveFollowupChips,
} from "../agents/prompts.js";
import {
  AgentId,
  followUpRequestSchema,
  structuredFollowUpAnswerSchema,
  structuredInsightSchema,
  type MemoryItem,
  type StructuredInsight,
} from "../schemas/insight.js";
import {
  memoryRepository,
  type MemoryRecord,
} from "../services/database.js";
import { storageService } from "../services/storage.js";
import { visionService } from "../services/vision.js";
import { vlmService } from "../services/vlm.js";
import { settings } from "../config.js";

const FOOD_SCAN_THINKING_STEPS = [
  "检查图像是否包含食物",
  "识别主要食材与份量",
  "估算热量与三大营养素",
  "生成饮食建议与过敏提示",
];

const FOOD_SCAN_THINKING_STEP_DELAYS_MS = [2800, 3000, 3200, 0];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recordToItem(record: MemoryRecord, baseUrl = ""): MemoryItem {
  const insight = structuredInsightSchema.parse(
    JSON.parse(record.insight_json) as unknown,
  );
  return {
    id: record.id,
    title: record.title,
    category: record.category,
    agent_id: insight.agent_id,
    image_url: `${baseUrl}/uploads/${record.image_filename}`,
    thumbnail_url: `${baseUrl}/uploads/${record.thumbnail_filename}`,
    insight,
    created_at: record.created_at,
    locale: record.locale,
  };
}

function optionalFloat(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value);
  return s.length ? s : undefined;
}

async function readMultipartAnalyze(request: {
  parts: () => AsyncIterableIterator<{
    type: string;
    fieldname: string;
    value?: unknown;
    toBuffer?: () => Promise<Buffer>;
  }>;
}): Promise<{
  image: Buffer;
  locale: string;
  latitude?: number;
  longitude?: number;
  agentOverride?: string;
}> {
  let image: Buffer | null = null;
  let locale = "zh-CN";
  let latitude: number | undefined;
  let longitude: number | undefined;
  let agentOverride: string | undefined;

  for await (const part of request.parts()) {
    if (part.type === "file" && part.fieldname === "image" && part.toBuffer) {
      image = await part.toBuffer();
      continue;
    }
    if (part.type === "field") {
      if (part.fieldname === "locale") {
        locale = optionalString(part.value) ?? "zh-CN";
      } else if (part.fieldname === "latitude") {
        latitude = optionalFloat(part.value);
      } else if (part.fieldname === "longitude") {
        longitude = optionalFloat(part.value);
      } else if (part.fieldname === "agent_override") {
        agentOverride = optionalString(part.value);
      }
    }
  }

  if (!image?.length) {
    throw Object.assign(new Error("Empty image"), { statusCode: 400 });
  }

  return { image, locale, latitude, longitude, agentOverride };
}

function sendSse(
  reply: {
    raw: NodeJS.WritableStream & {
      writeHead?: (code: number, headers: Record<string, string>) => void;
      write: (chunk: string) => boolean;
      end: () => void;
    };
    hijack: () => void;
  },
  event: string,
  data: unknown,
): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function timedLog(label: string, started: number): void {
  if (!settings.debug) return;
  console.log(`[analyze] ${label} ${Date.now() - started}ms`);
}

/**
 * 有 override（专项镜头）：完整 caption → DeepSeek 完整 JSON（质量优先）
 * 无 override（自动）：fast caption → router → vision oneshot（速度优先）
 */
async function runAnalyzePipeline(input: {
  imageBytes: Buffer;
  locale: string;
  latitude?: number;
  longitude?: number;
  agentOverride?: ReturnType<typeof parseAgentOverride>;
  onStage?: (stage: string) => void;
  onAgent?: (agentId: AgentId) => void;
}): Promise<{ caption: string; agentId: AgentId; insight: StructuredInsight }> {
  const imageB64 = input.imageBytes.toString("base64");
  const pipelineStarted = Date.now();

  if (input.agentOverride) {
    input.onStage?.("captioning");
    input.onAgent?.(input.agentOverride);
    const captionStarted = Date.now();
    const caption = await visionService.describeImage(
      imageB64,
      input.locale,
      input.imageBytes,
      "full",
    );
    timedLog("full_caption", captionStarted);

    input.onStage?.("analyzing");
    const insightStarted = Date.now();
    const insight = await insightPlanner.analyze({
      imageBytes: input.imageBytes,
      agentId: input.agentOverride,
      locale: input.locale,
      imageCaption: caption,
      latitude: input.latitude,
      longitude: input.longitude,
      qualityMode: true,
    });
    timedLog("insight_quality", insightStarted);
    timedLog("pipeline_override_total", pipelineStarted);
    return { caption, agentId: input.agentOverride, insight };
  }

  input.onStage?.("captioning");
  const captionStarted = Date.now();
  const caption = await visionService.describeImageFast(
    imageB64,
    input.locale,
    input.imageBytes,
  );
  timedLog("fast_caption", captionStarted);

  input.onStage?.("routing");
  const routeStarted = Date.now();
  const agentId = await sceneRouter.route({
    imageBytes: input.imageBytes,
    agentOverride: null,
    imageCaption: caption,
  });
  timedLog("route", routeStarted);
  input.onAgent?.(agentId);

  input.onStage?.("analyzing");
  const insightStarted = Date.now();
  const insight = await insightPlanner.analyze({
    imageBytes: input.imageBytes,
    agentId,
    locale: input.locale,
    imageCaption: caption,
    latitude: input.latitude,
    longitude: input.longitude,
    qualityMode: false,
  });
  timedLog("insight", insightStarted);
  timedLog("pipeline_auto_total", pipelineStarted);

  return { caption, agentId, insight };
}

export async function analyzeRoutes(app: FastifyInstance): Promise<void> {
  app.post("/analyze", async (request, reply) => {
    const form = await readMultipartAnalyze(request);
    const override = parseAgentOverride(form.agentOverride);
    const { filename, processed } = await storageService.saveImage(form.image);
    const thumbFilename = filename.replace(".jpg", "_thumb.jpg");

    const { caption, agentId, insight } = await runAnalyzePipeline({
      imageBytes: processed,
      locale: form.locale,
      latitude: form.latitude,
      longitude: form.longitude,
      agentOverride: override,
    });

    const record = memoryRepository.create({
      title: insight.title,
      category: insight.category,
      agent_id: insight.agent_id,
      image_filename: filename,
      thumbnail_filename: thumbFilename,
      insight,
      locale: form.locale,
      image_caption: caption,
      latitude: form.latitude,
      longitude: form.longitude,
    });

    return {
      memory_id: record.id,
      agent_id: agentId,
      followup_chips: resolveFollowupChips(insight),
      insight,
      image_url: `/uploads/${filename}`,
      thumbnail_url: `/uploads/${thumbFilename}`,
    };
  });

  app.post("/analyze/stream", async (request, reply) => {
    const form = await readMultipartAnalyze(request);
    const override = parseAgentOverride(form.agentOverride);
    const { filename, processed } = await storageService.saveImage(form.image);
    const thumbFilename = filename.replace(".jpg", "_thumb.jpg");

    reply.hijack();
    reply.raw.writeHead?.(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      let caption = "";
      let agentId: AgentId = AgentId.GENERAL_CURIOSITY;

      const analyzePromise = (async () => {
        const result = await runAnalyzePipeline({
          imageBytes: processed,
          locale: form.locale,
          latitude: form.latitude,
          longitude: form.longitude,
          agentOverride: override,
          onStage: (stage) => sendSse(reply, "status", { stage }),
          onAgent: (id) => {
            agentId = id;
            sendSse(reply, "agent", { agent_id: id });
          },
        });
        caption = result.caption;
        agentId = result.agentId;
        return result.insight;
      })();

      if (override === AgentId.FOOD_SCAN) {
        let analyzeDone = false;
        void analyzePromise.then(() => {
          analyzeDone = true;
        });

        for (const [index, step] of FOOD_SCAN_THINKING_STEPS.entries()) {
          if (analyzeDone) break;
          sendSse(reply, "thinking", { step, index });
          const delay = FOOD_SCAN_THINKING_STEP_DELAYS_MS[index] ?? 0;
          if (delay <= 0) break;
          await Promise.race([analyzePromise, sleep(delay)]);
        }
      }

      const insight = await analyzePromise;

      sendSse(reply, "partial", {
        title: insight.title,
        category: insight.category,
        confidence: insight.confidence,
      });

      const record = memoryRepository.create({
        title: insight.title,
        category: insight.category,
        agent_id: insight.agent_id,
        image_filename: filename,
        thumbnail_filename: thumbFilename,
        insight,
        locale: form.locale,
        image_caption: caption,
        latitude: form.latitude,
        longitude: form.longitude,
      });

      sendSse(reply, "complete", {
        memory_id: record.id,
        agent_id: agentId,
        followup_chips: resolveFollowupChips(insight),
        insight,
        image_url: `/uploads/${filename}`,
        thumbnail_url: `/uploads/${thumbFilename}`,
      });
    } catch (err) {
      sendSse(reply, "error", {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      reply.raw.end();
    }
  });

  app.post("/followup", async (request, reply) => {
    const body = followUpRequestSchema.parse(request.body);
    const record = memoryRepository.get(body.memory_id);
    if (!record) {
      return reply.code(404).send({ detail: "Memory not found" });
    }

    const imageBytes = await storageService.readImageBytes(
      record.image_filename,
    );
    const imageB64 = imageBytes.toString("base64");
    const insight = JSON.parse(record.insight_json) as Record<string, unknown>;
    const followupHistory = JSON.parse(record.followups_json || "[]") as Array<
      Record<string, unknown>
    >;

    const result = await vlmService.followup({
      imageB64,
      question: body.question,
      insight,
      locale: body.locale,
      imageCaption: record.image_caption || null,
      followupHistory,
      agentId: record.agent_id,
      latitude: body.latitude ?? record.latitude,
      longitude: body.longitude ?? record.longitude,
    });

    const structuredParsed = structuredFollowUpAnswerSchema.safeParse(
      result.structured_answer,
    );
    const structuredAnswer = structuredParsed.success
      ? structuredParsed.data
      : undefined;

    let answer = String(result.answer ?? "");
    if (structuredAnswer?.summary) {
      answer = structuredAnswer.summary;
    }

    memoryRepository.appendFollowup(
      body.memory_id,
      body.question,
      answer,
      structuredAnswer ?? null,
    );

    return {
      memory_id: body.memory_id,
      answer,
      structured_answer: structuredAnswer ?? null,
      suggested_followups: flattenFollowupSuggestions(result),
    };
  });

  app.get("/memories", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Number(query.limit ?? 50) || 50;
    const records = memoryRepository.listAll("anonymous", limit);
    const items = records.map((r) => recordToItem(r));
    return { items, total: items.length };
  });

  app.get("/memories/:memoryId", async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const record = memoryRepository.get(memoryId);
    if (!record) {
      return reply.code(404).send({ detail: "Memory not found" });
    }
    const followups = JSON.parse(record.followups_json || "[]");
    return { memory: recordToItem(record), followups };
  });

  app.delete("/memories/:memoryId", async (request, reply) => {
    const { memoryId } = request.params as { memoryId: string };
    const record = memoryRepository.delete(memoryId);
    if (!record) {
      return reply.code(404).send({ detail: "Memory not found" });
    }
    storageService.deleteImageFiles(
      record.image_filename,
      record.thumbnail_filename,
    );
    return { ok: true, memory_id: memoryId };
  });

  app.get("/agents", async () => {
    return {
      agents: [
        { id: AgentId.LOCAL_GUIDE, name: "本地向导", icon: "map" },
        { id: AgentId.ART_CRITIC, name: "艺术评论家", icon: "palette" },
        { id: AgentId.DESIGN_CRITIC, name: "设计评论家", icon: "chair" },
        { id: AgentId.STYLIST, name: "造型师", icon: "shirt" },
        { id: AgentId.FOOD_EXPLORER, name: "美食探索", icon: "utensils" },
        { id: AgentId.FOOD_SCAN, name: "食识拍", icon: "scan" },
        { id: AgentId.TEXT_READER, name: "文字解读", icon: "text" },
        { id: AgentId.GENERAL_CURIOSITY, name: "好奇心", icon: "sparkles" },
      ],
    };
  });
}

export type { StructuredInsight };
