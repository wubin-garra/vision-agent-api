import OpenAI from "openai";

import {
  FOLLOWUP_SYSTEM,
  FOOD_SCAN_FOLLOWUP_SYSTEM,
  ROUTER_SYSTEM,
} from "../agents/prompts.js";
import { settings } from "../config.js";
import {
  buildAnalyzeUserText,
  buildFollowupUserText,
} from "./context.js";
import { visionService } from "./vision.js";

function stripCodeFence(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return cleaned.trim();
}

/** 尝试修复因 max_tokens 截断导致未闭合的 JSON（尽力而为） */
function repairTruncatedJson(text: string): string {
  let s = text.trim();
  if (!s) return "{}";

  // 若在字符串中间被截断，先闭合引号
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
  }
  if (inString) s += '"';

  const stack: string[] = [];
  inString = false;
  escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  // 去掉尾部悬空逗号
  s = s.replace(/,\s*$/, "");
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }
  return s;
}

function extractJson(text: string): Record<string, unknown> {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (firstError) {
    try {
      return JSON.parse(repairTruncatedJson(cleaned)) as Record<string, unknown>;
    } catch {
      const preview = cleaned.slice(0, 240).replace(/\s+/g, " ");
      throw new Error(
        `模型返回了不完整或非法 JSON（常因输出被截断）。片段: ${preview}…` +
          ` 原始错误: ${firstError instanceof Error ? firstError.message : String(firstError)}`,
      );
    }
  }
}

function analyzeMaxTokens(agentId?: string): number {
  if (agentId === "food_scan" || agentId === "food_explorer") return 3500;
  return 2200;
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
    retryOnTruncation?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.client) {
      throw new Error("LLM client not configured");
    }

    const runOnce = async (
      userText: string,
      maxTokens: number,
    ): Promise<{
      data: Record<string, unknown>;
      finishReason: string | null | undefined;
    }> => {
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: userText },
      ];

      let response: OpenAI.Chat.ChatCompletion;
      try {
        response = await this.client!.chat.completions.create({
          model: input.model,
          messages,
          response_format: { type: "json_object" },
          max_tokens: maxTokens,
          ...this.completionExtra(),
        });
      } catch {
        response = await this.client!.chat.completions.create({
          model: input.model,
          messages,
          max_tokens: maxTokens,
          ...this.completionExtra(),
        });
      }

      const choice = response.choices[0];
      const content = choice?.message?.content ?? "{}";
      return {
        data: extractJson(content),
        finishReason: choice?.finish_reason,
      };
    };

    try {
      const first = await runOnce(input.userText, input.maxTokens);
      if (
        input.retryOnTruncation &&
        first.finishReason === "length"
      ) {
        // 虽可能已修复截断 JSON，但仍再请求一次更精简的完整输出
        const retry = await runOnce(
          input.userText +
            "\n\n注意：请输出更精简但仍完整合法的 JSON，务必闭合所有字符串与括号，不要截断。",
          Math.min(input.maxTokens + 1000, 4500),
        );
        return retry.data;
      }
      return first.data;
    } catch (err) {
      if (!input.retryOnTruncation) throw err;
      const retry = await runOnce(
        input.userText +
          "\n\n注意：上次 JSON 解析失败。请重新输出完整合法 JSON，字段尽量精简，务必闭合所有字符串与括号。",
        Math.min(input.maxTokens + 1000, 4500),
      );
      return retry.data;
    }
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
    agentId?: string;
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
      maxTokens: analyzeMaxTokens(input.agentId),
      retryOnTruncation: true,
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
      if (input.agentId === "food_scan") {
        return this.demoFoodScanFollowup(input.question);
      }
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

    const isFoodScan = input.agentId === "food_scan";
    return this.chatJson({
      model: settings.llmModel,
      systemPrompt: isFoodScan ? FOOD_SCAN_FOLLOWUP_SYSTEM : FOLLOWUP_SYSTEM,
      userText,
      maxTokens: isFoodScan ? 3500 : 1500,
      retryOnTruncation: true,
    });
  }

  private demoFoodScanFollowup(question: string): Record<string, unknown> {
    return {
      answer:
        `这餐以虾仁、金枪鱼、鸡蛋和牛油果为主，蛋白质来源丰富，` +
        `整体适合减脂期适量食用。关于「${question}」：注意控制油浸金枪鱼与酱料钠含量。`,
      structured_answer: {
        summary:
          "这餐以虾仁、金枪鱼、鸡蛋和牛油果为主，蛋白质来源丰富，" +
          "整体适合减脂期适量食用，但需注意调味与碳水比例。",
        sections: [
          {
            heading: "减脂期的优劣势分析",
            paragraphs: [
              "虾仁、金枪鱼与鸡蛋提供优质蛋白，牛油果带来健康脂肪；" +
                "若配菜为白米饭，建议替换为糙米或花椰菜饭以降低热量。",
            ],
            assessments: [
              {
                tone: "positive",
                title: "多源蛋白质",
                body: "虾、鱼、蛋组合提供完整氨基酸，有助于维持肌肉量。",
              },
              {
                tone: "positive",
                title: "健康油脂",
                body: "牛油果有助于平衡饱腹感，并减缓碳水消化速度。",
              },
              {
                tone: "warning",
                title: "调味隐患",
                body: "油浸金枪鱼与海苔碎钠含量偏高，可能造成水肿感。",
              },
            ],
            tips: [
              {
                label: "蛋白质比例",
                body: "保留海鲜+鸡蛋组合，金枪鱼优先选水浸款。",
              },
              {
                label: "碳水置换",
                body: "白米饭换糙米或黑米，增加纤维与 B 族维生素。",
              },
            ],
            tips_heading: "优化小窍门",
            tips_lead: "如果你打算长期以此作为减脂餐，可以尝试微调：",
          },
        ],
        metric_card: {
          title: "饱腹感 VS 热量密度",
          sliders: [
            {
              label: "热量密度",
              value: 0.35,
              low_label: "低",
              high_label: "高",
            },
            {
              label: "饱腹感持续",
              value: 0.78,
              low_label: "短",
              high_label: "长",
            },
          ],
          note: "相比高糖甜点，这餐在减脂效率上明显更优。",
        },
        remark: "营养成分为视觉估算，具体数值请以食品标签或专业检测为准。",
        suggestion_groups: [
          {
            title: "进阶减脂建议",
            questions: [
              "水浸和油浸金枪鱼热量差多少？",
              "减脂期适合吃哪些低卡酱料？",
              "牛油果一天吃多少比较合适？",
            ],
          },
          {
            title: "附近健康餐厅",
            questions: ["附近有轻食/低卡餐厅吗？"],
          },
        ],
      },
      suggested_followups: [
        "水浸和油浸金枪鱼热量差多少？",
        "减脂期适合吃哪些低卡酱料？",
        "附近有轻食/低卡餐厅吗？",
      ],
    };
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
