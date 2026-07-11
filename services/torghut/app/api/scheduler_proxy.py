"""Fail-closed proxy from the stateless API to scheduler-owned runtime surfaces."""

from __future__ import annotations

from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi.responses import JSONResponse, Response

from app.config import settings


def proxy_scheduler_response(*, path: str, accept: str) -> Response:
    """Return an exact scheduler response or an explicit unavailable payload."""

    normalized_path = path if path.startswith("/") else f"/{path}"
    base_url = settings.trading_scheduler_runtime_base_url.rstrip("/")
    request = Request(
        f"{base_url}{normalized_path}",
        headers={"Accept": accept},
        method="GET",
    )
    try:
        with urlopen(
            request,
            timeout=settings.trading_scheduler_runtime_timeout_seconds,
        ) as upstream:
            return Response(
                content=upstream.read(),
                status_code=upstream.status,
                media_type=upstream.headers.get_content_type(),
            )
    except HTTPError as exc:
        return Response(
            content=exc.read(),
            status_code=exc.code,
            media_type=exc.headers.get_content_type(),
        )
    except (OSError, TimeoutError, URLError, ValueError) as exc:
        return JSONResponse(
            status_code=503,
            content={
                "ok": False,
                "detail": "scheduler_runtime_unavailable",
                "owner": "torghut-scheduler",
                "error_class": type(exc).__name__,
            },
        )


__all__ = ["proxy_scheduler_response"]
