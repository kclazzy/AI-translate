"""LLM providers (OpenAI-compatible and Anthropic) for the engine, with retries and privacy checks."""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import random
import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, TypeVar
from urllib.parse import urlparse

import httpx

from .errors import AppError
from .schemas import ProviderConfig, Usage

T = TypeVar("T")


def is_local_url(url: str) -> bool:
    """Local means this machine or a private network, decided from the URL only."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    if host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".lan") or host.endswith(".home.arpa"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    return isinstance(ip, ipaddress.IPv4Address) and ip in ipaddress.ip_network("100.64.0.0/10")


def assert_privacy(mode: str, cfg: ProviderConfig, sends: str) -> None:
    if mode == "cloud" or is_local_url(cfg.base_url):
        return
    if mode == "hybrid" and sends == "text":
        return
    raise AppError("PRIVACY_VIOLATION", f"{cfg.label} is not local (mode={mode}, payload={sends})", retryable=False)


@dataclass
class Completion:
    text: str
    input_tokens: int
    output_tokens: int
    model: str


_THINK = re.compile(r"<think>.*?</think>", re.S | re.I)


def strip_thinking(text: str) -> str:
    """Drop <think>…</think> reasoning that local reasoning models put into the answer."""
    out = _THINK.sub("", text)
    close = out.rfind("</think>")
    if close >= 0:
        out = out[close + 8 :]
    open_ = out.find("<think>")
    if open_ >= 0:
        out = out[:open_]
    return out.strip()


def image_part(png_or_jpeg: bytes, mime: str) -> dict[str, Any]:
    return {"type": "image", "mime": mime, "base64": base64.b64encode(png_or_jpeg).decode("ascii")}


def _map_http_error(resp: httpx.Response, label: str) -> AppError:
    detail = f"{label} HTTP {resp.status_code}: {resp.text[:300]}"
    s = resp.status_code
    if s in (401, 403):
        return AppError("INVALID_API_KEY", retryable=False, detail=detail)
    if s == 429:
        ra = resp.headers.get("retry-after")
        try:
            ms = int(float(ra) * 1000) if ra else None
        except ValueError:
            ms = None
        return AppError("RATE_LIMITED", detail=detail, retry_after_ms=ms)
    if s == 413:
        return AppError("IMAGE_TOO_LARGE", retryable=False, detail=detail)
    if s in (408, 504):
        return AppError("TIMEOUT", detail=detail)
    if s >= 500 or s == 529:
        return AppError("PROVIDER_UNAVAILABLE", detail=detail)
    if s == 404:
        return AppError("PROVIDER_UNAVAILABLE", retryable=False, detail=detail + " (check base URL and model)")
    return AppError("TRANSLATION_FAILED", retryable=False, detail=detail)


class LlmClient:
    """One client for both API styles. `transport` lets tests plug in a mock server."""

    def __init__(self, cfg: ProviderConfig, transport: httpx.AsyncBaseTransport | None = None):
        self.cfg = cfg
        self.transport = transport

    async def complete(self, system: str, messages: list[dict[str, Any]], *, json_mode: bool = True, max_tokens: int = 4096, temperature: float | None = None) -> Completion:
        local = is_local_url(self.cfg.base_url)
        timeout = (self.cfg.timeout_ms or (600_000 if local else 120_000)) / 1000
        async with httpx.AsyncClient(timeout=timeout, transport=self.transport) as client:
            try:
                if self.cfg.kind == "anthropic":
                    return await self._anthropic(client, system, messages, json_mode, max_tokens, temperature)
                return await self._openai(client, system, messages, json_mode, max_tokens, temperature)
            except httpx.TimeoutException as exc:
                raise AppError("TIMEOUT", detail=self.cfg.label) from exc
            except httpx.TransportError as exc:
                raise AppError("PROVIDER_UNAVAILABLE", detail=f"{self.cfg.label}: {exc}") from exc

    async def _openai(self, client: httpx.AsyncClient, system: str, messages: list[dict[str, Any]], json_mode: bool, max_tokens: int, temperature: float | None) -> Completion:
        local = is_local_url(self.cfg.base_url)
        no_thinking = self.cfg.no_thinking if self.cfg.no_thinking is not None else local
        msgs: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for m in messages:
            content = m["content"]
            if isinstance(content, list):
                content = [
                    {"type": "text", "text": p["text"]} if p["type"] == "text" else {"type": "image_url", "image_url": {"url": f"data:{p['mime']};base64,{p['base64']}"}}
                    for p in content
                ]
            msgs.append({"role": m["role"], "content": content})
        if no_thinking:
            for m in reversed(msgs):
                if m["role"] == "user":
                    if isinstance(m["content"], str):
                        m["content"] = m["content"] + "\n/no_think"
                    else:
                        m["content"] = [*m["content"], {"type": "text", "text": "/no_think"}]
                    break
        body: dict[str, Any] = {
            "model": self.cfg.model,
            "messages": msgs,
            "temperature": temperature if temperature is not None else (self.cfg.temperature if self.cfg.temperature is not None else 0.2),
            "max_tokens": self.cfg.max_output_tokens or max_tokens,
            "stream": False,
        }
        if json_mode and self.cfg.json_mode == "json_object":
            body["response_format"] = {"type": "json_object"}
        if no_thinking and local:
            body["chat_template_kwargs"] = {"enable_thinking": False}
        headers = {"content-type": "application/json"}
        if self.cfg.api_key:
            headers["authorization"] = f"Bearer {self.cfg.api_key}"
        resp = await client.post(self.cfg.base_url.rstrip("/") + "/chat/completions", json=body, headers=headers)
        if resp.status_code >= 400:
            raise _map_http_error(resp, self.cfg.label)
        data = resp.json()
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        if isinstance(content, list):
            content = "".join(p.get("text", "") for p in content)
        content = strip_thinking(content or "")
        if not content:
            raise AppError("TRANSLATION_INVALID_OUTPUT", detail="Empty completion")
        usage = data.get("usage") or {}
        return Completion(content, int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0), data.get("model") or self.cfg.model)

    async def _anthropic(self, client: httpx.AsyncClient, system: str, messages: list[dict[str, Any]], json_mode: bool, max_tokens: int, temperature: float | None) -> Completion:
        if not self.cfg.api_key:
            raise AppError("INVALID_API_KEY", retryable=False, detail="Anthropic API key is empty")
        msgs: list[dict[str, Any]] = []
        for m in messages:
            content = m["content"]
            if isinstance(content, list):
                content = [
                    {"type": "text", "text": p["text"]} if p["type"] == "text" else {"type": "image", "source": {"type": "base64", "media_type": p["mime"], "data": p["base64"]}}
                    for p in content
                ]
            msgs.append({"role": m["role"], "content": content})
        if json_mode:
            msgs.append({"role": "assistant", "content": "{"})
        body = {
            "model": self.cfg.model,
            "system": system,
            "messages": msgs,
            "max_tokens": self.cfg.max_output_tokens or max_tokens,
            "temperature": temperature if temperature is not None else (self.cfg.temperature if self.cfg.temperature is not None else 0.2),
        }
        headers = {"content-type": "application/json", "x-api-key": self.cfg.api_key, "anthropic-version": "2023-06-01"}
        base = self.cfg.base_url or "https://api.anthropic.com/v1"
        resp = await client.post(base.rstrip("/") + "/messages", json=body, headers=headers)
        if resp.status_code >= 400:
            raise _map_http_error(resp, self.cfg.label)
        data = resp.json()
        text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
        if json_mode:
            text = "{" + text
        usage = data.get("usage") or {}
        return Completion(text, int(usage.get("input_tokens") or 0), int(usage.get("output_tokens") or 0), data.get("model") or self.cfg.model)

    def usage(self, c: Completion) -> Usage:
        cost = ((self.cfg.price_input or 0) * c.input_tokens + (self.cfg.price_output or 0) * c.output_tokens) / 1_000_000
        return Usage(provider=self.cfg.label, model=c.model, input_tokens=c.input_tokens, output_tokens=c.output_tokens, cost_usd=cost)


async def with_retry(fn: Callable[[int], Awaitable[T]], retries: int = 2, base_ms: int = 600, max_ms: int = 10_000) -> T:
    attempt = 0
    while True:
        try:
            return await fn(attempt)
        except AppError as err:
            if not err.retryable or attempt >= retries:
                raise
            exp = min(max_ms, base_ms * 2**attempt)
            delay = (err.retry_after_ms or (exp / 2 + random.random() * exp / 2)) / 1000
            attempt += 1
            await asyncio.sleep(delay)
