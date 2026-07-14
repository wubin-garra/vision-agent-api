import OpenAI from "openai";
import sharp from "sharp";

import { settings } from "../config.js";
import { extractJson } from "../utils/jsonExtract.js";

const CAPTION_PROMPT_FULL = `请详细描述这张图片，供后续 AI 分析使用。按以下分段输出，每段都必须出现：
1. 主体对象/场景（若无明确主体，写「未观察到明确主体」）
2. 可见文字（若无文字，写「未观察到可见文字」；若有，尽量逐字列出）
3. 风格、材质、颜色
4. 人物/穿搭（若无人物，写「未观察到人物」）
5. 环境上下文线索（若无额外线索，写「未观察到额外环境线索」）
用中文简洁分段输出，不要 JSON，不要省略任何分段。`;

const CAPTION_PROMPT_FAST = `用 3–5 句中文简要描述这张图片，供后续追问参考：
- 主体/场景是什么
- 关键食材、物体或可见文字（没有则跳过）
- 颜色与环境线索
不要 JSON，不要分段标题，控制在 120 字以内。`;

async function basicCaption(imageBytes: Buffer): Promise<string> {
  const image = sharp(imageBytes);
  const meta = await image.metadata();
  const { data, info } = await image
    .resize(64, 64, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const counts = new Map<string, number>();
  for (let i = 0; i < data.length; i += info.channels) {
    const key = `RGB(${data[i]},${data[i + 1]},${data[i + 2]})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const topColors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([color]) => color)
    .join(", ");

  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  return (
    `照片尺寸 ${w}x${h} 像素。` +
    `主要颜色区域：${topColors}。` +
    "（未配置视觉模型，描述较简略；建议配置 DASHSCOPE_API_KEY 获得更准确识图。）"
  );
}

export class VisionCaptionService {
  readonly provider = settings.visionProvider;
  readonly enabled = settings.visionEnabled;
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor() {
    if (!settings.visionEnabled) {
      this.client = null;
      this.model = "";
      return;
    }

    if (this.provider === "dashscope") {
      this.client = new OpenAI({
        apiKey: settings.dashscopeApiKey,
        baseURL: settings.dashscopeBaseUrl,
      });
      this.model = settings.dashscopeVisionModel;
      return;
    }

    if (this.provider === "openai") {
      this.client = new OpenAI({
        apiKey: settings.openaiVisionApiKey || settings.openaiApiKey,
        baseURL: settings.openaiBaseUrl,
      });
      this.model = settings.openaiVisionModel;
      return;
    }

    this.client = null;
    this.model = "";
  }

  async describeImage(
    imageB64: string,
    locale = "zh-CN",
    imageBytes?: Buffer,
    mode: "full" | "fast" = "full",
  ): Promise<string> {
    const bytes = imageBytes ?? Buffer.from(imageB64, "base64");

    if (this.client) {
      const isZh = locale.startsWith("zh");
      const prompt =
        mode === "fast"
          ? isZh
            ? CAPTION_PROMPT_FAST
            : "Summarize this image in 3-5 short English sentences covering subject, key objects/text, and context. No JSON."
          : isZh
            ? CAPTION_PROMPT_FULL
            : CAPTION_PROMPT_FULL.replace("中文", "English");
      const maxTokens = mode === "fast" ? 280 : 800;
      try {
        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: { url: `data:image/jpeg;base64,${imageB64}` },
                },
              ],
            },
          ],
          max_tokens: maxTokens,
        });
        const text = (response.choices[0]?.message?.content ?? "").trim();
        if (text) return text;
      } catch (exc) {
        const err = String(exc);
        const fallback = await basicCaption(bytes);
        if (err.includes("insufficient_quota") || err.includes("429")) {
          return (
            fallback + "（OpenAI 配额不足，请检查 billing；当前使用降级描述。）"
          );
        }
        return fallback + `（视觉 API 调用失败：${err.slice(0, 120)}）`;
      }
    }

    return basicCaption(bytes);
  }

  describeImageFast(
    imageB64: string,
    locale = "zh-CN",
    imageBytes?: Buffer,
  ): Promise<string> {
    return this.describeImage(imageB64, locale, imageBytes, "fast");
  }

  /**
   * 多模态看图直接输出结构化 insight JSON（主分析路径）。
   */
  async analyzeImageJson(input: {
    imageB64: string;
    systemPrompt: string;
    userText: string;
    maxTokens: number;
  }): Promise<Record<string, unknown>> {
    if (!this.client) {
      throw new Error("Vision client not configured");
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: input.systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: input.userText },
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${input.imageB64}` },
          },
        ],
      },
    ];

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        response_format: { type: "json_object" },
        max_tokens: input.maxTokens,
      });
    } catch {
      response = await this.client.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: input.maxTokens,
      });
    }

    const content = response.choices[0]?.message?.content ?? "{}";
    return extractJson(content);
  }
}

export const visionService = new VisionCaptionService();
