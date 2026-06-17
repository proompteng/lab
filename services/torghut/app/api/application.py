"""Shared FastAPI application ownership for API modules."""

from __future__ import annotations

from fastapi import FastAPI

_current_app: FastAPI | None = None


def register_app(app: FastAPI) -> FastAPI:
    """Register the process-local FastAPI app used by route helpers."""

    global _current_app

    _current_app = app
    return app


def get_app() -> FastAPI:
    """Return the registered FastAPI app."""

    if _current_app is None:
        raise RuntimeError("torghut FastAPI app is not registered")
    return _current_app


__all__ = ("get_app", "register_app")
