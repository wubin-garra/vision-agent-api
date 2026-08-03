import type { StructuredInsight } from "../schemas/insight.js";

const UNCLEAR_USAGE = "包装上未清晰显示功效/适应症，请对准说明书文字再拍一张";
const UNCLEAR_DOSAGE = "包装上未清晰显示用法用量，请对准说明书「用法用量」栏再拍一张";
const UNCLEAR_INSERT = "说明书要点未完整识别，建议对准说明书内页或药盒侧面文字再拍一张";

function nonEmpty(value?: string | null): value is string {
  return Boolean(value && value.trim());
}

/**
 * 药品说明兜底：关键区块尽量有可读内容；空字段给出明确提示，避免页面「像没返回」。
 */
export function sanitizeMedLabelInsight(
  insight: StructuredInsight,
): StructuredInsight {
  if (insight.agent_id !== "med_label" || !insight.med_label_reading) {
    return insight;
  }

  const reading = { ...insight.med_label_reading };

  if (!nonEmpty(reading.usage)) {
    // 从摘要/叙事里尽量捞一句适应症
    const fromSummary =
      reading.translated_summary?.match(/(?:用于|适用于|主治|适应症)[^。；;\n]{4,40}/)?.[0] ??
      insight.narrative?.match(/(?:用于|适用于|主治|适应症)[^。；;\n]{4,40}/)?.[0];
    reading.usage = fromSummary?.trim() || UNCLEAR_USAGE;
  }

  if (!nonEmpty(reading.dosage) && !(reading.dosage_steps?.length)) {
    const fromText =
      reading.package_insert?.match(/(?:用法用量|口服|每次|每日)[^。；;\n]{4,50}/)?.[0] ??
      reading.translated_summary?.match(/(?:每次|每日|口服)[^。；;\n]{4,40}/)?.[0];
    reading.dosage = fromText?.trim() || UNCLEAR_DOSAGE;
  }

  if (!(reading.adverse_reactions?.length)) {
    reading.adverse_reactions = ["包装上未列出或未看清不良反应，请查阅说明书原文"];
  }

  if (!nonEmpty(reading.package_insert)) {
    const parts = [
      nonEmpty(reading.drug_name) ? `药名：${reading.drug_name}` : null,
      nonEmpty(reading.usage) && reading.usage !== UNCLEAR_USAGE
        ? `功效/适应症：${reading.usage}`
        : null,
      nonEmpty(reading.dosage) && reading.dosage !== UNCLEAR_DOSAGE
        ? `用法用量：${reading.dosage}`
        : null,
      reading.warnings?.length ? `注意：${reading.warnings.slice(0, 3).join("；")}` : null,
      nonEmpty(reading.storage) ? `储存：${reading.storage}` : null,
    ].filter(Boolean);
    reading.package_insert =
      parts.length >= 2 ? `${parts.join("。")}。具体以说明书原文为准。` : UNCLEAR_INSERT;
  }

  if (!(reading.warnings?.length)) {
    reading.warnings = ["请仔细阅读说明书，遵医嘱使用；不确定时咨询医师或药师"];
  }

  return {
    ...insight,
    med_label_reading: reading,
  };
}
