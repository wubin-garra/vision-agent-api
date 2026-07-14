from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field


class AgentId(str, Enum):
    LOCAL_GUIDE = "local_guide"
    ART_CRITIC = "art_critic"
    DESIGN_CRITIC = "design_critic"
    STYLIST = "stylist"
    FOOD_EXPLORER = "food_explorer"
    FOOD_SCAN = "food_scan"
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


class NutritionMacro(BaseModel):
    current: float
    goal: float
    unit: str = "g"
    emoji: Optional[str] = None


class NutritionProfile(BaseModel):
    calories_current: int
    calories_goal: int = 2000
    carbs: NutritionMacro
    fat: NutritionMacro
    protein: NutritionMacro


class AllergenItem(BaseModel):
    category: str
    detail: str
    emoji: Optional[str] = None


class NutritionTip(BaseModel):
    title: str
    body: str


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
    # 食识拍 (food_scan) 营养分析扩展
    nutrition: Optional[NutritionProfile] = None
    allergens: list[AllergenItem] = Field(default_factory=list)
    nutrition_tips: list[NutritionTip] = Field(default_factory=list)
    diet_summary: Optional[str] = None


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


class FollowUpAssessmentItem(BaseModel):
    """评估条目：positive=优点（绿圈），warning=隐患（红圈）。"""

    tone: Literal["positive", "warning"]
    title: str
    body: str


class FollowUpTip(BaseModel):
    """优化建议：label 为分类名，body 为具体做法。"""

    label: str
    body: str


class FollowUpSection(BaseModel):
    """追问回答的一个主题分段，可含正文、评估卡、优化建议。"""

    heading: str
    paragraphs: list[str] = Field(default_factory=list)
    assessments: list[FollowUpAssessmentItem] = Field(default_factory=list)
    tips_heading: Optional[str] = "优化小窍门"
    tips_lead: Optional[str] = None
    tips: list[FollowUpTip] = Field(default_factory=list)


class FollowUpMetricSlider(BaseModel):
    """0-1 滑条，value 表示在 low/high 之间的位置。"""

    label: str
    value: float = Field(ge=0.0, le=1.0)
    low_label: str
    high_label: str


class FollowUpMetricCard(BaseModel):
    """对比型指标卡，如「饱腹感 VS 热量密度」。"""

    title: str
    sliders: list[FollowUpMetricSlider] = Field(default_factory=list)
    note: Optional[str] = None


class FollowUpSuggestionGroup(BaseModel):
    """分组追问芯片，如「进阶减脂建议」。"""

    title: str
    questions: list[str] = Field(default_factory=list)


class StructuredFollowUpAnswer(BaseModel):
    """食识拍 Chance 风格结构化追问回答。"""

    summary: str
    sections: list[FollowUpSection] = Field(default_factory=list)
    metric_card: Optional[FollowUpMetricCard] = None
    remark: Optional[str] = None
    suggestion_groups: list[FollowUpSuggestionGroup] = Field(default_factory=list)


class FollowUpRequest(BaseModel):
    memory_id: str
    question: str
    locale: str = "zh-CN"


class FollowUpResponse(BaseModel):
    memory_id: str
    answer: str
    structured_answer: Optional[StructuredFollowUpAnswer] = None
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
