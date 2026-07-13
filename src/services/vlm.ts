import OpenAI from "openai";

import { FOLLOWUP_SYSTEM, ROUTER_SYSTEM } from "../agents/prompts.js";
import { settings } from "../config.js";
import {
  buildAnalyzeUserText,
  buildFollowupUserText,
} from "./context.js";
import { visionService } from "./vision.js";

function extractJson(text: string): Record<string, unknown> {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return JSON.parse(cleaned) as Record<string, unknown>;
}

export class VlmService {
  readonly provider = settings.llmProvider;
  readonly demoMode = settings.demoMode;
  private readonly client: OpenAI | null;

  constructor() {
    this.client = settings.llmEnabled
      ? new OpenAI({
          apiKey: settings.llmApiKey,
          baseURL: settings.llmBaseUrl,
        })
      : null;
  }

  private completionExtra(): Record<string, unknown> {
    if (this.provider === "deepseek") {
      return { extra_body: { thinking: { type: "disabled" } } };
    }
    return {};
  }

  private async chatJson(input: {
    model: string;
    systemPrompt: string;
    userText: string;
    maxTokens: number;
  }): Promise<Record<string, unknown>> {
    if (!this.client) {
      throw new Error("LLM client not configured");
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userText },
    ];

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: input.model,
        messages,
        response_format: { type: "json_object" },
        max_tokens: input.maxTokens,
        ...this.completionExtra(),
      });
    } catch {
      response = await this.client.chat.completions.create({
        model: input.model,
        messages,
        max_tokens: input.maxTokens,
        ...this.completionExtra(),
      });
    }

    const content = response.choices[0]?.message?.content ?? "{}";
    return extractJson(content);
  }

  private async caption(
    imageB64: string,
    locale: string,
    imageBytes?: Buffer,
  ): Promise<string> {
    if (this.demoMode) {
      return "（Demo）一张日常场景照片，包含可识别的物体与细节。";
    }
    return visionService.describeImage(imageB64, locale, imageBytes);
  }

  async analyzeImage(input: {
    imageB64: string;
    systemPrompt: string;
    locale?: string;
    model?: string;
    imageCaption?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  }): Promise<Record<string, unknown>> {
    const locale = input.locale ?? "zh-CN";
    if (this.demoMode) {
      return this.demoInsight(locale);
    }

    const caption =
      input.imageCaption ?? (await this.caption(input.imageB64, locale));
    const userText = buildAnalyzeUserText({
      locale,
      caption,
      latitude: input.latitude,
      longitude: input.longitude,
    });

    return this.chatJson({
      model: input.model ?? settings.llmModel,
      systemPrompt: input.systemPrompt,
      userText,
      maxTokens: 1500,
    });
  }

  async classifyScene(input: {
    imageB64: string;
    imageCaption?: string | null;
  }): Promise<Record<string, unknown>> {
    if (this.demoMode) {
      return {
        scene_type: "general",
        text_density: "none",
        has_person: false,
        recommended_agent: "general_curiosity",
        reasoning: "Demo mode default routing",
      };
    }

    const caption =
      input.imageCaption ?? (await this.caption(input.imageB64, "zh-CN"));
    const userText =
      `图片视觉描述：\n${caption}\n\n` + "请根据描述分类场景。只输出 JSON。";

    return this.chatJson({
      model: settings.routerModel,
      systemPrompt: ROUTER_SYSTEM,
      userText,
      maxTokens: 300,
    });
  }

  async followup(input: {
    imageB64: string;
    question: string;
    insight: Record<string, unknown>;
    locale?: string;
    imageCaption?: string | null;
    followupHistory?: Array<Record<string, unknown>>;
    agentId?: string;
    latitude?: number | null;
    longitude?: number | null;
  }): Promise<Record<string, unknown>> {
    const locale = input.locale ?? "zh-CN";
    const insightTitle = String(input.insight.title ?? "");

    if (this.demoMode) {
      return {
        answer:
          `（Demo 模式）关于「${input.question}」：` +
          `这是基于之前分析「${insightTitle}」的模拟回答。`,
        suggested_followups: ["更多历史背景", "类似风格有哪些", "推荐搜索词"],
      };
    }

    const caption =
      input.imageCaption ?? (await this.caption(input.imageB64, locale));
    const userText = buildFollowupUserText({
      locale,
      caption,
      insight: input.insight,
      followupHistory: input.followupHistory ?? [],
      question: input.question,
      agentId: input.agentId ?? "general_curiosity",
      latitude: input.latitude,
      longitude: input.longitude,
    });

    return this.chatJson({
      model: settings.llmModel,
      systemPrompt: FOLLOWUP_SYSTEM,
      userText,
      maxTokens: 1000,
    });
  }

  private demoInsight(locale: string): Record<string, unknown> {
    if (locale.startsWith("zh")) {
      return {
        title: "Art Deco 台灯",
        category: "家具 / 照明",
        confidence: 0.78,
        visible_clues: ["黄铜底座", "几何玻璃灯罩", "1920s 风格线条"],
        context: {
          cultural:
            "Art Deco 运动强调几何对称与奢华材质，常见于 1920–1930 年代。",
          historical: "起源于 1925 年巴黎装饰艺术博览会。",
          practical: "适合作为卧室或书房的阅读灯。",
        },
        style_vocabulary: ["Art Deco", "几何装饰", "Streamline Moderne"],
        suggested_searches: [
          "Art Deco table lamp brass",
          "1920s geometric lamp",
        ],
        next_actions: ["查看相似设计史", "生成分享卡片"],
        agent_id: "design_critic",
        disclaimer: "非鉴定/医疗/法律建议，仅供参考。",
      };
    }

    return {
      title: "Art Deco Table Lamp",
      category: "Furniture / Lighting",
      confidence: 0.78,
      visible_clues: ["Brass base", "Geometric glass shade", "1920s-style lines"],
      context: {
        cultural: "Art Deco emphasizes geometry and luxurious materials.",
        historical: "Originated at the 1925 Paris Exposition.",
        practical: "Works well as a bedside reading lamp.",
      },
      style_vocabulary: ["Art Deco", "Geometric", "Streamline Moderne"],
      suggested_searches: ["Art Deco table lamp brass"],
      next_actions: ["Explore design history", "Create share card"],
      agent_id: "design_critic",
      disclaimer: "Not appraisal, medical, or legal advice.",
    };
  }
}

export const vlmService = new VlmService();
