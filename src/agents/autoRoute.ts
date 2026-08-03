import { AgentId } from "../schemas/insight.js";

/**
 * 相机「自动」模式可路由到的专项 Agent（与 mobile cameraModes 菜单对齐）。
 * 已下线入口（art_critic / design_critic / text_reader）不在此列。
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

/** 历史/下线 Agent → 当前可用专项 */
const OFFLINE_AGENT_REMAP: Partial<Record<AgentId, AgentId>> = {
  [AgentId.ART_CRITIC]: AgentId.GENERAL_CURIOSITY,
  [AgentId.DESIGN_CRITIC]: AgentId.GENERAL_CURIOSITY,
  [AgentId.TEXT_READER]: AgentId.GENERAL_CURIOSITY,
};

type CaptionRule = {
  agent: AgentId;
  /** 高置信关键词；命中则在 LLM 落到 curiosity 时抬升 */
  pattern: RegExp;
};

/**
 * 描述关键词兜底：仅在路由结果偏弱（curiosity / 下线 remap）时启用，
 * 避免覆盖 LLM 已给出的明确专项选择。
 */
const CAPTION_HINTS: CaptionRule[] = [
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
      /药盒|药品说明|用法用量|不良反应|适应症|胶囊|片剂|mg\b|tablet|capsule|drug\s*facts|package\s*insert/i,
  },
  {
    agent: AgentId.MENU_TRANSLATOR,
    pattern: /菜单|menu\b|菜名|品目|おすすめ|ランチ|定食|刺身|价目表|wine\s*list/i,
  },
  {
    agent: AgentId.PALM_READER,
    pattern: /掌心|掌纹|手相|手掌特写|palm\s*(print|line|reading)|open\s*palm/i,
  },
  {
    agent: AgentId.FOOD_EXPLORER,
    pattern:
      /零食|薯片|巧克力棒|糖果袋|配料表|nutrition\s*facts|ingredients?\s*:|snack\s*(pack|bag)|包装袋/i,
  },
  {
    agent: AgentId.FOOD_SCAN,
    pattern:
      /盘装|碗装|餐盘|正餐|外卖餐|套餐|沙拉碗|米饭|面条|plated\s*(meal|food)|bowl\s*of/i,
  },
  {
    agent: AgentId.SIGHT_ROUTE,
    pattern: /导览图|游览图|路线图|一日游|景点地图|tourist\s*map|itinerary/i,
  },
  {
    agent: AgentId.STYLIST,
    pattern: /穿搭|全身照|outfit|street\s*style|服装搭配/i,
  },
];

function isAutoRouteAgent(id: string): id is AutoRouteAgentId {
  return AUTO_ROUTE_SET.has(id);
}

function hintFromCaption(caption: string | null | undefined): AgentId | null {
  if (!caption?.trim()) return null;
  for (const rule of CAPTION_HINTS) {
    if (rule.pattern.test(caption)) return rule.agent;
  }
  return null;
}

/**
 * 将分类器推荐收束到菜单可用 Agent；弱结果时用 caption 关键词抬升专项。
 */
export function resolveAutoRouteAgent(
  recommended: AgentId | string | null | undefined,
  caption?: string | null,
): AgentId {
  const raw = (recommended ?? AgentId.GENERAL_CURIOSITY) as AgentId;
  const remapped = OFFLINE_AGENT_REMAP[raw] ?? raw;
  const base = isAutoRouteAgent(remapped)
    ? remapped
    : AgentId.GENERAL_CURIOSITY;

  if (base !== AgentId.GENERAL_CURIOSITY) {
    return base;
  }

  return hintFromCaption(caption) ?? AgentId.GENERAL_CURIOSITY;
}
