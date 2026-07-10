"""Specialized visual agents — prompts defined in app.agents.prompts."""

from app.schemas.insight import AgentId

SPECIALIST_IDS = [
    AgentId.LOCAL_GUIDE,
    AgentId.ART_CRITIC,
    AgentId.DESIGN_CRITIC,
    AgentId.STYLIST,
    AgentId.FOOD_EXPLORER,
    AgentId.TEXT_READER,
    AgentId.GENERAL_CURIOSITY,
]
