"""Shared FastAPI application ownership for API modules."""

from __future__ import annotations

from fastapi import APIRouter, FastAPI

_current_app: FastAPI | None = None


def register_app(app: FastAPI) -> FastAPI:
    """Register the process-local FastAPI app used by route helpers."""

    global _current_app

    _current_app = app
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
) -> FastAPI:
    """Register the process app and mount its operational routes."""

    register_app(app)
    mount_api_routes(app)
    return app


def get_app() -> FastAPI:
    """Return the registered FastAPI app."""

    if _current_app is None:
        raise RuntimeError("torghut FastAPI app is not registered")
    return _current_app


__all__ = (
    "api_routers",
    "build_registered_app",
    "get_app",
    "mount_api_routes",
    "register_app",
)
