"""ClickHouse client helpers for TA visualization APIs."""

from __future__ import annotations

import base64
import json
import logging
import urllib.parse
import urllib.request
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

from .config import settings

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ClickHouseClient:
    """Minimal ClickHouse HTTP client for read-only queries."""

    base_url: str
    database: str
    username: str | None
    password: str | None
    timeout_seconds: int

    def query(self, sql: str) -> list[dict[str, Any]]:
        payload = f"{sql.rstrip()}\nFORMAT JSON".encode("utf-8")
        params = {
            "database": self.database,
            "output_format_json_quote_64bit_integers": "0",
        }
        url = f"{self.base_url}/?{urllib.parse.urlencode(params)}"
        request = urllib.request.Request(
            url,
            data=payload,
            method="POST",
            headers={"Content-Type": "text/plain; charset=utf-8"},
        )
        if self.username:
            token = base64.b64encode(
                f"{self.username}:{self.password or ''}".encode("utf-8")
            ).decode("ascii")
            request.add_header("Authorization", f"Basic {token}")

        with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
            body = response.read().decode("utf-8")

        payload_json = json.loads(body)
        return payload_json.get("data", [])


@lru_cache(maxsize=1)
def get_clickhouse_client() -> ClickHouseClient:
    """Return a cached ClickHouse client instance."""

    return ClickHouseClient(
        base_url=settings.clickhouse_http_url,
        database=settings.clickhouse_database,
        username=settings.clickhouse_username,
        password=settings.clickhouse_password,
        timeout_seconds=settings.clickhouse_timeout_seconds,
    )
