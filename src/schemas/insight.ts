import { z } from "zod";

export const AgentId = {
  LOCAL_GUIDE: "local_guide",
  ART_CRITIC: "art_critic",
  DESIGN_CRITIC: "design_critic",
  STYLIST: "stylist",
  FOOD_EXPLORER: "food_explorer",
  FOOD_SCAN: "food_scan",
  TEXT_READER: "text_reader",
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
  "text_reader",
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
