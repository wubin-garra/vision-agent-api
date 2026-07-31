import { AGENT_PROMPTS, SCENE_TO_AGENT } from "./prompts.js";
import { sanitizePalmInsight } from "./palmSanitize.js";
import {
  AgentId,
  agentIdSchema,
  normalizePalmPath,
  sceneClassificationSchema,
  structuredInsightSchema,
  type StructuredInsight,
} from "../schemas/insight.js";
import { vlmService } from "../services/vlm.js";

/** 校验前把 palm_lines.path 各种畸形格式归一成 {x,y}[] */
function normalizePalmReadingRaw(raw: Record<string, unknown>): void {
  const reading = raw.palm_reading;
  if (!reading || typeof reading !== "object") return;
  const pr = reading as Record<string, unknown>;
  const lines = pr.palm_lines;
  if (!Array.isArray(lines)) return;
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const l = line as Record<string, unknown>;
    l.path = normalizePalmPath(l.path);
  }
}

export class SceneRouter {
  async route(input: {
    imageBytes: Buffer;
    agentOverride?: AgentId | null;
    imageCaption?: string | null;
  }): Promise<AgentId> {
    if (input.agentOverride) {
      return input.agentOverride;
    }

    const imageB64 = input.imageBytes.toString("base64");
    const raw = await vlmService.classifyScene({
      imageB64,
      imageCaption: input.imageCaption,
    });

    const parsed = sceneClassificationSchema.safeParse({
      scene_type: raw.scene_type ?? "general",
      text_density: raw.text_density ?? "none",
      has_person: Boolean(raw.has_person),
      recommended_agent: raw.recommended_agent ?? "general_curiosity",
      reasoning: raw.reasoning ?? "",
    });

    if (parsed.success) {
      return parsed.data.recommended_agent;
    }

    const scene = String(raw.scene_type ?? "general");
    return SCENE_TO_AGENT[scene] ?? AgentId.GENERAL_CURIOSITY;
  }
}

export class InsightPlanner {
  async analyze(input: {
    imageBytes: Buffer;
    agentId: AgentId;
    locale?: string;
    imageCaption?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    birthday?: string | null;
    /** 手动选择的专项镜头：完整质量输出 */
    qualityMode?: boolean;
  }): Promise<StructuredInsight> {
    const imageB64 = input.imageBytes.toString("base64");
    const systemPrompt = AGENT_PROMPTS[input.agentId];
    const raw = await vlmService.analyzeImage({
      imageB64,
      systemPrompt,
      locale: input.locale ?? "zh-CN",
      imageCaption: input.imageCaption,
      latitude: input.latitude,
      longitude: input.longitude,
      birthday: input.birthday,
      agentId: input.agentId,
      qualityMode: input.qualityMode,
    });
    raw.agent_id = input.agentId;
    if (input.agentId === AgentId.PALM_READER) {
      normalizePalmReadingRaw(raw);
    }
    const parsed = structuredInsightSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `洞察结构校验失败: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    // 几何 path 在 pipeline 层注入；此处只做文案兜底
    if (input.agentId === AgentId.PALM_READER) {
      return sanitizePalmInsight(parsed.data);
    }
    return parsed.data;
  }
}

export function parseAgentOverride(
  value?: string | null,
): AgentId | undefined {
  if (!value) return undefined;
  const parsed = agentIdSchema.safeParse(value);
  if (!parsed.success) {
    console.warn(
      `[analyze] unknown agent_override="${value}", falling back to auto route`,
    );
    return undefined;
  }
  return parsed.data;
}

export const sceneRouter = new SceneRouter();
export const insightPlanner = new InsightPlanner();
