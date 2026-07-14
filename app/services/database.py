import json
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import Column, DateTime, Float, String, Text, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


class MemoryRecord(Base):
    __tablename__ = "memories"

    id = Column(String, primary_key=True)
    user_id = Column(String, default="anonymous", index=True)
    title = Column(String, nullable=False)
    category = Column(String, nullable=False)
    agent_id = Column(String, nullable=False)
    image_filename = Column(String, nullable=False)
    thumbnail_filename = Column(String, nullable=False)
    insight_json = Column(Text, nullable=False)
    locale = Column(String, default="zh-CN")
    followups_json = Column(Text, default="[]")
    image_caption = Column(Text, default="")
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


engine = create_async_engine(settings.database_url, echo=settings.debug)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        try:
            await conn.execute(text("ALTER TABLE memories ADD COLUMN image_caption TEXT DEFAULT ''"))
        except Exception:
            pass
        try:
            await conn.execute(text("ALTER TABLE memories ADD COLUMN latitude REAL"))
        except Exception:
            pass
        try:
            await conn.execute(text("ALTER TABLE memories ADD COLUMN longitude REAL"))
        except Exception:
            pass


class MemoryRepository:
    async def create(
        self,
        *,
        title: str,
        category: str,
        agent_id: str,
        image_filename: str,
        thumbnail_filename: str,
        insight: dict[str, Any],
        locale: str,
        user_id: str = "anonymous",
        image_caption: str = "",
        latitude: Optional[float] = None,
        longitude: Optional[float] = None,
    ) -> MemoryRecord:
        record = MemoryRecord(
            id=str(uuid.uuid4()),
            user_id=user_id,
            title=title,
            category=category,
            agent_id=agent_id,
            image_filename=image_filename,
            thumbnail_filename=thumbnail_filename,
            insight_json=json.dumps(insight, ensure_ascii=False),
            locale=locale,
            image_caption=image_caption,
            latitude=latitude,
            longitude=longitude,
        )
        async with SessionLocal() as session:
            session.add(record)
            await session.commit()
            await session.refresh(record)
            return record

    async def get(self, memory_id: str) -> Optional[MemoryRecord]:
        async with SessionLocal() as session:
            result = await session.execute(select(MemoryRecord).where(MemoryRecord.id == memory_id))
            return result.scalar_one_or_none()

    async def list_all(self, user_id: str = "anonymous", limit: int = 50) -> list[MemoryRecord]:
        async with SessionLocal() as session:
            result = await session.execute(
                select(MemoryRecord)
                .where(MemoryRecord.user_id == user_id)
                .order_by(MemoryRecord.created_at.desc())
                .limit(limit)
            )
            return list(result.scalars().all())

    async def append_followup(
        self,
        memory_id: str,
        question: str,
        answer: str,
        *,
        structured_answer: Optional[dict] = None,
    ) -> None:
        async with SessionLocal() as session:
            result = await session.execute(select(MemoryRecord).where(MemoryRecord.id == memory_id))
            record = result.scalar_one_or_none()
            if not record:
                return
            followups = json.loads(record.followups_json or "[]")
            entry: dict = {
                "question": question,
                "answer": answer,
                "at": datetime.now(timezone.utc).isoformat(),
            }
            if structured_answer:
                entry["structured_answer"] = structured_answer
            followups.append(entry)
            record.followups_json = json.dumps(followups, ensure_ascii=False)
            await session.commit()

    async def delete(self, memory_id: str) -> Optional[MemoryRecord]:
        async with SessionLocal() as session:
            result = await session.execute(select(MemoryRecord).where(MemoryRecord.id == memory_id))
            record = result.scalar_one_or_none()
            if not record:
                return None
            await session.delete(record)
            await session.commit()
            return record


memory_repository = MemoryRepository()
