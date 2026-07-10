from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.schemas.insight import StructuredInsight
from app.services.database import memory_repository
from app.services.vlm import vlm_service

router = APIRouter()


class TTSRequest(BaseModel):
    text: str
    locale: str = "zh-CN"


@router.post("/tts")
async def text_to_speech(body: TTSRequest):
    """Return TTS metadata. Client uses expo-speech for local playback in MVP."""
    if vlm_service.demo_mode:
        return {
            "mode": "client",
            "text": body.text,
            "locale": body.locale,
            "message": "Use expo-speech on client for TTS playback.",
        }

    try:
        from openai import AsyncOpenAI
        from app.config import settings

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        response = await client.audio.speech.create(
            model="tts-1",
            voice="nova",
            input=body.text[:500],
        )
        audio_bytes = response.content
        import base64

        return {
            "mode": "server",
            "audio_base64": base64.b64encode(audio_bytes).decode("utf-8"),
            "format": "mp3",
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class SharePosterRequest(BaseModel):
    memory_id: str
    title: str = ""
    category: str = ""
    summary: str = ""


def _build_poster_from_insight(insight: StructuredInsight, memory_id: str) -> dict:
    share = insight.share_card
    headline = share.headline if share and share.headline else insight.title
    quote = share.quote if share and share.quote else insight.subtitle or insight.narrative or ""
    cta = share.cta if share and share.cta else (
        insight.context.practical or "随手拍一张传上来，Vision Agent 随时准备为你带来惊喜。"
    )
    return {
        "memory_id": memory_id,
        "poster": {
            "headline": headline,
            "subtitle": insight.subtitle or insight.category,
            "quote": quote,
            "cta": cta,
            "category": insight.category,
            "brand": "Vision Agent",
            "tagline": "看见它，理解它",
            "signature": "Seeing with Vision Agent",
        },
    }


@router.post("/share/poster")
async def generate_share_poster(body: SharePosterRequest):
    """Return share poster metadata for client-side rendering."""
    record = await memory_repository.get(body.memory_id)
    if record:
        import json

        insight = StructuredInsight.model_validate(json.loads(record.insight_json))
        return _build_poster_from_insight(insight, body.memory_id)

    return {
        "memory_id": body.memory_id,
        "poster": {
            "headline": body.title,
            "subtitle": body.category,
            "quote": body.summary,
            "cta": body.summary,
            "category": body.category,
            "brand": "Vision Agent",
            "tagline": "看见它，理解它",
            "signature": "Seeing with Vision Agent",
        },
    }
