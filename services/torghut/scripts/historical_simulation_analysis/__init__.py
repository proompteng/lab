"""Historical simulation report analysis package."""

from __future__ import annotations

from .report_builder import main
from .report_helpers import (
    REPORT_SCHEMA_VERSION,
)

__all__ = (
    "REPORT_SCHEMA_VERSION",
    "main",
)
