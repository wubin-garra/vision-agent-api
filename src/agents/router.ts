import { AGENT_PROMPTS, SCENE_TO_AGENT } from "./prompts.js";
import {
  AgentId,
  agentIdSchema,
  sceneClassificationSchema,
  structuredInsightSchema,
  type StructuredInsight,
} from "../schemas/insight.js";
import { vlmService } from "../services/vlm.js";

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
    });
    raw.agent_id = input.agentId;
    return structuredInsightSchema.parse(raw);
  }
}

export function parseAgentOverride(
  value?: string | null,
): AgentId | undefined {
  if (!value) return undefined;
  const parsed = agentIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export const sceneRouter = new SceneRouter();
export const insightPlanner = new InsightPlanner();
