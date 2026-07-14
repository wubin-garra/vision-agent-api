export function formatGeoContext(
  latitude?: number | null,
  longitude?: number | null,
): string {
  if (latitude == null || longitude == null) {
    return "拍摄位置：未提供";
  }
  return `拍摄位置：纬度 ${latitude.toFixed(6)}，经度 ${longitude.toFixed(6)}`;
}

export function formatInsightContext(insight: unknown): string {
  return JSON.stringify(insight, null, 2);
}

export function formatFollowupHistory(
  followups: Array<Record<string, unknown>>,
): string {
  if (!followups.length) {
    return "（无历史追问）";
  }

  return followups
    .map((item, index) => {
      const n = index + 1;
      let answer = String(item.answer ?? "");
      const structured = item.structured_answer;
      if (
        structured &&
        typeof structured === "object" &&
        "summary" in structured &&
        structured.summary
      ) {
        answer = String(structured.summary);
      }
      return `Q${n}: ${String(item.question ?? "")}\nA${n}: ${answer}`;
    })
    .join("\n\n");
}

export function buildAnalyzeUserText(input: {
  locale: string;
  caption: string;
  latitude?: number | null;
  longitude?: number | null;
}): string {
  return (
    `Locale: ${input.locale}\n` +
    `${formatGeoContext(input.latitude, input.longitude)}\n\n` +
    `图片视觉描述（由视觉模型生成）：\n${input.caption}\n\n` +
    "请基于以上描述输出结构化 JSON 洞察。只输出 JSON。"
  );
}

export function buildFollowupUserText(input: {
  locale: string;
  caption: string;
  insight: unknown;
  followupHistory: Array<Record<string, unknown>>;
  question: string;
  agentId: string;
  latitude?: number | null;
  longitude?: number | null;
}): string {
  return (
    `Locale: ${input.locale}\n` +
    `Agent: ${input.agentId}\n` +
    `${formatGeoContext(input.latitude, input.longitude)}\n\n` +
    `【图片视觉描述】\n${input.caption}\n\n` +
    `【已有洞察】\n${formatInsightContext(input.insight)}\n\n` +
    `【历史追问】\n${formatFollowupHistory(input.followupHistory)}\n\n` +
    `【当前问题】\n${input.question}\n\n` +
    "只输出 JSON。"
  );
}
