from __future__ import annotations

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no extra dependency). Existing env vars win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    lan: bool = False
    data_dir: Path = Path("./data")
    allowed_origins: list[str] = field(default_factory=list)
    token: str = ""
    max_upload_bytes: int = 60 * 1024 * 1024
    max_pixels: int = 150_000_000
    lama_onnx: str = ""
    onnx_providers: list[str] = field(default_factory=lambda: ["CUDAExecutionProvider", "CPUExecutionProvider"])
    cache_days: int = 30

    @classmethod
    def from_env(cls, env_file: Path | None = None) -> "Settings":
        _load_dotenv(env_file or Path(".env"))
        e = os.environ
        s = cls(
            host=e.get("AIT_HOST", "127.0.0.1"),
            port=int(e.get("AIT_PORT", "8765")),
            lan=_bool(e.get("AIT_LAN")),
            data_dir=Path(e.get("AIT_DATA_DIR", "./data")),
            allowed_origins=[o.strip() for o in e.get("AIT_ALLOWED_ORIGINS", "capacitor://localhost,http://localhost,https://localhost").split(",") if o.strip()],
            token=e.get("AIT_TOKEN", ""),
            max_upload_bytes=int(float(e.get("AIT_MAX_UPLOAD_MB", "60")) * 1024 * 1024),
            max_pixels=int(e.get("AIT_MAX_PIXELS", "150000000")),
            lama_onnx=e.get("AIT_LAMA_ONNX", ""),
            onnx_providers=[p.strip() for p in e.get("AIT_ONNX_PROVIDERS", "CUDAExecutionProvider,CPUExecutionProvider").split(",") if p.strip()],
            cache_days=int(e.get("AIT_CACHE_DAYS", "30")),
        )
        if s.lan and s.host == "127.0.0.1":
            s.host = "0.0.0.0"
        return s

    def ensure_token(self) -> str:
        """Load or create the pairing token stored in the data directory."""
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if self.token:
            return self.token
        path = self.data_dir / "token"
        if path.exists():
            self.token = path.read_text(encoding="utf-8").strip()
        if not self.token:
            self.token = secrets.token_urlsafe(18)
            path.write_text(self.token, encoding="utf-8")
            try:
                path.chmod(0o600)
            except OSError:
                pass
        return self.token
