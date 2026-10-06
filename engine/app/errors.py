from __future__ import annotations

from typing import Any

# Same codes as packages/core/src/errors.ts so clients can show human messages.
RETRYABLE = {"PROVIDER_UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "TRANSLATION_INVALID_OUTPUT", "IMAGE_FETCH_FAILED", "ENGINE_UNAVAILABLE"}

HTTP_STATUS = {
    "IMAGE_TOO_LARGE": 413,
    "UNSUPPORTED_FORMAT": 415,
    "INVALID_API_KEY": 400,
    "PRIVACY_VIOLATION": 400,
    "NOT_CONFIGURED": 400,
    "ENGINE_UNAUTHORIZED": 401,
    "RATE_LIMITED": 429,
    "NOT_FOUND": 404,
}


class AppError(Exception):
    def __init__(self, code: str, message: str | None = None, *, retryable: bool | None = None, detail: str | None = None, retry_after_ms: int | None = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.retryable = code in RETRYABLE if retryable is None else retryable
        self.detail = detail
        self.retry_after_ms = retry_after_ms

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"code": self.code, "message": self.message, "retryable": self.retryable}
        if self.detail:
            d["detail"] = self.detail[:500]
        if self.retry_after_ms:
            d["retryAfterMs"] = self.retry_after_ms
        return d

    @property
    def status(self) -> int:
        return HTTP_STATUS.get(self.code, 500)


def to_app_error(exc: BaseException) -> AppError:
    if isinstance(exc, AppError):
        return exc
    import asyncio

    if isinstance(exc, asyncio.CancelledError):
        return AppError("CANCELLED")
    if isinstance(exc, TimeoutError):
        return AppError("TIMEOUT")
    return AppError("UNKNOWN", str(exc) or exc.__class__.__name__, retryable=False)
