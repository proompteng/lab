from __future__ import annotations

# ruff: noqa: F401

from datetime import datetime, timezone
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast
from unittest import TestCase
from unittest.mock import MagicMock, patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import VNextEmpiricalJobRun
from app.trading.empirical_jobs import (
    EMPIRICAL_JOB_TYPES,
    build_empirical_benchmark_parity_report,
    build_empirical_foundation_router_parity_report,
    promote_janus_payload_to_empirical,
)
from scripts import renew_latest_empirical_promotion_jobs as renewal
from scripts.renew_latest_empirical_promotion_jobs import build_renewal_manifest
from scripts.run_empirical_promotion_jobs import _build_janus_summary


class RunEmpiricalPromotionJobsTestCase(TestCase):
    def setUp(self) -> None:
        super().setUp()
        from tempfile import TemporaryDirectory

        self._tmp_dir_context = TemporaryDirectory()
        self.tmp_dir = Path(self._tmp_dir_context.name)

    def tearDown(self) -> None:
        self._tmp_dir_context.cleanup()
        super().tearDown()


__all__ = ("RunEmpiricalPromotionJobsTestCase",)
