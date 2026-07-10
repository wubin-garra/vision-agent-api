import io
import uuid
from pathlib import Path

from PIL import Image

from app.config import settings


class StorageService:
    def __init__(self) -> None:
        self.upload_dir = Path(settings.upload_dir)
        self.upload_dir.mkdir(parents=True, exist_ok=True)

    def save_image(self, data: bytes, prefix: str = "img") -> tuple[str, str, bytes]:
        image_id = f"{prefix}_{uuid.uuid4().hex[:12]}"
        processed = self._process_image(data)
        original_path = self.upload_dir / f"{image_id}.jpg"
        thumb_path = self.upload_dir / f"{image_id}_thumb.jpg"

        original_path.write_bytes(processed)
        thumb = self._make_thumbnail(processed)
        thumb_path.write_bytes(thumb)

        return image_id, str(original_path.name), processed

    def get_image_path(self, filename: str) -> Path:
        return self.upload_dir / filename

    def read_image_bytes(self, filename: str) -> bytes:
        return self.get_image_path(filename).read_bytes()

    def _process_image(self, data: bytes) -> bytes:
        img = Image.open(io.BytesIO(data))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img.thumbnail((settings.max_image_size, settings.max_image_size), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=80, optimize=True)
        return buf.getvalue()

    def _make_thumbnail(self, data: bytes, size: int = 256) -> bytes:
        img = Image.open(io.BytesIO(data))
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=75, optimize=True)
        return buf.getvalue()


storage_service = StorageService()
