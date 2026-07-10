import base64

from app.agents.prompts import AGENT_PROMPTS, SCENE_TO_AGENT
from app.schemas.insight import AgentId, SceneClassification, SceneType, StructuredInsight
from app.services.vlm import vlm_service


class SceneRouter:
    async def route(
        self,
        image_bytes: bytes,
        agent_override: AgentId | None = None,
        image_caption: str | None = None,
    ) -> AgentId:
        if agent_override:
            return agent_override

        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        raw = await vlm_service.classify_scene(image_b64, image_caption=image_caption)

        try:
            classification = SceneClassification(
                scene_type=SceneType(raw.get("scene_type", "general")),
                text_density=raw.get("text_density", "none"),
                has_person=bool(raw.get("has_person", False)),
                recommended_agent=AgentId(raw.get("recommended_agent", "general_curiosity")),
                reasoning=raw.get("reasoning", ""),
            )
            return classification.recommended_agent
        except (ValueError, KeyError):
            scene = raw.get("scene_type", "general")
            return SCENE_TO_AGENT.get(scene, AgentId.GENERAL_CURIOSITY)


class InsightPlanner:
    async def analyze(
        self,
        image_bytes: bytes,
        agent_id: AgentId,
        locale: str = "zh-CN",
        image_caption: str | None = None,
        latitude: float | None = None,
        longitude: float | None = None,
    ) -> StructuredInsight:
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        system_prompt = AGENT_PROMPTS[agent_id]
        raw = await vlm_service.analyze_image(
            image_b64,
            system_prompt,
            locale=locale,
            image_caption=image_caption,
            latitude=latitude,
            longitude=longitude,
        )
        raw["agent_id"] = agent_id.value
        return StructuredInsight.model_validate(raw)


scene_router = SceneRouter()
insight_planner = InsightPlanner()
