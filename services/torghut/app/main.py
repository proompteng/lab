"""torghut FastAPI application entrypoint."""

from __future__ import annotations

from . import bootstrap as app_bootstrap
from .api.application import build_registered_app
from .config import settings

create_app = app_bootstrap.create_app

app = build_registered_app(create_app(), runtime_role=settings.process_role)

__all__ = ("app", "create_app")
