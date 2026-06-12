from __future__ import annotations

# ruff: noqa: F401

import io
import json
import sys
from argparse import Namespace
from contextlib import redirect_stdout
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from app.trading.discovery.replay_tape import (
    HPAIRS_REPLAY_TAPE_FEATURE_SCHEMA_VERSION,
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeCoverageError,
    ReplayTapeManifest,
    build_hpairs_replay_tape_feature_schema_hash,
    hpairs_replay_tape_feature_versions,
    build_replay_tape_cache_identity_diagnostics,
    build_replay_tape_cache_key,
    build_source_query_digest,
    default_manifest_path,
    load_replay_tape,
    materialize_signal_tape,
    signal_from_tape_payload,
    slice_tape_by_symbols,
    slice_tape_by_window,
    validate_tape_freshness,
)
from app.trading.models import SignalEnvelope
from scripts import materialize_replay_tape as materialize_cli
from scripts.local_intraday_tsmom_replay import (
    ReplayConfig,
    _iter_signal_rows,
    _iter_signal_rows_from_replay_tape,
)


class _TestReplayTapeBase(TestCase):
    def _signal(
        self,
        *,
        day: int,
        seq: int,
        symbol: str = "META",
        price: str = "100.25",
        month: int = 3,
    ) -> SignalEnvelope:
        return SignalEnvelope(
            event_ts=datetime(2026, month, day, 17, 30, seq, tzinfo=timezone.utc),
            symbol=symbol,
            timeframe="1Sec",
            seq=seq,
            source="ta",
            payload={
                "price": Decimal(price),
                "spread": Decimal("0.02"),
                "nested": {"bid_px": Decimal("100.24"), "label": "keep-string"},
                "levels": [Decimal("100.24"), Decimal("100.26")],
                "computed_at": datetime(2026, month, day, 17, 30, tzinfo=timezone.utc),
                "window_size": "PT1S",
            },
            ingest_ts=datetime(2026, month, day, 17, 31, tzinfo=timezone.utc),
        )


__all__ = [name for name in globals() if not name.startswith("__")]
