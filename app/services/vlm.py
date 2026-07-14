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
            if agent_id == "food_scan":
                return {
                    "answer": (
                        f"这餐以虾仁、金枪鱼、鸡蛋和牛油果为主，蛋白质来源丰富，"
                        f"整体适合减脂期适量食用。关于「{question}」：注意控制油浸金枪鱼与酱料钠含量。"
                    ),
                    "structured_answer": {
                        "summary": (
                            "这餐以虾仁、金枪鱼、鸡蛋和牛油果为主，蛋白质来源丰富，"
                            "整体适合减脂期适量食用，但需注意调味与碳水比例。"
                        ),
                        "sections": [
                            {
                                "heading": "减脂期的优劣势分析",
                                "paragraphs": [
                                    "虾仁、金枪鱼与鸡蛋提供优质蛋白，牛油果带来健康脂肪；"
                                    "若配菜为白米饭，建议替换为糙米或花椰菜饭以降低热量。"
                                ],
                                "assessments": [
                                    {
                                        "tone": "positive",
                                        "title": "多源蛋白质",
                                        "body": "虾、鱼、蛋组合提供完整氨基酸，有助于维持肌肉量。",
                                    },
                                    {
                                        "tone": "positive",
                                        "title": "健康油脂",
                                        "body": "牛油果有助于平衡饱腹感，并减缓碳水消化速度。",
                                    },
                                    {
                                        "tone": "warning",
                                        "title": "调味隐患",
                                        "body": "油浸金枪鱼与海苔碎钠含量偏高，可能造成水肿感。",
                                    },
                                ],
                                "tips": [
                                    {
                                        "label": "蛋白质比例",
                                        "body": "保留海鲜+鸡蛋组合，金枪鱼优先选水浸款。",
                                    },
                                    {
                                        "label": "碳水置换",
                                        "body": "白米饭换糙米或黑米，增加纤维与 B 族维生素。",
                                    },
                                ],
                                "tips_heading": "优化小窍门",
                                "tips_lead": "如果你打算长期以此作为减脂餐，可以尝试微调：",
                            }
                        ],
                        "metric_card": {
                            "title": "饱腹感 VS 热量密度",
                            "sliders": [
                                {
                                    "label": "热量密度",
                                    "value": 0.35,
                                    "low_label": "低",
                                    "high_label": "高",
                                },
                                {
                                    "label": "饱腹感持续",
                                    "value": 0.78,
                                    "low_label": "短",
                                    "high_label": "长",
                                },
                            ],
                            "note": "相比高糖甜点，这餐在减脂效率上明显更优。",
                        },
                        "remark": "营养成分为视觉估算，具体数值请以食品标签或专业检测为准。",
                        "suggestion_groups": [
                            {
                                "title": "进阶减脂建议",
                                "questions": [
                                    "水浸和油浸金枪鱼热量差多少？",
                                    "减脂期适合吃哪些低卡酱料？",
                                    "牛油果一天吃多少比较合适？",
                                ],
                            },
                            {
                                "title": "附近健康餐厅",
                                "questions": ["附近有轻食/低卡餐厅吗？"],
                            },
                        ],
                    },
                    "suggested_followups": [
                        "水浸和油浸金枪鱼热量差多少？",
                        "减脂期适合吃哪些低卡酱料？",
                        "附近有轻食/低卡餐厅吗？",
                    ],
                }
            return {
                "answer": (
                    f"（Demo 模式）关于「{question}」："
                    f"这是基于之前分析「{insight_title}」的模拟回答。"
                ),
                "suggested_followups": ["更多历史背景", "类似风格有哪些", "推荐搜索词"],
            }

        from app.agents.prompts import FOLLOWUP_SYSTEM, FOOD_SCAN_FOLLOWUP_SYSTEM

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
        system_prompt = FOOD_SCAN_FOLLOWUP_SYSTEM if agent_id == "food_scan" else FOLLOWUP_SYSTEM
        max_tokens = 2000 if agent_id == "food_scan" else 1000
        return await self._chat_json(
            model=settings.llm_model,
            system_prompt=system_prompt,
            user_text=user_text,
            max_tokens=max_tokens,
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
