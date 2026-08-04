import { AgentId, type StructuredInsight } from "../schemas/insight.js";
import { NON_EDIBLE_PRODUCT_HINT } from "./autoRoute.js";

/**
 * 食品 Agent 安全兜底：若 caption/模型输出暴露出日化/危险化学品特征，
 * 强制改写为「不可食用」警示，绝不能当零食/餐食给热量。
 */
export function sanitizeFoodSafetyInsight(
  insight: StructuredInsight,
  caption?: string | null,
): StructuredInsight {
  if (
    insight.agent_id !== AgentId.FOOD_EXPLORER &&
    insight.agent_id !== AgentId.FOOD_SCAN
  ) {
    return insight;
  }

  const blob = [
    caption ?? "",
    insight.title ?? "",
    insight.subtitle ?? "",
    insight.category ?? "",
    insight.narrative ?? "",
    ...(insight.visible_clues ?? []),
    insight.snack_analysis?.product_name ?? "",
    insight.snack_analysis?.snack_type ?? "",
    ...(insight.snack_analysis?.ingredients_highlight ?? []),
    ...(insight.snack_analysis?.caution_notes ?? []),
  ].join("\n");

  if (!NON_EDIBLE_PRODUCT_HINT.test(blob)) {
    return insight;
  }

  const productGuess =
    insight.snack_analysis?.product_name?.trim() ||
    insight.title?.replace(/^[^\w\u4e00-\u9fff]+/, "").trim() ||
    "日化/清洁类产品";

  return {
    ...insight,
    title: `⚠️ 不可食用 · ${productGuess}`,
    subtitle: "这不是食品，请勿入口",
    category: "非食品 / 日化清洁",
    confidence: Math.min(insight.confidence ?? 0.5, 0.35),
    narrative:
      "包装形态可能像零食袋，但文字与成分显示这是清洁/管道疏通等日化产品，含腐蚀性或刺激性化学成分。" +
      "严禁入口、勿当汤包或零食；沾到皮肤请立即冲洗，误食请尽快就医并携带包装。",
    visible_clues: [
      "包装含使用方法/注意事项等非食品说明",
      "可能出现腐蚀、管道、疏通、表面活性剂等字样",
      "适用范围常含马桶/水槽/地漏等图标",
    ],
    context: {
      cultural: null,
      historical: null,
      practical: "按说明书用于管道清洁；佩戴防护，远离儿童与食品区存放。",
    },
    snack_analysis:
      insight.agent_id === AgentId.FOOD_EXPLORER
        ? {
            brand: insight.snack_analysis?.brand ?? null,
            product_name: productGuess,
            snack_type: "非食品",
            taste_tags: [],
            ingredients_highlight: ["化学清洁成分（非食用）"],
            caution_notes: [
              "严禁入口，误食有生命危险",
              "具腐蚀性/刺激性，避免皮肤与眼睛接触",
              "勿与酸性清洁剂混用",
            ],
            calories_estimate: "不可食用，无热量意义",
            serving_tip: "这不是食品，请勿食用",
          }
        : null,
    nutrition: null,
    diet_summary: null,
    nutrition_tips: [],
    flavor_notes: [
      {
        emoji: "☠️",
        label: "安全",
        value: "非食品化学品，严禁入口",
      },
      {
        emoji: "🧤",
        label: "防护",
        value: "使用时戴手套/口罩，注意通风",
      },
    ],
    allergens: [],
    explore_chips: {
      culinary: ["这是什么产品？", "使用时要注意什么？"],
      nearby: [],
    },
    share_card: {
      headline: "危险：非食品",
      quote: "看起来像零食袋，其实可能是清洁剂——请先读包装。",
      cta: "了解安全提示",
    },
    disclaimer:
      "本结果为安全警示：该物品疑似不可食用日化产品。若已误食或接触，请立即就医并出示包装。非医疗诊断。",
    next_actions: ["仔细阅读包装警示", "勿入口", "远离儿童与食品"],
  };
}
