import base64
import io
from collections import Counter

from PIL import Image
from openai import AsyncOpenAI

from app.config import settings

CAPTION_PROMPT = """请详细描述这张图片，供后续 AI 分析使用。按以下分段输出，每段都必须出现：
1. 主体对象/场景（若无明确主体，写「未观察到明确主体」）
2. 可见文字（若无文字，写「未观察到可见文字」；若有，尽量逐字列出）
3. 风格、材质、颜色
4. 人物/穿搭（若无人物，写「未观察到人物」）
5. 环境上下文线索（若无额外线索，写「未观察到额外环境线索」）
用中文简洁分段输出，不要 JSON，不要省略任何分段。"""


def _basic_caption(image_bytes: bytes) -> str:
    """无视觉 API Key 时的降级描述（仅供 DeepSeek 文本推理参考）。"""
    img = Image.open(io.BytesIO(image_bytes))
    if img.mode != "RGB":
        img = img.convert("RGB")
    w, h = img.size
    sample = img.resize((64, 64))
    pixels = list(sample.getdata())
    top_colors = Counter(pixels).most_common(3)
    color_desc = ", ".join(f"RGB{c}" for c, _ in top_colors)
    return (
        f"照片尺寸 {w}x{h} 像素。"
        f"主要颜色区域：{color_desc}。"
        "（未配置视觉模型，描述较简略；建议配置 DASHSCOPE_API_KEY 获得更准确识图。）"
    )


class VisionCaptionService:
    def __init__(self) -> None:
        self.provider = settings.vision_provider.lower()
        self.client: AsyncOpenAI | None = None
        self.model = ""
        if settings.vision_enabled:
            if self.provider == "dashscope":
                self.client = AsyncOpenAI(
                    api_key=settings.dashscope_api_key,
                    base_url=settings.dashscope_base_url,
                )
                self.model = settings.dashscope_vision_model
            elif self.provider == "openai":
                api_key = settings.openai_vision_api_key or settings.openai_api_key
                self.client = AsyncOpenAI(
                    api_key=api_key,
                    base_url=settings.openai_base_url,
                )
                self.model = settings.openai_vision_model

    async def describe_image(
        self,
        image_b64: str,
        locale: str = "zh-CN",
        image_bytes: bytes | None = None,
    ) -> str:
        if image_bytes is None:
            image_bytes = base64.b64decode(image_b64)

        if self.client:
            prompt = CAPTION_PROMPT if locale.startswith("zh") else CAPTION_PROMPT.replace("中文", "English")
            try:
                response = await self.client.chat.completions.create(
                    model=self.model,
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": prompt},
                                {
                                    "type": "image_url",
                                    "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                                },
                            ],
                        }
                    ],
                    max_tokens=800,
                )
                text = (response.choices[0].message.content or "").strip()
                if text:
                    return text
            except Exception as exc:
                err = str(exc)
                fallback = _basic_caption(image_bytes)
                if "insufficient_quota" in err or "429" in err:
                    return fallback + "（OpenAI 配额不足，请检查 billing；当前使用降级描述。）"
                return fallback + f"（视觉 API 调用失败：{err[:120]}）"

        return _basic_caption(image_bytes)


vision_service = VisionCaptionService()
