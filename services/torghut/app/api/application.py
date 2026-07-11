"""Shared FastAPI application ownership for API modules."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, FastAPI

from app.config import settings

RuntimeRole = Literal["api", "scheduler"]
_apps_by_runtime_role: dict[RuntimeRole, FastAPI] = {}


def register_app(app: FastAPI, *, runtime_role: RuntimeRole = "api") -> FastAPI:
    """Register the process-local FastAPI app used by route helpers."""

    _apps_by_runtime_role[runtime_role] = app
    return app


def api_routers() -> tuple[APIRouter, ...]:
    """Return the concrete Torghut API routers mounted on the FastAPI app."""

    from .metrics import router as metrics_router
    from .readiness import router as readiness_router
    from .trading_status import router as trading_status_router

    return (
        readiness_router,
        trading_status_router,
        metrics_router,
    )


def mount_api_routes(app: FastAPI) -> FastAPI:
    """Mount Torghut API routers on the registered FastAPI app."""

    for router in api_routers():
        app.include_router(router)
    return app


def build_registered_app(
    app: FastAPI,
    *,
    runtime_role: RuntimeRole = "api",
) -> FastAPI:
    """Register the process app and mount its operational routes."""

    register_app(app, runtime_role=runtime_role)
    mount_api_routes(app)
    return app


def get_app(runtime_role: RuntimeRole | None = None) -> FastAPI:
    """Return the registered FastAPI app."""

    resolved_role: RuntimeRole = runtime_role or settings.process_role
    app = _apps_by_runtime_role.get(resolved_role)
    if app is None:
        raise RuntimeError(
            f"torghut FastAPI app is not registered for role={resolved_role}"
        )
    return app


__all__ = (
    "api_routers",
    "build_registered_app",
    "get_app",
    "mount_api_routes",
    "register_app",
    "RuntimeRole",
)
