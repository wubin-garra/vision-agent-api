import { AgentId } from "../schemas/insight.js";

/**
 * 相机「自动」模式可路由到的专项 Agent（与 mobile cameraModes 菜单对齐）。
 * 已下线入口（art_critic / text_reader）不在此列。
 */
export const AUTO_ROUTE_AGENTS = [
  AgentId.FLIGHT_INFO,
  AgentId.HOTEL_GUIDE,
  AgentId.MED_LABEL,
  AgentId.MENU_TRANSLATOR,
  AgentId.FOOD_SCAN,
  AgentId.FOOD_EXPLORER,
  AgentId.PALM_READER,
  AgentId.STYLIST,
  AgentId.SIGHT_ROUTE,
  AgentId.LOCAL_GUIDE,
  AgentId.GENERAL_CURIOSITY,
] as const;

export type AutoRouteAgentId = (typeof AUTO_ROUTE_AGENTS)[number];

const AUTO_ROUTE_SET = new Set<string>(AUTO_ROUTE_AGENTS);

/** 历史/下线/已删 Agent → 当前可用专项 */
const OFFLINE_AGENT_REMAP: Record<string, AgentId> = {
  art_critic: AgentId.GENERAL_CURIOSITY,
  design_critic: AgentId.GENERAL_CURIOSITY,
  text_reader: AgentId.GENERAL_CURIOSITY,
};

/**
 * 自动模式：专项路由最低置信度。
 * 低于此值一律回落 general_curiosity，避免「长得像」就硬塞专项。
 */
export const AUTO_ROUTE_MIN_CONFIDENCE = 0.85;

type CaptionRule = {
  agent: AgentId;
  /** 极高置信关键词；仅在 LLM 已落到 curiosity 且把握不足时作抬升 */
  pattern: RegExp;
};

/**
 * 仅保留「几乎不会误伤」的票据/掌纹等硬特征。
 * 故意不含零食/正餐：包装形态太容易和日化清洁剂混淆。
 */
const HIGH_PRECISION_CAPTION_HINTS: CaptionRule[] = [
  {
    agent: AgentId.FLIGHT_INFO,
    pattern:
      /登机牌|登机口|航站楼|航班号|机票|值机|boarding\s*pass|gate\s*[A-Z]?\d+|flight\s*(no\.?|number)/i,
  },
  {
    agent: AgentId.HOTEL_GUIDE,
    pattern:
      /确认号|confirmation\s*(code|no)|check[- ]?in|check[- ]?out|入住凭证|退房时间|hotel\s*(booking|reservation|confirm)/i,
  },
  {
    agent: AgentId.MED_LABEL,
    pattern:
      /药盒|药品说明|用法用量|不良反应|适应症|胶囊|片剂|drug\s*facts|package\s*insert/i,
  },
  {
    agent: AgentId.PALM_READER,
    pattern: /掌心|掌纹|手相|手掌特写|palm\s*(print|line|reading)|open\s*palm/i,
  },
  {
    agent: AgentId.MENU_TRANSLATOR,
    pattern: /菜单|menu\b|价目表|wine\s*list|おすすめ|ランチ|定食/i,
  },
];

/** 不可食用 / 日化 / 危险化学品：禁止进入任何食品 Agent */
export const NON_EDIBLE_PRODUCT_HINT =
  /疏通|管道|下水道|地漏|马桶|腐蚀|清洁剂|洗涤剂|消毒液|漂白剂|杀虫|鼠药|农药|过碳酸|表面活性剂|助洗剂|不可食用|严禁入口|有毒|强碱|强酸|drain\s*(cleaner|opener)|caustic|corrosive|poison|toilet\s*bowl|floor\s*drain/i;

/** 可食用零食的强证据（避免「包装袋」 alone 误伤） */
const EDIBLE_SNACK_HINT =
  /零食|薯片|膨化|巧克力|糖果|软糖|坚果|饼干|威化|果干|牛肉干|海苔|nutrition\s*facts|配料表.*(?:食品|食用)|食用.*配料|净含量.*g.*(?:食品|零食)|snack\s*(pack|bag|food)/i;

/** 盘装/碗装正餐强证据 */
const PLATED_MEAL_HINT =
  /盘装|碗装|餐盘|白盘|瓷盘|正餐|外卖餐|套餐|沙拉碗|米饭|烩饭|risotto|炒饭|面条|意面|pasta|plated\s*(meal|food)|bowl\s*of|一盘|一碗|餐食|料理/i;

function isAutoRouteAgent(id: string): id is AutoRouteAgentId {
  return AUTO_ROUTE_SET.has(id);
}

function hintFromCaption(caption: string | null | undefined): AgentId | null {
  if (!caption?.trim()) return null;
  for (const rule of HIGH_PRECISION_CAPTION_HINTS) {
    if (rule.pattern.test(caption)) return rule.agent;
  }
  return null;
}

function isFoodAgent(id: AgentId): boolean {
  return id === AgentId.FOOD_EXPLORER || id === AgentId.FOOD_SCAN;
}

/**
 * 将分类器推荐收束到菜单可用 Agent。
 * 原则：自动模式默认 general_curiosity；专项仅在高置信或 caption 硬证据时采用。
 */
export function resolveAutoRouteAgent(
  recommended: AgentId | string | null | undefined,
  caption?: string | null,
  routeConfidence?: number | null,
): AgentId {
  const raw = String(recommended ?? AgentId.GENERAL_CURIOSITY);
  const remapped = OFFLINE_AGENT_REMAP[raw] ?? (raw as AgentId);
  const base = isAutoRouteAgent(remapped)
    ? remapped
    : AgentId.GENERAL_CURIOSITY;

  const text = caption?.trim() ?? "";
  const captionHint = hintFromCaption(caption);
  const conf =
    typeof routeConfidence === "number" && Number.isFinite(routeConfidence)
      ? routeConfidence
      : null;
  const highConfidence = conf !== null && conf >= AUTO_ROUTE_MIN_CONFIDENCE;

  // 安全：日化/危险化学品绝不能进食品 Agent
  if (text && NON_EDIBLE_PRODUCT_HINT.test(text) && isFoodAgent(base)) {
    return AgentId.GENERAL_CURIOSITY;
  }

  // 食品专项：必须有可食用/正餐强证据（防「像零食袋」的清洁剂）
  if (base === AgentId.FOOD_EXPLORER) {
    if (!text || !EDIBLE_SNACK_HINT.test(text) || NON_EDIBLE_PRODUCT_HINT.test(text)) {
      return AgentId.GENERAL_CURIOSITY;
    }
  }
  if (base === AgentId.FOOD_SCAN) {
    if (!text || !PLATED_MEAL_HINT.test(text) || NON_EDIBLE_PRODUCT_HINT.test(text)) {
      return AgentId.GENERAL_CURIOSITY;
    }
  }

  if (base === AgentId.GENERAL_CURIOSITY) {
    // 仅用极高置信 caption 硬特征抬升；不抬食品专项
    if (
      captionHint &&
      !isFoodAgent(captionHint) &&
      !(text && NON_EDIBLE_PRODUCT_HINT.test(text))
    ) {
      return captionHint;
    }
    return AgentId.GENERAL_CURIOSITY;
  }

  // 专项采用条件：高置信，或 caption 硬证据与推荐一致，或食品已过强证据关
  const captionConfirms = captionHint === base;
  const foodEvidenceOk = isFoodAgent(base); // 上面已校验
  if (highConfidence || captionConfirms || (foodEvidenceOk && conf === null)) {
    return base;
  }

  return AgentId.GENERAL_CURIOSITY;
}
