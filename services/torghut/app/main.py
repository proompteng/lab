"""torghut FastAPI application entrypoint."""

from __future__ import annotations

from . import bootstrap as app_bootstrap
from .api.application import build_registered_app

create_app = app_bootstrap.create_app

app = build_registered_app(
    create_app(),
    register_whitepaper_inngest_routes=app_bootstrap.register_whitepaper_inngest_routes,
)

__all__ = ("app", "create_app")
