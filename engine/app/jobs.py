"""In-memory job registry with event streams for Server-Sent Events."""
from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Awaitable, Callable

from .errors import AppError, to_app_error

JOB_TTL_SECONDS = 30 * 60


@dataclass
class Job:
    id: str
    created: float = field(default_factory=time.time)
    events: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    cond: asyncio.Condition = field(default_factory=asyncio.Condition)
    task: asyncio.Task | None = None
    finished: bool = False
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}

    def _gc(self) -> None:
        now = time.time()
        for jid in [j.id for j in self.jobs.values() if j.finished and now - j.created > JOB_TTL_SECONDS]:
            self.jobs.pop(jid, None)

    def create(self, work: Callable[[Callable[[str, dict[str, Any]], Awaitable[None]]], Awaitable[dict[str, Any]]]) -> Job:
        self._gc()
        job = Job(id=uuid.uuid4().hex)
        self.jobs[job.id] = job

        async def emit(event: str, data: dict[str, Any]) -> None:
            async with job.cond:
                job.events.append((event, data))
                job.cond.notify_all()

        async def runner() -> None:
            try:
                job.result = await work(emit)
                await emit("done", job.result)
            except BaseException as exc:  # includes CancelledError
                err = to_app_error(exc)
                job.error = err.to_dict()
                await emit("error", job.error)
                if isinstance(exc, asyncio.CancelledError):
                    pass
            finally:
                job.finished = True
                async with job.cond:
                    job.cond.notify_all()

        job.task = asyncio.create_task(runner())
        return job

    def get(self, job_id: str) -> Job:
        job = self.jobs.get(job_id)
        if not job:
            raise AppError("NOT_FOUND", "Job not found", retryable=False)
        return job

    def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.finished or not job.task:
            return False
        job.task.cancel()
        return True

    async def stream(self, job_id: str, heartbeat: float = 15.0) -> AsyncIterator[str]:
        job = self.get(job_id)
        sent = 0
        while True:
            async with job.cond:
                if sent >= len(job.events) and not job.finished:
                    try:
                        await asyncio.wait_for(job.cond.wait(), timeout=heartbeat)
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
                        continue
                pending = job.events[sent:]
                sent = len(job.events)
                finished = job.finished
            for event, data in pending:
                yield sse(event, data)
                if event in ("done", "error"):
                    return
            if finished and sent >= len(job.events):
                return


def sse(event: str, data: dict[str, Any]) -> str:
    import json

    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
