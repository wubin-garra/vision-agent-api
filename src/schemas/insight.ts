import { z } from "zod";

export const AgentId = {
  LOCAL_GUIDE: "local_guide",
  ART_CRITIC: "art_critic",
  DESIGN_CRITIC: "design_critic",
  STYLIST: "stylist",
  FOOD_EXPLORER: "food_explorer",
  FOOD_SCAN: "food_scan",
  PALM_READER: "palm_reader",
  TEXT_READER: "text_reader",
  MENU_TRANSLATOR: "menu_translator",
  GENERAL_CURIOSITY: "general_curiosity",
} as const;

export type AgentId = (typeof AgentId)[keyof typeof AgentId];

export const agentIdSchema = z.enum([
  "local_guide",
  "art_critic",
  "design_critic",
  "stylist",
  "food_explorer",
  "food_scan",
  "palm_reader",
  "text_reader",
  "menu_translator",
  "general_curiosity",
]);

export const SceneType = {
  LANDMARK_STREET: "landmark_street",
  ARTWORK: "artwork",
  OUTFIT: "outfit",
  FOOD: "food",
  TEXT_HEAVY: "text_heavy",
  PRODUCT_DESIGN: "product_design",
  GENERAL: "general",
} as const;

export type SceneType = (typeof SceneType)[keyof typeof SceneType];

export const sceneTypeSchema = z.enum([
  "landmark_street",
  "artwork",
  "outfit",
  "food",
  "text_heavy",
  "product_design",
  "general",
]);

export const insightContextSchema = z.object({
  cultural: z.string().nullish(),
  historical: z.string().nullish(),
  practical: z.string().nullish(),
});

export const flavorNoteSchema = z.object({
  label: z.string(),
  value: z.string(),
  emoji: z.string().nullish(),
});

export const nearbyPickSchema = z.object({
  name: z.string(),
  blurb: z.string().default(""),
});

export const exploreChipsSchema = z.object({
  culinary: z.array(z.string()).default([]),
  nearby: z.array(z.string()).default([]),
});

export const shareCardSchema = z.object({
  headline: z.string().default(""),
  quote: z.string().default(""),
  cta: z.string().default(""),
});

export const nutritionMacroSchema = z.object({
  current: z.number(),
  goal: z.number(),
  unit: z.string().default("g"),
  emoji: z.string().nullish(),
});

export const nutritionProfileSchema = z.object({
  calories_current: z.number().int(),
  calories_goal: z.number().int().default(2000),
  carbs: nutritionMacroSchema,
  fat: nutritionMacroSchema,
  protein: nutritionMacroSchema,
});

export const allergenItemSchema = z.object({
  category: z.string(),
  detail: z.string(),
  emoji: z.string().nullish(),
});

export const nutritionTipSchema = z.object({
  title: z.string(),
  body: z.string(),
});

/** 手相线标注点：相对掌心图百分比坐标 0-100 */
export const palmPointSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
});

/** 把模型偶发的扁平数字 / [x,y] 元组规范成 {x,y}[] */
export function normalizePalmPath(raw: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  // [{x,y}, ...]
  if (
    typeof raw[0] === "object" &&
    raw[0] !== null &&
    ("x" in (raw[0] as object) || "y" in (raw[0] as object))
  ) {
    return raw
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        const o = p as Record<string, unknown>;
        const x = Number(o.x);
        const y = Number(o.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          x: Math.min(100, Math.max(0, x)),
          y: Math.min(100, Math.max(0, y)),
        };
      })
      .filter((p): p is { x: number; y: number } => p !== null);
  }

  // [[x,y], [x,y], ...]
  if (Array.isArray(raw[0])) {
    return raw
      .map((pair) => {
        if (!Array.isArray(pair) || pair.length < 2) return null;
        const x = Number(pair[0]);
        const y = Number(pair[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          x: Math.min(100, Math.max(0, x)),
          y: Math.min(100, Math.max(0, y)),
        };
      })
      .filter((p): p is { x: number; y: number } => p !== null);
  }

  // [x0,y0,x1,y1,...] 扁平数字
  if (typeof raw[0] === "number" || typeof raw[0] === "string") {
    const nums = raw.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    const points: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      points.push({
        x: Math.min(100, Math.max(0, nums[i]!)),
        y: Math.min(100, Math.max(0, nums[i + 1]!)),
      });
    }
    return points;
  }

  return [];
}

export const palmLineSchema = z.object({
  id: z.enum(["heart", "head", "life", "career"]),
  name: z.string(),
  color: z.string().default("#4A9FE8"),
  /** 一句年龄/命运高光，如「32岁左右情感趋于稳固」 */
  highlight: z.string(),
  description: z.string(),
  /** 用于叠加虚线轨迹的相对坐标（约 3-6 点） */
  path: z.preprocess(normalizePalmPath, z.array(palmPointSchema)).default([]),
});

export const personalitySliderSchema = z.object({
  low_label: z.string(),
  high_label: z.string(),
  value: z.number().min(0).max(1),
});

/** Chance 摘要特质：手型 / 核心纹路 / 独特标记 */
export const palmSummaryTraitSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const palmReadingSchema = z.object({
  birthday: z.string().nullish(),
  zodiac: z.string().nullish(),
  insight_quote: z.string().nullish(),
  /** Chance 顶部摘要卡，建议 3 条：手型、核心纹路、独特标记 */
  summary_traits: z.array(palmSummaryTraitSchema).default([]),
  palm_lines: z.array(palmLineSchema).default([]),
  personality_spectrum: z.array(personalitySliderSchema).default([]),
  compatibility_teaser: z.string().nullish(),
});

/** 翻译师：单道菜/条目对照 */
export const menuDishSchema = z.object({
  original: z.string(),
  translation: z.string(),
  price: z.string().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).default([]),
});

export const menuTranslationSchema = z.object({
  source_language: z.string().default(""),
  target_language: z.string().default(""),
  dishes: z.array(menuDishSchema).default([]),
  ordering_tips: z.array(z.string()).default([]),
  dietary_summary: z.string().nullish(),
});

/** 零食分析：包装/小食结构化摘要 */
export const snackAnalysisSchema = z.object({
  brand: z.string().nullish(),
  product_name: z.string().nullish(),
  snack_type: z.string().default(""),
  taste_tags: z.array(z.string()).default([]),
  ingredients_highlight: z.array(z.string()).default([]),
  caution_notes: z.array(z.string()).default([]),
  calories_estimate: z.string().nullish(),
  serving_tip: z.string().nullish(),
});

export const structuredInsightSchema = z.object({
  title: z.string(),
  category: z.string(),
  confidence: z.number().min(0).max(1).default(0.5),
  visible_clues: z.array(z.string()).default([]),
  context: insightContextSchema.default({}),
  style_vocabulary: z.array(z.string()).default([]),
  suggested_searches: z.array(z.string()).default([]),
  next_actions: z.array(z.string()).default([]),
  agent_id: agentIdSchema.default("general_curiosity"),
  disclaimer: z.string().default("非鉴定/医疗/法律建议，仅供参考。"),
  subtitle: z.string().nullish(),
  narrative: z.string().nullish(),
  flavor_notes: z.array(flavorNoteSchema).default([]),
  nearby_picks: z.array(nearbyPickSchema).default([]),
  explore_chips: exploreChipsSchema.default({ culinary: [], nearby: [] }),
  share_card: shareCardSchema.nullish(),
  nutrition: nutritionProfileSchema.nullish(),
  allergens: z.array(allergenItemSchema).default([]),
  nutrition_tips: z.array(nutritionTipSchema).default([]),
  diet_summary: z.string().nullish(),
  palm_reading: palmReadingSchema.nullish(),
  menu_translation: menuTranslationSchema.nullish(),
  snack_analysis: snackAnalysisSchema.nullish(),
});

export type StructuredInsight = z.infer<typeof structuredInsightSchema>;

export const sceneClassificationSchema = z.object({
  scene_type: sceneTypeSchema,
  text_density: z.string().default("none"),
  has_person: z.boolean().default(false),
  recommended_agent: agentIdSchema.default("general_curiosity"),
  reasoning: z.string().default(""),
});

export type SceneClassification = z.infer<typeof sceneClassificationSchema>;

export const followUpAssessmentItemSchema = z.object({
  tone: z.enum(["positive", "warning"]),
  title: z.string(),
  body: z.string(),
});

export const followUpTipSchema = z.object({
  label: z.string(),
  body: z.string(),
});

export const followUpSectionSchema = z.object({
  heading: z.string(),
  paragraphs: z.array(z.string()).default([]),
  assessments: z.array(followUpAssessmentItemSchema).default([]),
  tips_heading: z.string().nullish().default("优化小窍门"),
  tips_lead: z.string().nullish(),
  tips: z.array(followUpTipSchema).default([]),
});

export const followUpMetricSliderSchema = z.object({
  label: z.string(),
  value: z.number().min(0).max(1),
  low_label: z.string(),
  high_label: z.string(),
});

export const followUpMetricCardSchema = z.object({
  title: z.string(),
  sliders: z.array(followUpMetricSliderSchema).default([]),
  note: z.string().nullish(),
});

export const followUpSuggestionGroupSchema = z.object({
  title: z.string(),
  questions: z.array(z.string()).default([]),
});

export const structuredFollowUpAnswerSchema = z.object({
  summary: z.string(),
  sections: z.array(followUpSectionSchema).default([]),
  metric_card: followUpMetricCardSchema.nullish(),
  remark: z.string().nullish(),
  suggestion_groups: z.array(followUpSuggestionGroupSchema).default([]),
});

export type StructuredFollowUpAnswer = z.infer<
  typeof structuredFollowUpAnswerSchema
>;

export const followUpRequestSchema = z.object({
  memory_id: z.string().min(1),
  question: z.string().min(1),
  locale: z.string().default("zh-CN"),
  latitude: z.number().finite().optional(),
  longitude: z.number().finite().optional(),
});

export type FollowUpRequest = z.infer<typeof followUpRequestSchema>;

export const followUpResponseSchema = z.object({
  memory_id: z.string(),
  answer: z.string(),
  structured_answer: structuredFollowUpAnswerSchema.nullish(),
  suggested_followups: z.array(z.string()).default([]),
});

export type FollowUpResponse = z.infer<typeof followUpResponseSchema>;

export const memoryItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.string(),
  agent_id: agentIdSchema,
  image_url: z.string(),
  thumbnail_url: z.string(),
  insight: structuredInsightSchema,
  created_at: z.string(),
  locale: z.string(),
});

export type MemoryItem = z.infer<typeof memoryItemSchema>;

export const memoryListResponseSchema = z.object({
  items: z.array(memoryItemSchema),
  total: z.number(),
});

export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const ttsRequestSchema = z.object({
  text: z.string().min(1),
  locale: z.string().default("zh-CN"),
});

export const sharePosterRequestSchema = z.object({
  memory_id: z.string().min(1),
  title: z.string().default(""),
  category: z.string().default(""),
  summary: z.string().default(""),
});
