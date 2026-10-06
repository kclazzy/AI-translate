"""HTTP API of the engine. Security: loopback/LAN host check, extension-only CORS, bearer token."""
from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import time
from collections import defaultdict, deque
from typing import Any

import httpx
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ValidationError

from . import __version__
from .config import Settings
from .entitlements import check_entitlement
from .errors import AppError
from .jobs import JobManager
from .pipeline import Engine
from .schemas import TranslateOptions
from .translation import translate_blocks

log = logging.getLogger("ait.api")

PUBLIC_PATHS = {"/v1/health"}
EXTENSION_SCHEMES = ("chrome-extension://", "moz-extension://", "safari-web-extension://", "extension://")


def _host_allowed(host_header: str, lan: bool) -> bool:
    host = host_header.strip().lower()
    if host.startswith("["):
        host = host[1:].split("]")[0]
    elif host.count(":") == 1:
        host = host.split(":")[0]
    if host in ("localhost", "127.0.0.1", "::1", "testserver"):
        return True
    if not lan:
        return False
    if host.endswith(".local") or host.endswith(".lan"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return ip.is_private or ip.is_loopback or ip in ipaddress.ip_network("100.64.0.0/10")


def _origin_allowed(origin: str, settings: Settings) -> bool:
    return origin.startswith(EXTENSION_SCHEMES) or origin in settings.allowed_origins


class RateLimiter:
    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        q = self.hits[key]
        while q and now - q[0] > 60:
            q.popleft()
        if len(q) >= self.per_minute:
            return False
        q.append(now)
        return True


def _error(err: AppError) -> JSONResponse:
    return JSONResponse({"error": err.to_dict()}, status_code=err.status)


def create_app(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    token = settings.ensure_token()
    engine = Engine(settings, transport)
    jobs = JobManager()
    limiter = RateLimiter(per_minute=120)
    app = FastAPI(title="AI Translate engine", version=__version__, docs_url=None, redoc_url=None, openapi_url="/v1/openapi.json")
    app.state.engine = engine
    app.state.jobs = jobs

    def cors_headers(origin: str | None) -> dict[str, str]:
        if not origin or not _origin_allowed(origin, settings):
            return {}
        return {
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin",
            "Access-Control-Allow-Headers": "authorization, content-type, accept",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Max-Age": "600",
        }

    @app.middleware("http")
    async def guard(request: Request, call_next):
        # DNS-rebinding defence: only answer to loopback (or private LAN when enabled) host names.
        if not _host_allowed(request.headers.get("host", ""), settings.lan):
            return _error(AppError("ENGINE_UNAUTHORIZED", "Host not allowed", retryable=False))
        origin = request.headers.get("origin")
        # Web pages may not call the engine; extensions and the configured app origins may.
        if origin and not _origin_allowed(origin, settings):
            return _error(AppError("ENGINE_UNAUTHORIZED", "Origin not allowed", retryable=False))
        if request.method == "OPTIONS":
            return Response(status_code=204, headers=cors_headers(origin))
        if request.url.path not in PUBLIC_PATHS:
            auth = request.headers.get("authorization", "")
            given = auth[7:] if auth.lower().startswith("bearer ") else ""
            if not given or not hmac.compare_digest(given.encode(), token.encode()):
                resp = _error(AppError("ENGINE_UNAUTHORIZED", "Missing or wrong pairing token", retryable=False))
                resp.headers.update(cors_headers(origin))
                return resp
        client = request.client.host if request.client else "?"
        if request.method == "POST" and not limiter.allow(client):
            resp = _error(AppError("RATE_LIMITED", "Too many requests", retry_after_ms=5000))
            resp.headers.update(cors_headers(origin))
            return resp
        try:
            response = await call_next(request)
        except AppError as err:
            response = _error(err)
        response.headers.update(cors_headers(origin))
        return response

    @app.exception_handler(AppError)
    async def app_error_handler(_request: Request, err: AppError):
        return _error(err)

    def parse_options(raw: str) -> TranslateOptions:
        try:
            return TranslateOptions.model_validate(json.loads(raw or "{}"))
        except (json.JSONDecodeError, ValidationError) as exc:
            raise AppError("UNSUPPORTED_FORMAT", "Invalid options", retryable=False, detail=str(exc)[:300]) from exc

    async def read_upload(upload: UploadFile) -> bytes:
        data = await upload.read(settings.max_upload_bytes + 1)
        if len(data) > settings.max_upload_bytes:
            raise AppError("IMAGE_TOO_LARGE", "Upload too large", retryable=False)
        if not data:
            raise AppError("UNSUPPORTED_FORMAT", "Empty upload", retryable=False)
        return data

    @app.get("/v1/health")
    async def health(request: Request) -> dict[str, Any]:
        auth = request.headers.get("authorization", "")
        authorized = auth.lower().startswith("bearer ") and hmac.compare_digest(auth[7:].encode(), token.encode())
        base: dict[str, Any] = {"status": "ok", "version": __version__, "paired": bool(authorized)}
        if authorized:
            base.update(engine.capabilities())
            base["paired"] = True
            base["lan"] = settings.lan
        return base

    @app.get("/v1/capabilities")
    async def capabilities() -> dict[str, Any]:
        caps = engine.capabilities()
        caps["limits"] = {"maxUploadBytes": settings.max_upload_bytes, "maxPixels": settings.max_pixels}
        caps["usage"] = engine.cache.usage_totals()
        return caps

    @app.post("/v1/pages/translate", status_code=202)
    async def translate_page(image: UploadFile = File(...), options: str = Form("{}")) -> dict[str, str]:
        check_entitlement("local", "translate_page")
        data = await read_upload(image)
        opts = parse_options(options)
        job = jobs.create(lambda emit: engine.process(data, opts, emit))
        return {"jobId": job.id}

    @app.get("/v1/jobs/{job_id}")
    async def job_status(job_id: str) -> dict[str, Any]:
        job = jobs.get(job_id)
        return {"id": job.id, "finished": job.finished, "result": job.result, "error": job.error, "events": [e for e, _ in job.events]}

    @app.delete("/v1/jobs/{job_id}")
    async def cancel_job(job_id: str) -> dict[str, bool]:
        return {"cancelled": jobs.cancel(job_id)}

    @app.get("/v1/jobs/{job_id}/events")
    async def job_events(job_id: str):
        jobs.get(job_id)
        return StreamingResponse(jobs.stream(job_id), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})

    @app.get("/v1/assets/{asset_id}")
    async def asset(asset_id: str):
        data = engine.assets.get(asset_id)
        if data is None:
            raise AppError("NOT_FOUND", "Asset not found", retryable=False)
        return Response(data, media_type="image/png", headers={"cache-control": "private, max-age=86400"})

    @app.post("/v1/ocr/region")
    async def ocr_region(image: UploadFile = File(...), box: str = Form(...), options: str = Form("{}")) -> dict[str, Any]:
        data = await read_upload(image)
        try:
            b = [int(v) for v in json.loads(box)]
            assert len(b) == 4
        except Exception as exc:
            raise AppError("UNSUPPORTED_FORMAT", "box must be [x, y, w, h]", retryable=False) from exc
        blocks = await engine.ocr_region(data, (b[0], b[1], b[2], b[3]), parse_options(options))
        return {"blocks": blocks}

    @app.post("/v1/text/translate")
    async def text_translate(request: Request) -> dict[str, Any]:
        body = await request.json()
        opts = TranslateOptions.model_validate(body.get("options") or {})
        blocks = [{"id": str(b["id"]), "type": str(b.get("type", "DIALOGUE")), "text": str(b["text"])[:1000]} for b in body.get("blocks", [])][:200]
        cfg = opts.translator or opts.vision
        if not cfg:
            raise AppError("NOT_CONFIGURED", "No translation model configured", retryable=False)
        from .llm import assert_privacy

        assert_privacy(opts.privacy, cfg, "text")
        res = await translate_blocks(engine.client(cfg), opts, blocks)
        return {"translations": res.translations, "entities": res.entities, "summary": res.summary, "usage": [u.dump() for u in res.usage]}

    @app.post("/v1/inpaint")
    async def inpaint(image: UploadFile = File(...), mask: UploadFile = File(...)):
        out = await engine.inpaint(await read_upload(image), await read_upload(mask))
        return Response(out, media_type="image/png")

    return app
