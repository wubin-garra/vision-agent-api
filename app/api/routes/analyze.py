import asyncio
import base64
import json
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from sse_starlette.sse import EventSourceResponse

from app.agents.prompts import flatten_followup_suggestions, resolve_followup_chips
from app.agents.router import insight_planner, scene_router
from app.schemas.insight import (
    AgentId,
    FollowUpRequest,
    FollowUpResponse,
    MemoryItem,
    MemoryListResponse,
    StructuredFollowUpAnswer,
    StructuredInsight,
)
from app.services.database import memory_repository
from app.services.storage import storage_service
from app.services.vlm import vlm_service
from app.services.vision import vision_service

router = APIRouter()

FOOD_SCAN_THINKING_STEPS = [
    "检查图像是否包含食物",
    "识别主要食材与份量",
    "估算热量与三大营养素",
    "生成饮食建议与过敏原提示",
]

FOOD_SCAN_THINKING_STEP_DELAYS_SEC = [2.8, 3.0, 3.2, 0]


def _record_to_item(record, base_url: str = "") -> MemoryItem:
    insight = StructuredInsight.model_validate(json.loads(record.insight_json))
    return MemoryItem(
        id=record.id,
        title=record.title,
        category=record.category,
        agent_id=AgentId(record.agent_id),
        image_url=f"{base_url}/uploads/{record.image_filename}",
        thumbnail_url=f"{base_url}/uploads/{record.thumbnail_filename}",
        insight=insight,
        created_at=record.created_at.isoformat() if record.created_at else "",
        locale=record.locale,
    )


@router.post("/analyze")
async def analyze_image(
    image: UploadFile = File(...),
    locale: str = Form(default="zh-CN"),
    latitude: Optional[float] = Form(default=None),
    longitude: Optional[float] = Form(default=None),
    agent_override: Optional[str] = Form(default=None),
):
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")

    override = AgentId(agent_override) if agent_override else None
    _, filename, processed = storage_service.save_image(data)
    thumb_filename = filename.replace(".jpg", "_thumb.jpg")

    image_b64 = base64.b64encode(processed).decode("utf-8")
    caption = await vision_service.describe_image(image_b64, locale, image_bytes=processed)

    agent_id = await scene_router.route(processed, agent_override=override, image_caption=caption)
    insight = await insight_planner.analyze(
        processed,
        agent_id,
        locale=locale,
        image_caption=caption,
        latitude=latitude,
        longitude=longitude,
    )

    record = await memory_repository.create(
        title=insight.title,
        category=insight.category,
        agent_id=insight.agent_id.value,
        image_filename=filename,
        thumbnail_filename=thumb_filename,
        insight=insight.model_dump(),
        locale=locale,
        image_caption=caption,
        latitude=latitude,
        longitude=longitude,
    )

    return {
        "memory_id": record.id,
        "agent_id": insight.agent_id.value,
        "followup_chips": resolve_followup_chips(insight),
        "insight": insight.model_dump(),
        "image_url": f"/uploads/{filename}",
        "thumbnail_url": f"/uploads/{thumb_filename}",
    }


@router.post("/analyze/stream")
async def analyze_image_stream(
    image: UploadFile = File(...),
    locale: str = Form(default="zh-CN"),
    latitude: Optional[float] = Form(default=None),
    longitude: Optional[float] = Form(default=None),
    agent_override: Optional[str] = Form(default=None),
):
    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty image")

    override = AgentId(agent_override) if agent_override else None
    _, filename, processed = storage_service.save_image(data)
    thumb_filename = filename.replace(".jpg", "_thumb.jpg")

    async def event_generator() -> AsyncGenerator[dict, None]:
        yield {"event": "status", "data": json.dumps({"stage": "captioning"})}

        image_b64 = base64.b64encode(processed).decode("utf-8")
        caption = await vision_service.describe_image(image_b64, locale, image_bytes=processed)

        yield {"event": "status", "data": json.dumps({"stage": "routing"})}

        agent_id = await scene_router.route(processed, agent_override=override, image_caption=caption)
        yield {
            "event": "agent",
            "data": json.dumps({"agent_id": agent_id.value}),
        }

        yield {"event": "status", "data": json.dumps({"stage": "analyzing"})}

        analyze_task = asyncio.create_task(
            insight_planner.analyze(
                processed,
                agent_id,
                locale=locale,
                image_caption=caption,
                latitude=latitude,
                longitude=longitude,
            )
        )

        if agent_id == AgentId.FOOD_SCAN:
            for index, step in enumerate(FOOD_SCAN_THINKING_STEPS):
                if analyze_task.done():
                    break
                yield {
                    "event": "thinking",
                    "data": json.dumps({"step": step, "index": index}),
                }
                delay = (
                    FOOD_SCAN_THINKING_STEP_DELAYS_SEC[index]
                    if index < len(FOOD_SCAN_THINKING_STEP_DELAYS_SEC)
                    else 0
                )
                if delay <= 0:
                    break
                await asyncio.sleep(delay)

        insight = await analyze_task

        yield {
            "event": "partial",
            "data": json.dumps(
                {
                    "title": insight.title,
                    "category": insight.category,
                    "confidence": insight.confidence,
                }
            ),
        }

        record = await memory_repository.create(
            title=insight.title,
            category=insight.category,
            agent_id=insight.agent_id.value,
            image_filename=filename,
            thumbnail_filename=thumb_filename,
            insight=insight.model_dump(),
            locale=locale,
            image_caption=caption,
            latitude=latitude,
            longitude=longitude,
        )

        yield {
            "event": "complete",
            "data": json.dumps(
                {
                    "memory_id": record.id,
                    "agent_id": insight.agent_id.value,
                    "followup_chips": resolve_followup_chips(insight),
                    "insight": insight.model_dump(),
                    "image_url": f"/uploads/{filename}",
                    "thumbnail_url": f"/uploads/{thumb_filename}",
                }
            ),
        }

    return EventSourceResponse(event_generator())


@router.post("/followup", response_model=FollowUpResponse)
async def followup(body: FollowUpRequest):
    record = await memory_repository.get(body.memory_id)
    if not record:
        raise HTTPException(status_code=404, detail="Memory not found")

    image_bytes = storage_service.read_image_bytes(record.image_filename)
    image_b64 = base64.b64encode(image_bytes).decode("utf-8")
    insight = json.loads(record.insight_json)
    followup_history = json.loads(record.followups_json or "[]")

    result = await vlm_service.followup(
        image_b64,
        body.question,
        insight,
        locale=body.locale,
        image_caption=record.image_caption or None,
        followup_history=followup_history,
        agent_id=record.agent_id,
        latitude=record.latitude,
        longitude=record.longitude,
    )

    structured_raw = result.get("structured_answer")
    structured_answer: Optional[StructuredFollowUpAnswer] = None
    if isinstance(structured_raw, dict):
        try:
            structured_answer = StructuredFollowUpAnswer.model_validate(structured_raw)
        except Exception:
            structured_answer = None

    answer = result.get("answer", "")
    if structured_answer and structured_answer.summary:
        answer = structured_answer.summary

    structured_dict = structured_answer.model_dump() if structured_answer else None
    await memory_repository.append_followup(
        body.memory_id,
        body.question,
        answer,
        structured_answer=structured_dict,
    )

    return FollowUpResponse(
        memory_id=body.memory_id,
        answer=answer,
        structured_answer=structured_answer,
        suggested_followups=flatten_followup_suggestions(result),
    )


@router.get("/memories", response_model=MemoryListResponse)
async def list_memories(limit: int = 50):
    records = await memory_repository.list_all(limit=limit)
    items = [_record_to_item(r) for r in records]
    return MemoryListResponse(items=items, total=len(items))


@router.get("/memories/{memory_id}")
async def get_memory(memory_id: str):
    record = await memory_repository.get(memory_id)
    if not record:
        raise HTTPException(status_code=404, detail="Memory not found")
    followups = json.loads(record.followups_json or "[]")
    item = _record_to_item(record)
    return {"memory": item, "followups": followups}


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: str):
    record = await memory_repository.delete(memory_id)
    if not record:
        raise HTTPException(status_code=404, detail="Memory not found")
    storage_service.delete_image_files(record.image_filename, record.thumbnail_filename)
    return {"ok": True, "memory_id": memory_id}


@router.get("/agents")
async def list_agents():
    return {
        "agents": [
            {"id": AgentId.LOCAL_GUIDE.value, "name": "本地向导", "icon": "map"},
            {"id": AgentId.ART_CRITIC.value, "name": "艺术评论家", "icon": "palette"},
            {"id": AgentId.DESIGN_CRITIC.value, "name": "设计评论家", "icon": "chair"},
            {"id": AgentId.STYLIST.value, "name": "造型师", "icon": "shirt"},
            {"id": AgentId.FOOD_EXPLORER.value, "name": "美食探索", "icon": "utensils"},
            {"id": AgentId.FOOD_SCAN.value, "name": "食识拍", "icon": "scan"},
            {"id": AgentId.TEXT_READER.value, "name": "文字解读", "icon": "text"},
            {"id": AgentId.GENERAL_CURIOSITY.value, "name": "好奇心", "icon": "sparkles"},
        ]
    }
