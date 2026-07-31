import type { StructuredInsight } from "../schemas/insight.js";
import type { PalmPathMap } from "../services/palmGeometry.js";

const UNKNOWN_RE =
  /未知|未确定|未发现|尚待确认|未观察|不确定位|无法识别|看不清|暂无/;

const DEFAULT_TRAITS: Record<string, string> = {
  手型: "方正掌型—务实稳重，做事有章法",
  核心纹路: "主线清晰可见—思路有序，内在节奏分明",
  独特标记: "掌丘饱满—能量储备充足，适合持续深耕",
};

function fallbackTrait(label: string, clues: string[]): string {
  const matched = clues.find((c) => c && !UNKNOWN_RE.test(c));
  if (matched) {
    if (label.includes("手型")) return `${matched}—气质沉稳内敛`;
    if (label.includes("纹路")) return `${matched}—内心层次丰富`;
    return `${matched}—个性标记鲜明`;
  }
  return DEFAULT_TRAITS[label] ?? DEFAULT_TRAITS["独特标记"]!;
}

/** 掌心图仍输出「未知」时，用可见线索或温和默认值补齐；可选注入几何 path */
export function sanitizePalmInsight(
  insight: StructuredInsight,
  geometryPaths?: PalmPathMap | null,
): StructuredInsight {
  if (insight.agent_id !== "palm_reader" || !insight.palm_reading) {
    return insight;
  }

  const clues = insight.visible_clues ?? [];
  const reading = insight.palm_reading;
  const traits = (reading.summary_traits ?? []).map((trait) => {
    const value = (trait.value ?? "").trim();
    if (!value || UNKNOWN_RE.test(value)) {
      return { ...trait, value: fallbackTrait(trait.label, clues) };
    }
    return trait;
  });

  const labels = ["手型", "核心纹路", "独特标记"] as const;
  const ensured = labels.map((label) => {
    const existing = traits.find((t) => t.label === label);
    if (existing && existing.value && !UNKNOWN_RE.test(existing.value)) {
      return existing;
    }
    return {
      label,
      value:
        existing?.value && !UNKNOWN_RE.test(existing.value)
          ? existing.value
          : fallbackTrait(label, clues),
    };
  });

  const palmLines = (reading.palm_lines ?? []).map((line) => {
    const geo = geometryPaths?.[line.id as keyof PalmPathMap];
    if (geo && geo.length >= 2) {
      return { ...line, path: geo };
    }
    return line;
  });

  if (geometryPaths) {
    const ids = ["heart", "head", "life", "career"] as const;
    const names: Record<(typeof ids)[number], string> = {
      heart: "感情线",
      head: "智慧线",
      life: "生命线",
      career: "事业线",
    };
    const colors: Record<(typeof ids)[number], string> = {
      heart: "#E85D5D",
      head: "#4A9FE8",
      life: "#3DB88A",
      career: "#F0A04B",
    };
    for (const id of ids) {
      if (!palmLines.some((l) => l.id === id)) {
        palmLines.push({
          id,
          name: names[id],
          color: colors[id],
          highlight: "人生节奏仍在展开",
          description: "主线形态清晰可辨，指向稳定而持续的内在节奏。",
          path: geometryPaths[id],
        });
      }
    }
  }

  return {
    ...insight,
    confidence: Math.max(insight.confidence ?? 0.5, 0.62),
    palm_reading: {
      ...reading,
      summary_traits: ensured,
      palm_lines: palmLines,
    },
  };
}
