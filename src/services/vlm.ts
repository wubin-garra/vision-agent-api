import OpenAI from "openai";

import {
  FOLLOWUP_SYSTEM,
  FOOD_SCAN_FOLLOWUP_SYSTEM,
  PALM_READER_FOLLOWUP_SYSTEM,
  ROUTER_SYSTEM,
} from "../agents/prompts.js";
import { settings } from "../config.js";
import { extractJson } from "../utils/jsonExtract.js";
import {
  buildAnalyzeUserText,
  buildFollowupUserText,
  formatBirthdayContext,
  formatGeoContext,
} from "./context.js";
import { visionService } from "./vision.js";

function analyzeMaxTokens(agentId?: string, qualityMode?: boolean): number {
  if (qualityMode) {
    if (
      agentId === "food_scan" ||
      agentId === "food_explorer" ||
      agentId === "palm_reader"
    ) {
      return 3500;
    }
    return 2500;
  }
  if (
    agentId === "food_scan" ||
    agentId === "food_explorer" ||
    agentId === "palm_reader"
  ) {
    return 2500;
  }
  return 2000;
}

function buildVisionAnalyzeUserText(input: {
  locale: string;
  latitude?: number | null;
  longitude?: number | null;
  birthday?: string | null;
  agentId?: string;
  imageCaption?: string | null;
}): string {
  const palmHint =
    input.agentId === "palm_reader"
      ? "\n\n这是手相分析：请仔细观察掌心。summary_traits 禁止「未知/未确定/未发现」。" +
        "掌心主体清晰时必须给出具体手型、主线形态与至少一个标记。" +
        "palm_lines 的 path 可省略或给占位；重点写 highlight 与 description。"
      : "";
  const captionHint = input.imageCaption
    ? `\n参考视觉描述（可校正）：\n${input.imageCaption}\n`
    : "";
  return (
    `Locale: ${input.locale}\n` +
    `${formatGeoContext(input.latitude, input.longitude)}\n` +
    `${formatBirthdayContext(input.birthday)}\n` +
    captionHint +
    palmHint +
    "\n请直接根据图片输出结构化 JSON 洞察。" +
    "只输出合法 JSON，务必闭合所有字符串与括号。"
  );
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
    /** 仅在 JSON 解析失败时重试一次 */
    retryOnParseError?: boolean;
  }): Promise<Record<string, unknown>> {
    if (!this.client) {
      throw new Error("LLM client not configured");
    }

    const runOnce = async (
      userText: string,
      maxTokens: number,
    ): Promise<Record<string, unknown>> => {
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

      const content = response.choices[0]?.message?.content ?? "{}";
      return extractJson(content);
    };

    try {
      return await runOnce(input.userText, input.maxTokens);
    } catch (err) {
      if (!input.retryOnParseError) throw err;
      return runOnce(
        input.userText +
          "\n\n注意：上次 JSON 解析失败。请重新输出完整合法 JSON，字段尽量精简，务必闭合所有字符串与括号。",
        Math.min(input.maxTokens + 500, 3200),
      );
    }
  }

  private async caption(
    imageB64: string,
    locale: string,
    imageBytes?: Buffer,
    mode: "full" | "fast" = "fast",
  ): Promise<string> {
    if (this.demoMode) {
      return "（Demo）一张日常场景照片，包含可识别的物体与细节。";
    }
    return visionService.describeImage(imageB64, locale, imageBytes, mode);
  }

  async analyzeImage(input: {
    imageB64: string;
    systemPrompt: string;
    locale?: string;
    model?: string;
    imageCaption?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    birthday?: string | null;
    agentId?: string;
    /** 专项镜头：优先 DeepSeek 完整输出，不走精简视觉直出 */
    qualityMode?: boolean;
  }): Promise<Record<string, unknown>> {
    const locale = input.locale ?? "zh-CN";
    if (this.demoMode) {
      if (input.agentId === "palm_reader") {
        return this.demoPalmReaderInsight(input.birthday);
      }
      return this.demoInsight(locale);
    }

    const qualityMode = Boolean(input.qualityMode);
    const maxTokens = analyzeMaxTokens(input.agentId, qualityMode);

    // 自动模式：视觉多模态直出
    // 看手相师：必须看图描摹真实掌纹坐标（qualityMode 也不能只走纯文本 LLM）
    // 其他专项 qualityMode：caption + DeepSeek 完整 JSON
    const forceVision =
      input.agentId === "palm_reader" || (!qualityMode && visionService.enabled);

    if (forceVision && visionService.enabled) {
      const userText = buildVisionAnalyzeUserText({
        locale,
        latitude: input.latitude,
        longitude: input.longitude,
        birthday: input.birthday,
        agentId: input.agentId,
        imageCaption: input.imageCaption,
      });
      const runVision = (text: string) =>
        visionService.analyzeImageJson({
          imageB64: input.imageB64,
          systemPrompt: input.systemPrompt,
          userText: text,
          maxTokens,
        });

      try {
        const started = Date.now();
        try {
          const raw = await runVision(userText);
          if (settings.debug) {
            console.log(
              `[analyze] vision oneshot ok in ${Date.now() - started}ms agent=${input.agentId ?? "?"}`,
            );
          }
          return raw;
        } catch (parseErr) {
          const raw = await runVision(
            userText +
              "\n\n注意：上次 JSON 解析失败。请重新输出完整合法 JSON，务必闭合所有字段。",
          );
          if (settings.debug) {
            console.log(
              `[analyze] vision oneshot retry ok in ${Date.now() - started}ms`,
            );
          }
          void parseErr;
          return raw;
        }
      } catch (err) {
        if (settings.debug) {
          console.warn(
            `[analyze] vision oneshot failed, fallback to text LLM:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    }

    const captionMode = qualityMode ? "full" : "fast";
    const caption =
      input.imageCaption ??
      (await this.caption(input.imageB64, locale, undefined, captionMode));
    const userText = buildAnalyzeUserText({
      locale,
      caption,
      latitude: input.latitude,
      longitude: input.longitude,
      birthday: input.birthday,
    });

    if (settings.debug) {
      console.log(
        `[analyze] text LLM qualityMode=${qualityMode} agent=${input.agentId ?? "?"} captionMode=${captionMode}`,
      );
    }

    return this.chatJson({
      model: input.model ?? settings.llmModel,
      systemPrompt: input.systemPrompt,
      userText,
      maxTokens,
      retryOnParseError: true,
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
      input.imageCaption ??
      (await this.caption(input.imageB64, "zh-CN", undefined, "fast"));
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
      if (input.agentId === "palm_reader") {
        return this.demoPalmReaderFollowup(input.question);
      }
      return {
        answer:
          `（Demo 模式）关于「${input.question}」：` +
          `这是基于之前分析「${insightTitle}」的模拟回答。`,
        suggested_followups: ["更多历史背景", "类似风格有哪些", "推荐搜索词"],
      };
    }

    const caption =
      input.imageCaption ??
      (await this.caption(input.imageB64, locale, undefined, "fast"));
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
    const isPalmReader = input.agentId === "palm_reader";
    const systemPrompt = isFoodScan
      ? FOOD_SCAN_FOLLOWUP_SYSTEM
      : isPalmReader
        ? PALM_READER_FOLLOWUP_SYSTEM
        : FOLLOWUP_SYSTEM;
    return this.chatJson({
      model: settings.llmModel,
      systemPrompt,
      userText,
      maxTokens: isFoodScan || isPalmReader ? 3500 : 1500,
      retryOnParseError: true,
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

  private demoPalmReaderInsight(birthday?: string | null): Record<string, unknown> {
    return {
      title: "沉稳的远见者",
      subtitle: "在动荡中保持内心秩序",
      category: "手相解读 / 性格运势",
      confidence: 0.82,
      narrative:
        "你的手掌宽厚且纹路清晰，展现出一种在动荡中依然能保持内心秩序的罕见力量。",
      visible_clues: ["掌形宽厚", "主线清晰深长", "感情线末端趋平"],
      context: {
        cultural: "掌纹解读在东亚与西方皆有自我觉察传统。",
        historical: null,
        practical: "把年龄节点当作内省提醒，而非固定剧本。",
      },
      palm_reading: {
        birthday: birthday ?? null,
        zodiac: birthday ? "摩羯座" : null,
        summary_traits: [
          { label: "手型", value: "土型掌—务实且极具耐力" },
          { label: "核心纹路", value: "智慧线平直，逻辑极强" },
          { label: "独特标记", value: "木星丘饱满，具领导潜质" },
        ],
        insight_quote:
          "你并不急于向世界证明什么，因为你深知，真正的力量往往在沉默的坚持中悄然生长。",
        palm_lines: [
          {
            id: "heart",
            name: "感情线",
            color: "#E85D5D",
            highlight: "32岁左右情感趋于稳固",
            description:
              "感情线末端趋平，指向食指与中指之间，显示你在情感上理性克制。这种纹路预示三十岁初将迎来从追求激情，到追求精神契合长期陪伴的深刻整合。",
            path: [
              { x: 28, y: 22 },
              { x: 48, y: 20 },
              { x: 72, y: 24 },
            ],
          },
          {
            id: "head",
            name: "智慧线",
            color: "#4A9FE8",
            highlight: "38岁迎来事业决策巅峰",
            description:
              "智慧线深长清晰，反映你具备极强的专注力与逻辑分析能力。约四十岁前后可能迎来重大事业转向，或显著的社会地位提升。",
            path: [
              { x: 30, y: 38 },
              { x: 55, y: 40 },
              { x: 78, y: 44 },
            ],
          },
          {
            id: "life",
            name: "生命线",
            color: "#3DB88A",
            highlight: "50岁后精力依然充沛",
            description:
              "生命线起点紧凑、末端开阔，早年或有忙碌奔波，但精力与稳定感随年龄增长，晚年生活质量较高。",
            path: [
              { x: 42, y: 28 },
              { x: 34, y: 48 },
              { x: 36, y: 72 },
            ],
          },
          {
            id: "career",
            name: "事业线",
            color: "#F0A04B",
            highlight: "28岁开启独立发展之路",
            description:
              "事业线自掌根清晰上升，越过智慧线后加深，暗示二十年代末找到真正志业，并逐步建立专业影响力。",
            path: [
              { x: 52, y: 78 },
              { x: 54, y: 55 },
              { x: 56, y: 32 },
            ],
          },
        ],
        personality_spectrum: [
          { low_label: "理性冷静", high_label: "感性直觉", value: 0.32 },
          { low_label: "务实稳健", high_label: "自由随性", value: 0.4 },
        ],
        compatibility_teaser: "看看你和重要的人有多匹配",
      },
      explore_chips: {
        culinary: [
          "我的感情线说明什么？",
          "事业线高峰会在什么时候？",
          "结合星座再解读一次",
        ],
        nearby: [],
      },
      share_card: {
        headline: "沉稳的远见者",
        quote:
          "真正的力量往往在沉默的坚持中悄然生长。",
        cta: "继续看见自己",
      },
      style_vocabulary: ["远见", "克制", "秩序"],
      suggested_searches: [],
      next_actions: [],
      agent_id: "palm_reader",
      disclaimer: "手相解读仅供娱乐与自我觉察参考，非命运预言或专业命理鉴定。",
    };
  }

  private demoPalmReaderFollowup(question: string): Record<string, unknown> {
    return {
      answer:
        `关于「${question}」：你的感情线末端趋平，显示理性克制；` +
        "三十岁初更可能追求精神契合的长期关系。",
      structured_answer: {
        summary:
          "感情线末端趋平并指向食指与中指之间，说明你在情感上理性而克制，" +
          "更重视长期精神契合而非短暂热情。",
        sections: [
          {
            heading: "感情线的深层含义",
            paragraphs: [
              "这种纹路常对应「慢热」与边界清晰：你不会轻易交托信任，但一旦确认，陪伴会很稳。",
            ],
            assessments: [
              {
                tone: "positive",
                title: "情感边界清晰",
                body: "不易被情绪裹挟，关系中更有安全感。",
              },
              {
                tone: "warning",
                title: "表达偏克制",
                body: "对方可能误读为疏离，适时用语言确认很重要。",
              },
            ],
            tips_heading: "觉察小提示",
            tips_lead: "你可以这样理解：",
            tips: [
              {
                label: "关系节奏",
                body: "允许自己慢一点，用行动而非宣言建立信任。",
              },
            ],
          },
        ],
        metric_card: {
          title: "性格光谱",
          sliders: [
            {
              label: "理性 ↔ 感性",
              value: 0.32,
              low_label: "理性",
              high_label: "感性",
            },
          ],
          note: "当前更偏理性冷静，适合用结构化沟通表达心意。",
        },
        remark: "手相解读仅供娱乐与自我觉察参考。",
        suggestion_groups: [
          {
            title: "继续探索",
            questions: ["事业线高峰会在什么时候？", "结合星座再解读一次"],
          },
        ],
      },
      suggested_followups: [
        "事业线高峰会在什么时候？",
        "结合星座再解读一次",
        "生命线说明我精力如何？",
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
