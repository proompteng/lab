"""Shared FastAPI application ownership for API modules."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, FastAPI

_current_app: FastAPI | None = None

WhitepaperRouteRegistrar = Callable[[FastAPI], object | None]


def register_app(app: FastAPI) -> FastAPI:
    """Register the process-local FastAPI app used by route helpers."""

    global _current_app

    _current_app = app
    return app


def api_routers() -> tuple[APIRouter, ...]:
    """Return the concrete Torghut API routers mounted on the FastAPI app."""

    from .maintenance import router as maintenance_router
    from .proofs import router as proofs_router
    from .readiness import router as readiness_router
    from .runtime_profitability import router as runtime_profitability_router
    from .trading_health import router as trading_health_router
    from .trading_loop_status import router as trading_loop_status_router
    from .trading_misc import router as trading_misc_router
    from .trading_status import router as trading_status_router
    from .whitepaper import router as whitepaper_router

    return (
        readiness_router,
        whitepaper_router,
        trading_status_router,
        trading_loop_status_router,
        maintenance_router,
        trading_misc_router,
        runtime_profitability_router,
        proofs_router,
        trading_health_router,
    )


def mount_api_routes(app: FastAPI) -> FastAPI:
    """Mount Torghut API routers on the registered FastAPI app."""

    for router in api_routers():
        app.include_router(router)
    return app


def build_registered_app(
    app: FastAPI,
    *,
    register_whitepaper_inngest_routes: WhitepaperRouteRegistrar,
) -> FastAPI:
    """Register the process app, mount API routes, and attach workflow routes."""

    register_app(app)
    mount_api_routes(app)
    register_whitepaper_inngest_routes(app)
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
