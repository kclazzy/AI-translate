"""Entitlement system (no payments yet). Plans map features to limits; the local plan is unlimited."""
from __future__ import annotations

from dataclasses import dataclass

from .errors import AppError


@dataclass(frozen=True)
class Plan:
    name: str
    pages_per_day: int | None
    features: frozenset[str]


ALL = frozenset({"translate_page", "ocr_region", "inpaint", "bulk", "projects", "api", "lan"})

PLANS: dict[str, Plan] = {
    "free": Plan("free", pages_per_day=50, features=frozenset({"translate_page", "ocr_region", "projects"})),
    "pro": Plan("pro", pages_per_day=None, features=ALL),
    "api": Plan("api", pages_per_day=None, features=frozenset({"translate_page", "ocr_region", "inpaint", "api"})),
    "local": Plan("local", pages_per_day=None, features=ALL),
}


def check_entitlement(plan_name: str, feature: str) -> None:
    plan = PLANS.get(plan_name)
    if plan is None or feature not in plan.features:
        raise AppError("NOT_CONFIGURED", f"Feature '{feature}' is not available on plan '{plan_name}'", retryable=False)
