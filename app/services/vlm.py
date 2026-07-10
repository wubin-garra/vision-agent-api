import json
import re
from typing import Any, Optional

from openai import AsyncOpenAI

from app.config import settings
from app.services.context import build_analyze_user_text, build_followup_user_text
from app.services.vision import vision_service


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
    return json.loads(text)


class VLMService:
    def __init__(self) -> None:
        self.provider = settings.llm_provider.lower()
        self.demo_mode = settings.demo_mode
        self.client: AsyncOpenAI | None = None
        if settings.llm_enabled:
            self.client = AsyncOpenAI(
                api_key=settings.llm_api_key,
                base_url=settings.llm_base_url,
            )

    def _completion_extra(self) -> dict[str, Any]:
        if self.provider == "deepseek":
            return {"extra_body": {"thinking": {"type": "disabled"}}}
        return {}

    async def _chat_json(
        self,
        *,
        model: str,
        system_prompt: str,
        user_text: str,
        max_tokens: int,
    ) -> dict[str, Any]:
        if not self.client:
            raise RuntimeError("LLM client not configured")

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_text},
        ]

        try:
            response = await self.client.chat.completions.create(
                model=model,
                messages=messages,
                response_format={"type": "json_object"},
                max_tokens=max_tokens,
                **self._completion_extra(),
            )
        except Exception:
            response = await self.client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                **self._completion_extra(),
            )

        content = response.choices[0].message.content or "{}"
        return _extract_json(content)

    async def _caption(self, image_b64: str, locale: str, image_bytes: bytes | None = None) -> str:
        if self.demo_mode:
            return "（Demo）一张日常场景照片，包含可识别的物体与细节。"
        return await vision_service.describe_image(image_b64, locale, image_bytes=image_bytes)

    async def analyze_image(
        self,
        image_b64: str,
        system_prompt: str,
        locale: str = "zh-CN",
        model: Optional[str] = None,
        image_caption: Optional[str] = None,
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
    ) -> dict[str, Any]:
        if self.demo_mode:
            return self._demo_insight(locale)

        caption = image_caption or await self._caption(image_b64, locale)
        user_text = build_analyze_user_text(
            locale=locale,
            caption=caption,
            latitude=latitude,
            longitude=longitude,
        )
        return await self._chat_json(
            model=model or settings.llm_model,
            system_prompt=system_prompt,
            user_text=user_text,
            max_tokens=1500,
        )

    async def classify_scene(
        self,
        image_b64: str,
        image_caption: Optional[str] = None,
    ) -> dict[str, Any]:
        if self.demo_mode:
            return {
                "scene_type": "general",
                "text_density": "none",
                "has_person": False,
                "recommended_agent": "general_curiosity",
                "reasoning": "Demo mode default routing",
            }

        from app.agents.prompts import ROUTER_SYSTEM

        caption = image_caption or await self._caption(image_b64, "zh-CN")
        user_text = (
            f"图片视觉描述：\n{caption}\n\n"
            "请根据描述分类场景。只输出 JSON。"
        )
        return await self._chat_json(
            model=settings.router_model,
            system_prompt=ROUTER_SYSTEM,
            user_text=user_text,
            max_tokens=300,
        )

    async def followup(
        self,
        image_b64: str,
        question: str,
        insight: dict[str, Any],
        *,
        locale: str = "zh-CN",
        image_caption: Optional[str] = None,
        followup_history: Optional[list[dict[str, Any]]] = None,
        agent_id: str = "general_curiosity",
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
    ) -> dict[str, Any]:
        insight_title = insight.get("title", "")
        if self.demo_mode:
            return {
                "answer": (
                    f"（Demo 模式）关于「{question}」："
                    f"这是基于之前分析「{insight_title}」的模拟回答。"
                ),
                "suggested_followups": ["更多历史背景", "类似风格有哪些", "推荐搜索词"],
            }

        from app.agents.prompts import FOLLOWUP_SYSTEM

        caption = image_caption or await self._caption(image_b64, locale)
        user_text = build_followup_user_text(
            locale=locale,
            caption=caption,
            insight=insight,
            followup_history=followup_history or [],
            question=question,
            agent_id=agent_id,
            latitude=latitude,
            longitude=longitude,
        )
        return await self._chat_json(
            model=settings.llm_model,
            system_prompt=FOLLOWUP_SYSTEM,
            user_text=user_text,
            max_tokens=1000,
        )

    def _demo_insight(self, locale: str) -> dict[str, Any]:
        is_zh = locale.startswith("zh")
        if is_zh:
            return {
                "title": "Art Deco 台灯",
                "category": "家具 / 照明",
                "confidence": 0.78,
                "visible_clues": ["黄铜底座", "几何玻璃灯罩", "1920s 风格线条"],
                "context": {
                    "cultural": "Art Deco 运动强调几何对称与奢华材质，常见于 1920–1930 年代。",
                    "historical": "起源于 1925 年巴黎装饰艺术博览会。",
                    "practical": "适合作为卧室或书房的阅读灯。",
                },
                "style_vocabulary": ["Art Deco", "几何装饰", "Streamline Moderne"],
                "suggested_searches": ["Art Deco table lamp brass", "1920s geometric lamp"],
                "next_actions": ["查看相似设计史", "生成分享卡片"],
                "agent_id": "design_critic",
                "disclaimer": "非鉴定/医疗/法律建议，仅供参考。",
            }
        return {
            "title": "Art Deco Table Lamp",
            "category": "Furniture / Lighting",
            "confidence": 0.78,
            "visible_clues": ["Brass base", "Geometric glass shade", "1920s-style lines"],
            "context": {
                "cultural": "Art Deco emphasizes geometry and luxurious materials.",
                "historical": "Originated at the 1925 Paris Exposition.",
                "practical": "Works well as a bedside reading lamp.",
            },
            "style_vocabulary": ["Art Deco", "Geometric", "Streamline Moderne"],
            "suggested_searches": ["Art Deco table lamp brass"],
            "next_actions": ["Explore design history", "Create share card"],
            "agent_id": "design_critic",
            "disclaimer": "Not appraisal, medical, or legal advice.",
        }


vlm_service = VLMService()
