from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AgentId(str, Enum):
    LOCAL_GUIDE = "local_guide"
    ART_CRITIC = "art_critic"
    DESIGN_CRITIC = "design_critic"
    STYLIST = "stylist"
    FOOD_EXPLORER = "food_explorer"
    TEXT_READER = "text_reader"
    GENERAL_CURIOSITY = "general_curiosity"


class SceneType(str, Enum):
    LANDMARK_STREET = "landmark_street"
    ARTWORK = "artwork"
    OUTFIT = "outfit"
    FOOD = "food"
    TEXT_HEAVY = "text_heavy"
    PRODUCT_DESIGN = "product_design"
    GENERAL = "general"


class InsightContext(BaseModel):
    cultural: Optional[str] = None
    historical: Optional[str] = None
    practical: Optional[str] = None


class FlavorNote(BaseModel):
    label: str
    value: str
    emoji: Optional[str] = None


class NearbyPick(BaseModel):
    name: str
    blurb: str = ""


class ExploreChips(BaseModel):
    culinary: list[str] = Field(default_factory=list)
    nearby: list[str] = Field(default_factory=list)


class ShareCard(BaseModel):
    headline: str = ""
    quote: str = ""
    cta: str = ""


class StructuredInsight(BaseModel):
    title: str
    category: str
    confidence: float = Field(ge=0.0, le=1.0)
    visible_clues: list[str] = Field(default_factory=list)
    context: InsightContext = Field(default_factory=InsightContext)
    style_vocabulary: list[str] = Field(default_factory=list)
    suggested_searches: list[str] = Field(default_factory=list)
    next_actions: list[str] = Field(default_factory=list)
    agent_id: AgentId = AgentId.GENERAL_CURIOSITY
    disclaimer: str = "非鉴定/医疗/法律建议，仅供参考。"
    # Chance 风格扩展字段（主要用于 food_explorer / local_guide）
    subtitle: Optional[str] = None
    narrative: Optional[str] = None
    flavor_notes: list[FlavorNote] = Field(default_factory=list)
    nearby_picks: list[NearbyPick] = Field(default_factory=list)
    explore_chips: ExploreChips = Field(default_factory=ExploreChips)
    share_card: Optional[ShareCard] = None


class SceneClassification(BaseModel):
    scene_type: SceneType
    text_density: str = Field(description="none | low | high")
    has_person: bool = False
    recommended_agent: AgentId = AgentId.GENERAL_CURIOSITY
    reasoning: str = ""


class AnalyzeRequest(BaseModel):
    locale: str = "zh-CN"
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    agent_override: Optional[AgentId] = None


class FollowUpRequest(BaseModel):
    memory_id: str
    question: str
    locale: str = "zh-CN"


class FollowUpResponse(BaseModel):
    memory_id: str
    answer: str
    suggested_followups: list[str] = Field(default_factory=list)


class MemoryItem(BaseModel):
    id: str
    title: str
    category: str
    agent_id: AgentId
    image_url: str
    thumbnail_url: str
    insight: StructuredInsight
    created_at: str
    locale: str


class MemoryListResponse(BaseModel):
    items: list[MemoryItem]
    total: int
