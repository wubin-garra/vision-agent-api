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

/** 结构化字段多的 Agent 提高 max_tokens，避免 dishes / snack_analysis 被截断 */
function analyzeMaxTokens(agentId?: string, qualityMode?: boolean): number {
  const heavy =
    agentId === "food_scan" ||
    agentId === "food_explorer" ||
    agentId === "menu_translator" ||
    agentId === "palm_reader" ||
    agentId === "med_label" ||
    agentId === "sight_route" ||
    agentId === "hotel_guide" ||
    agentId === "flight_info";
  if (qualityMode) {
    return heavy ? 3500 : 2500;
  }
  return heavy ? 2500 : 2000;
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
  // 视觉直出路径的补充指令（与 AGENT_PROMPTS 互补，强调必填结构）
  const snackHint =
    input.agentId === "food_explorer"
      ? "\n\n这是零食分析：仔细读包装上的品名、口味、配料与过敏原。" +
        "必须输出 snack_analysis；看不清的字段用 null/空数组，禁止编造品牌。"
      : "";
  const menuHint =
    input.agentId === "menu_translator"
      ? "\n\n这是菜单翻译：逐条识别可读菜名，填入 menu_translation.dishes（原文+译文）。" +
        "禁止编造看不清的菜名或价格；目标语言跟随 locale。"
      : "";
  const medHint =
    input.agentId === "med_label"
      ? "\n\n这是药品说明：必须输出 med_label_reading；务必从包装可见文字尽量提取 usage（适应症）、dosage/dosage_steps（用法用量）、adverse_reactions（不良反应）、package_insert（说明书要点）、warnings（禁忌）；看不清用 null/空数组，禁止编造医嘱。"
      : "";
  const sightHint =
    input.agentId === "sight_route"
      ? "\n\n这是景点路线：必须输出 sight_route，给出有序 suggested_route 与交通提示。"
      : "";
  const hotelHint =
    input.agentId === "hotel_guide"
      ? "\n\n这是酒店入住：必须输出 hotel_guide；确认号看不清则 null，steps 给出到店步骤。"
      : "";
  const flightHint =
    input.agentId === "flight_info"
      ? "\n\n这是航班信息：必须输出 flight_info；登机口可能变更，提醒以官方为准。"
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
    snackHint +
    menuHint +
    medHint +
    sightHint +
    hotelHint +
    flightHint +
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
      if (input.agentId === "food_explorer") {
        return this.demoSnackInsight();
      }
      if (input.agentId === "menu_translator") {
        return this.demoMenuTranslatorInsight(locale);
      }
      if (input.agentId === "med_label") {
        return this.demoMedLabelInsight();
      }
      if (input.agentId === "sight_route") {
        return this.demoSightRouteInsight();
      }
      if (input.agentId === "hotel_guide") {
        return this.demoHotelGuideInsight();
      }
      if (input.agentId === "flight_info") {
        return this.demoFlightInfoInsight();
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

  /** Demo 模式：零食分析样例（无 LLM 时返回） */
  private demoSnackInsight(): Record<string, unknown> {
    return {
      title: "🧂 海盐脆片轻松解馋",
      subtitle: "薄脆咸香，适合配无糖气泡水",
      category: "薯片 / 咸香",
      confidence: 0.82,
      narrative:
        "你好——这袋海盐味脆片看起来主打干净咸香。薄片分层感强，适合当作电影或加班间隙的小份解馋，别一不小心炫完整袋。",
      visible_clues: ["海盐口味标识", "薯片剪影图案", "净含量标注"],
      context: {
        cultural: "海盐原味薯片是便利店常备基础款，强调原料简单、口味不抢戏。",
        historical: null,
        practical: "开封后尽量当日吃完；配无糖茶或气泡水更清爽。",
      },
      snack_analysis: {
        brand: "示例脆片",
        product_name: "海盐原味薯片",
        snack_type: "薯片",
        taste_tags: ["咸香", "清爽", "酥脆"],
        ingredients_highlight: ["马铃薯", "植物油", "海盐"],
        caution_notes: ["钠含量偏高，建议小份食用", "可能含麸质加工助剂"],
        calories_estimate: "约 140 kcal/30g（估算）",
        serving_tip: "建议一次不超过一小把，搭配无糖饮料",
      },
      flavor_notes: [
        { emoji: "👅", label: "口味", value: "海盐底、余韵干净" },
        { emoji: "🫰", label: "口感", value: "薄脆、分层感强" },
        { emoji: "🧪", label: "配料关注", value: "注意钠与可能的麸质" },
      ],
      allergens: [
        { category: "麸质", detail: "加工过程可能接触小麦", emoji: "🌾" },
      ],
      nearby_picks: [],
      explore_chips: {
        culinary: [
          "配料表里有什么需要注意的？",
          "这份零食热量大概怎么样？",
          "还有哪些类似口味推荐？",
        ],
        nearby: [],
      },
      share_card: {
        headline: "海盐脆片轻松解馋",
        quote: "小份刚刚好，解馋不翻车。",
        cta: "继续拆零食",
      },
      style_vocabulary: ["酥脆", "咸香"],
      suggested_searches: [],
      next_actions: [],
      agent_id: "food_explorer",
      disclaimer: "零食分析与热量估算仅供参考，非营养医疗或过敏诊断建议。",
    };
  }

  /** Demo 模式：翻译师样例，target_language 跟随 locale */
  private demoMenuTranslatorInsight(locale: string): Record<string, unknown> {
    const target = locale.startsWith("zh") ? "中文" : "English";
    return {
      title: "日料菜单速译",
      subtitle: `日文 → ${target}`,
      category: "菜单翻译 / 点餐助手",
      confidence: 0.8,
      narrative:
        "识别到一份偏日料的纸质菜单，已把主要刺身与烤物条目译成你的语言，并标出海鲜相关提示。",
      visible_clues: ["刺身栏", "价位符号 ¥", "「おすすめ」推荐角标"],
      context: {
        cultural: "日料菜单常按刺身、烤物、煮物分区，推荐角标多在当季品。",
        historical: null,
        practical: "海鲜过敏请避开刺身区；想清淡可先从豆腐或蔬菜小碗开始。",
      },
      menu_translation: {
        source_language: "日文",
        target_language: target,
        dishes: [
          {
            original: "まぐろ刺身",
            translation: "金枪鱼刺身",
            price: "¥1,280",
            notes: "生食，份量中等",
            tags: ["海鲜", "推荐"],
          },
          {
            original: "鮭の塩焼き",
            translation: "盐烤三文鱼",
            price: "¥980",
            notes: "烤物，偏咸香",
            tags: ["海鲜"],
          },
          {
            original: "冷奴",
            translation: "冷豆腐",
            price: "¥480",
            notes: "清淡开胃",
            tags: ["素食友好"],
          },
          {
            original: "枝豆",
            translation: "毛豆",
            price: "¥380",
            notes: "小食",
            tags: ["素食友好"],
          },
        ],
        ordering_tips: [
          "海鲜过敏请避开刺身与盐烤三文鱼",
          "想吃清淡：冷豆腐 + 毛豆是稳妥组合",
          "看到「おすすめ」多半是店家主推",
        ],
        dietary_summary: "本页含多道海鲜；素食可选冷豆腐与毛豆。",
      },
      explore_chips: {
        culinary: [
          "哪些适合不能吃海鲜的人？",
          "帮我挑几道清淡的",
          "把整页再译详细一点",
        ],
        nearby: [],
      },
      share_card: {
        headline: "日料菜单速译",
        quote: "先看忌口，再点推荐。",
        cta: "继续翻译",
      },
      style_vocabulary: [],
      suggested_searches: [],
      next_actions: ["按忌口筛选", "推荐 3 道"],
      agent_id: "menu_translator",
      disclaimer: "翻译与点餐提示仅供参考，以店家实际出品与过敏原说明为准。",
    };
  }

  private demoMedLabelInsight(): Record<string, unknown> {
    return {
      title: "布洛芬退烧止痛",
      subtitle: "英文 → 中文",
      category: "药品说明 / 旅行药箱",
      confidence: 0.82,
      narrative: "这是一盒常见的布洛芬类止痛退烧药，包装为英文说明。",
      visible_clues: ["Ibuprofen 200mg", "Pain Reliever", "Keep out of reach of children"],
      context: {
        cultural: null,
        historical: null,
        practical: "出国随身带原包装，过安检保留说明书更稳妥。",
      },
      med_label_reading: {
        drug_name: "Ibuprofen",
        brand: "DemoCare",
        active_ingredients: ["布洛芬 200mg"],
        usage: "用于缓解轻中度疼痛与发热（包装所示）",
        dosage: "成人每 4–6 小时 1 片，24 小时不超过包装上限",
        dosage_steps: [
          "成人：每次 1 片（200mg）",
          "每隔 4–6 小时可重复，24 小时不超过包装标注上限",
          "儿童用量需遵包装或医师指导",
        ],
        adverse_reactions: ["偶见胃部不适", "皮疹等过敏反应（包装警示）"],
        package_insert:
          "本品为非处方止痛退烧药。按包装用法服用，勿与其他含布洛芬产品叠服。胃溃疡、孕妇等特殊人群慎用。室温干燥保存，并置于儿童不能接触处。具体以说明书原文为准。",
        warnings: ["胃溃疡者慎用", "勿与其他含布洛芬产品叠服", "儿童用量需遵包装"],
        storage: "室温干燥处保存",
        translated_summary: "非处方止痛退烧药；先核对用法用量、不良反应与禁忌，不确定请问药师。",
        source_language: "英文",
      },
      explore_chips: {
        culinary: ["用法用量是怎样的？", "有哪些不良反应？", "说明书里还有什么要注意？"],
        nearby: [],
      },
      next_actions: ["核对用法用量", "查看不良反应", "对照说明书原文"],
      agent_id: "med_label",
      disclaimer: "非医疗诊断或用药建议，请遵医嘱与说明书原文。",
    };
  }

  private demoSightRouteInsight(): Record<string, unknown> {
    return {
      title: "旧城区半日路线",
      subtitle: "约 3–4 小时 · 步行友好",
      category: "景点路线 / 旅行规划",
      confidence: 0.8,
      narrative: "画面像欧洲旧城区导览图，适合串一条少回头的半日线。",
      visible_clues: ["古城墙标识", "中央广场", "河边步道"],
      context: {
        cultural: "旧城区多为步行区，街巷适合慢慢拍。",
        historical: null,
        practical: "热门点建议上午进，避开游轮团高峰。",
      },
      sight_route: {
        place_name: "旧城区",
        area: "市中心",
        highlights: [
          { name: "中央广场", tip: "适合拍建筑立面" },
          { name: "河边步道", tip: "日落光线更好" },
          { name: "观景台", tip: "可俯瞰红屋顶" },
        ],
        suggested_route: ["中央广场", "主教堂外立面", "河边步道", "观景台", "回广场咖啡"],
        duration_estimate: "约 3.5 小时（含拍照）",
        transport_tips: ["广场地铁站出站即达", "旧城内建议步行，电瓶车有时段限制"],
        best_time: "上午 9–12 点人少光好",
        ticket_notes: "观景台可能单独购票，现场扫码即可",
      },
      explore_chips: {
        culinary: [],
        nearby: ["附近还有什么值得去？", "下雨天怎么改路线？", "怎么买票最省事？"],
      },
      next_actions: ["优化步行路线", "找附近餐厅"],
      agent_id: "sight_route",
      disclaimer: "开放时间与票务可能变动，请以官方信息为准。",
    };
  }

  private demoHotelGuideInsight(): Record<string, unknown> {
    return {
      title: "市中心酒店入住卡",
      subtitle: "确认号 HX29K · 入住 15:00",
      category: "酒店入住 / 旅行住宿",
      confidence: 0.85,
      narrative: "这是一张酒店确认/入住凭证截图，关键信息比较齐全。",
      visible_clues: ["Hotel Nova", "Confirmation HX29K", "Check-in 15:00"],
      context: {
        cultural: null,
        historical: null,
        practical: "到店先报确认号与姓名；行李可问前台寄存。",
      },
      hotel_guide: {
        hotel_name: "Hotel Nova",
        confirmation_code: "HX29K",
        guest_name: "WANG / LEI",
        check_in: "15:00",
        check_out: "11:00",
        address: "12 River Street",
        room_type: "Queen Room",
        steps: [
          "到大堂前台出示护照与确认号 HX29K",
          "核对入住晚数与房型 Queen Room",
          "领取房卡，问清早餐与 Wi‑Fi",
        ],
        amenities_notes: ["含早餐", "24h 前台"],
        wifi_or_access: "房卡刷电梯；Wi‑Fi 密码向前提取",
        contact: "+1 555 0100",
      },
      explore_chips: {
        culinary: [],
        nearby: ["怎么跟前台用英语说明？", "行李能提前寄放吗？", "附近交通怎么走？"],
      },
      next_actions: ["核对入住时间", "导航到酒店"],
      agent_id: "hotel_guide",
      disclaimer: "以酒店确认邮件/前台信息为准。",
    };
  }

  private demoFlightInfoInsight(): Record<string, unknown> {
    return {
      title: "CA983 上海→洛杉矶",
      subtitle: "T2 出发 · 建议提前 3 小时",
      category: "航班信息 / 登机牌",
      confidence: 0.88,
      narrative: "登机牌信息清晰：国航 CA983，浦东 T2 出发。",
      visible_clues: ["CA983", "PVG T2", "Seat 32A", "Gate H15"],
      context: {
        cultural: null,
        historical: null,
        practical: "国际航班建议提前 3 小时到场，登机口可能变更。",
      },
      flight_info: {
        airline: "中国国际航空",
        flight_number: "CA983",
        passenger: "WANG/LEI",
        booking_ref: "ABCDEF",
        seat: "32A",
        cabin: "Economy",
        departure: {
          airport: "PVG",
          time: "13:20",
          terminal: "T2",
          gate: "H15",
        },
        arrival: {
          airport: "LAX",
          time: "10:05",
          terminal: "TBIT",
          gate: null,
        },
        status_notes: "登机口以机场屏幕为准，可能临时变更",
        timeline_tips: [
          "建议起飞前 3 小时到达机场",
          "值机截止通常在起飞前 60–90 分钟",
          "落地后注意海关与行李转盘信息",
        ],
      },
      explore_chips: {
        culinary: [],
        nearby: ["登机口怎么走？", "建议提前多久到机场？", "延误了怎么办？"],
      },
      next_actions: ["核对登机口", "设置提醒"],
      agent_id: "flight_info",
      disclaimer: "航班动态以航司/机场官方为准，登机口可能随时变更。",
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
