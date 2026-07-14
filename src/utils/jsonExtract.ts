/** JSON 解析与截断修复，供 vision / vlm 共用 */

export function stripCodeFence(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return cleaned.trim();
}

/** 尝试修复因 max_tokens 截断导致未闭合的 JSON（尽力而为） */
export function repairTruncatedJson(text: string): string {
  let s = text.trim();
  if (!s) return "{}";

  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
  }
  if (inString) s += '"';

  const stack: string[] = [];
  inString = false;
  escaped = false;
  for (const ch of s) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }

  s = s.replace(/,\s*$/, "");
  while (stack.length) {
    const open = stack.pop();
    s += open === "{" ? "}" : "]";
  }
  return s;
}

export function extractJson(text: string): Record<string, unknown> {
  const cleaned = stripCodeFence(text);
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch (firstError) {
    try {
      return JSON.parse(repairTruncatedJson(cleaned)) as Record<
        string,
        unknown
      >;
    } catch {
      const preview = cleaned.slice(0, 240).replace(/\s+/g, " ");
      throw new Error(
        `模型返回了不完整或非法 JSON（常因输出被截断）。片段: ${preview}…` +
          ` 原始错误: ${
            firstError instanceof Error
              ? firstError.message
              : String(firstError)
          }`,
      );
    }
  }
}
