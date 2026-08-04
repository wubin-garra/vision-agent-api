import { AgentId } from "../schemas/insight.js";
import { NON_EDIBLE_PRODUCT_HINT } from "./autoRoute.js";

export type AgentMismatchInfo = {
  requested_agent: AgentId;
  suggested_agent: AgentId;
  title: string;
  message: string;
  reason: string;
};

const AGENT_DISPLAY: Record<string, string> = {
  [AgentId.LOCAL_GUIDE]: "本地向导",
  [AgentId.ART_CRITIC]: "艺术评论家",
  [AgentId.STYLIST]: "穿搭检查师",
  [AgentId.FOOD_EXPLORER]: "零食分析",
  [AgentId.FOOD_SCAN]: "食识拍",
  [AgentId.PALM_READER]: "看手相师",
  [AgentId.TEXT_READER]: "文字解读",
  [AgentId.MENU_TRANSLATOR]: "翻译师",
  [AgentId.MED_LABEL]: "药品说明",
  [AgentId.SIGHT_ROUTE]: "景点路线",
  [AgentId.HOTEL_GUIDE]: "酒店入住",
  [AgentId.FLIGHT_INFO]: "航班助手",
  [AgentId.GENERAL_CURIOSITY]: "智能解读",
};

/** 各专项「对题」的强正面线索 */
const FIT_POSITIVE: Partial<Record<AgentId, RegExp>> = {
  [AgentId.PALM_READER]:
    /掌心|掌纹|手掌|手相|五指|open\s*palm|palm\s*(print|line|reading)/i,
  [AgentId.FOOD_SCAN]:
    /盘装|碗装|餐盘|白盘|瓷盘|正餐|外卖|米饭|烩饭|炒饭|面条|意面|沙拉|plated|bowl\s*of|一盘|一碗|餐食|料理/i,
  [AgentId.FOOD_EXPLORER]:
    /零食|薯片|膨化|巧克力|糖果|软糖|坚果|饼干|威化|果干|牛肉干|海苔|nutrition\s*facts|snack\s*(pack|bag|food)/i,
  [AgentId.MENU_TRANSLATOR]:
    /菜单|menu\b|价目表|菜名|品目|wine\s*list|おすすめ|ランチ|定食/i,
  [AgentId.MED_LABEL]:
    /药盒|药品|说明书|用法用量|不良反应|适应症|胶囊|片剂|drug\s*facts|package\s*insert/i,
  [AgentId.FLIGHT_INFO]:
    /登机牌|登机口|航站楼|航班号|机票|boarding\s*pass|flight\s*(no\.?|number)/i,
  [AgentId.HOTEL_GUIDE]:
    /确认号|confirmation|check[- ]?in|入住|退房|hotel\s*(booking|reservation)/i,
  [AgentId.STYLIST]:
    /穿搭|全身照|半身|outfit|street\s*style|服装|衣服|上衣|裤子|裙子/i,
  [AgentId.SIGHT_ROUTE]:
    /导览图|游览图|路线图|景点地图|tourist\s*map|itinerary/i,
  [AgentId.LOCAL_GUIDE]:
    /地标|建筑|街景|广场|教堂|塔楼|landmark|facade|street\s*view/i,
};

/** 明显「跑题」的负面线索（命中且无正面 → 不匹配） */
const FIT_NEGATIVE: Partial<Record<AgentId, RegExp>> = {
  [AgentId.PALM_READER]:
    /餐盘|米饭|零食|包装袋|菜单|登机牌|药盒|风景|街景|建筑|键盘|疏通|清洁剂/i,
  [AgentId.FOOD_SCAN]:
    /掌心|掌纹|登机牌|药盒|菜单价目|导览图|穿搭全身|包装袋.*配料表/i,
  [AgentId.FOOD_EXPLORER]:
    /掌心|掌纹|餐盘|一盘|一碗|正餐|烩饭|炒饭|登机牌|药盒/i,
  [AgentId.MENU_TRANSLATOR]: /掌心|掌纹|登机牌|药盒|一盘米饭|穿搭全身/i,
  [AgentId.MED_LABEL]: /掌心|掌纹|餐盘米饭|登机牌|零食薯片|穿搭/i,
  [AgentId.FLIGHT_INFO]: /掌心|掌纹|餐盘|零食|药盒|菜单/i,
  [AgentId.HOTEL_GUIDE]: /掌心|掌纹|餐盘|零食薯片|登机牌/i,
  [AgentId.STYLIST]: /掌心|掌纹|餐盘米饭|登机牌|药盒|菜单价目/i,
  [AgentId.SIGHT_ROUTE]: /掌心|掌纹|餐盘|登机牌|药盒/i,
  [AgentId.LOCAL_GUIDE]: /掌心|掌纹|餐盘米饭|登机牌|药盒配料/i,
};

function labelOf(agent: AgentId): string {
  return AGENT_DISPLAY[agent] ?? agent;
}

function suggestFromCaption(caption: string): AgentId {
  const order: AgentId[] = [
    AgentId.FLIGHT_INFO,
    AgentId.HOTEL_GUIDE,
    AgentId.MED_LABEL,
    AgentId.MENU_TRANSLATOR,
    AgentId.PALM_READER,
    AgentId.FOOD_SCAN,
    AgentId.FOOD_EXPLORER,
    AgentId.STYLIST,
    AgentId.SIGHT_ROUTE,
    AgentId.LOCAL_GUIDE,
  ];
  for (const agent of order) {
    const pos = FIT_POSITIVE[agent];
    if (pos?.test(caption)) {
      if (agent === AgentId.FOOD_EXPLORER && NON_EDIBLE_PRODUCT_HINT.test(caption)) {
        continue;
      }
      return agent;
    }
  }
  return AgentId.GENERAL_CURIOSITY;
}

/**
 * 专项镜头拍照后：根据 caption 判断是否对题。
 * 拿不准时视为匹配（交给模型继续），只拦截明显跑题。
 */
export function assessAgentPhotoFit(
  requested: AgentId,
  caption: string | null | undefined,
): { matched: boolean; suggestedAgent: AgentId; reason: string } {
  if (requested === AgentId.GENERAL_CURIOSITY) {
    return { matched: true, suggestedAgent: requested, reason: "通用镜头" };
  }

  const text = caption?.trim() ?? "";
  if (!text) {
    return { matched: true, suggestedAgent: requested, reason: "无描述，暂不拦截" };
  }

  // 食品镜头 + 危险化学品：强制不匹配
  if (
    (requested === AgentId.FOOD_EXPLORER || requested === AgentId.FOOD_SCAN) &&
    NON_EDIBLE_PRODUCT_HINT.test(text)
  ) {
    return {
      matched: false,
      suggestedAgent: AgentId.GENERAL_CURIOSITY,
      reason: "疑似日化/不可食用化学品",
    };
  }

  const positive = FIT_POSITIVE[requested];
  const negative = FIT_NEGATIVE[requested];
  const hasPositive = Boolean(positive && positive.test(text));
  const hasNegative = Boolean(negative && negative.test(text));

  if (hasPositive) {
    return { matched: true, suggestedAgent: requested, reason: "描述符合专项" };
  }

  if (hasNegative) {
    const suggested = suggestFromCaption(text);
    return {
      matched: false,
      suggestedAgent: suggested,
      reason: "描述明显不符合当前专项",
    };
  }

  // 零食：没有可食用证据且像通用包装 → 不匹配（避免清洁剂袋）
  if (requested === AgentId.FOOD_EXPLORER) {
    const looksLikePackaging = /包装|袋|盒|罐|铝箔|自立袋|条码|barcode/i.test(text);
    if (looksLikePackaging) {
      return {
        matched: false,
        suggestedAgent: AgentId.GENERAL_CURIOSITY,
        reason: "包装类但缺少可食用零食证据",
      };
    }
  }

  return { matched: true, suggestedAgent: requested, reason: "未发现明显跑题" };
}

export function buildAgentMismatchInfo(
  requested: AgentId,
  suggested: AgentId,
  reason: string,
): AgentMismatchInfo {
  const reqLabel = labelOf(requested);
  const sugLabel = labelOf(suggested);
  return {
    requested_agent: requested,
    suggested_agent: suggested,
    title: "换一张照片试试",
    message: `这张更适合${sugLabel}。想看${reqLabel}，重新拍一张更对题的照片。`,
    reason,
  };
}

/** 分析结果事后校验：低置信或安全改写也可触发不匹配文案 */
export function assessInsightAgentFit(
  requested: AgentId,
  insight: {
    confidence?: number;
    title?: string | null;
    narrative?: string | null;
    category?: string | null;
    snack_analysis?: {
      snack_type?: string;
      calories_estimate?: string | null;
    } | null;
  },
): { matched: boolean; reason: string } {
  if (requested === AgentId.GENERAL_CURIOSITY) {
    return { matched: true, reason: "通用" };
  }

  const snackType = insight.snack_analysis?.snack_type ?? "";
  if (
    requested === AgentId.FOOD_EXPLORER &&
    (/非食品|不可食用/.test(snackType) ||
      /不可食用/.test(insight.title ?? "") ||
      /不可食用/.test(insight.snack_analysis?.calories_estimate ?? ""))
  ) {
    return { matched: false, reason: "识别为非食品" };
  }

  const blob = `${insight.title ?? ""}\n${insight.narrative ?? ""}\n${insight.category ?? ""}`;
  if (
    /不是手掌|非手掌|不是餐食|不是零食|不是菜单|不是药|无法识别为|不太像|并不像/.test(
      blob,
    )
  ) {
    return { matched: false, reason: "模型自述跑题" };
  }

  if (
    requested === AgentId.PALM_READER &&
    (insight.confidence ?? 1) < 0.45 &&
    /风景|食物|包装|菜单|建筑/.test(blob)
  ) {
    return { matched: false, reason: "手相低置信且非手掌语境" };
  }

  return { matched: true, reason: "结果可接受" };
}
