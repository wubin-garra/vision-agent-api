from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.api.routes import analyze, share
from app.config import settings
from app.services.database import init_db
from app.services.storage import storage_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    Path(settings.upload_dir).mkdir(parents=True, exist_ok=True)
    await init_db()
    yield


app = FastAPI(title=settings.app_name, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analyze.router, prefix=settings.api_prefix, tags=["analyze"])
app.include_router(share.router, prefix=settings.api_prefix, tags=["share"])
app.mount("/uploads", StaticFiles(directory=str(storage_service.upload_dir)), name="uploads")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "llm_provider": settings.llm_provider,
        "llm_enabled": settings.llm_enabled,
        "llm_model": settings.llm_model if settings.llm_enabled else None,
        "vision_provider": settings.vision_provider,
        "vision_enabled": settings.vision_enabled,
        "vision_model": settings.openai_vision_model if settings.vision_provider == "openai" else settings.dashscope_vision_model,
        "demo_mode": settings.demo_mode,
    }
