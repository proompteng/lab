from __future__ import annotations


import json
import os
from pathlib import Path
from unittest import TestCase
from unittest.mock import patch

from pydantic import ValidationError
import yaml

from app.config import FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD, Settings
from app.trading.llm.dspy_programs.runtime import DSPyReviewRuntime


class _MockFlagResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self._payload = json.dumps(payload).encode("utf-8")
        self.status = status

    def read(self) -> bytes:
        return self._payload

    def __enter__(self) -> "_MockFlagResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


class _TestConfigBase(TestCase):
    pass


__all__: tuple[str, ...] = ()

__all__: tuple[str, ...] = (
    "DSPyReviewRuntime",
    "FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD",
    "Path",
    "Settings",
    "TestCase",
    "ValidationError",
    "_MockFlagResponse",
    "_TestConfigBase",
    "json",
    "os",
    "patch",
    "yaml",
)
