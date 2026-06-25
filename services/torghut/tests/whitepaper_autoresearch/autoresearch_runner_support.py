from __future__ import annotations

from contextlib import contextmanager
from dataclasses import replace
import json
import sys
from argparse import Namespace
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Sequence, cast
from unittest import TestCase
from unittest.mock import patch

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

import scripts.compile_whitepaper_claims as claim_compiler_script
import scripts.run_whitepaper_autoresearch_profit_target as runner
import scripts.train_mlx_autoresearch_ranker as ranker_trainer
from app.models import (
    AutoresearchCandidateSpec,
    AutoresearchEpoch,
    AutoresearchPortfolioCandidate,
    AutoresearchProposalScore,
    Base,
    RejectedSignalOutcomeEvent,
    WhitepaperAnalysisRun,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
)
from app.trading.discovery import fast_replay
from app.trading.discovery.replay_tape import (
    REPLAY_TAPE_MANIFEST_SCHEMA_VERSION,
    ReplayTapeManifest,
    materialize_signal_tape,
)
from app.trading.discovery.evidence_bundles import evidence_bundle_blockers
from app.trading.models import SignalEnvelope

_CHIP_UNIVERSE = list(runner.LIVE_SIGNAL_COVERED_SEMICONDUCTOR_UNIVERSE)


class _FakeSigalrmSignal:
    SIGALRM = object()

    @staticmethod
    def getsignal(_signum: object) -> None:
        return None

    @staticmethod
    def signal(_signum: object, _handler: Any) -> None:
        return None

    @staticmethod
    def alarm(_seconds: int) -> None:
        return None


def _authoritative_exact_replay_ledger_rows() -> list[dict[str, object]]:
    base_row: dict[str, object] = {
        "account_label": "paper",
        "strategy_id": "intraday-tsmom-profit-v3",
        "symbol": "AAPL",
        "source": "exact_replay",
        "execution_policy_hash": "execution-policy-hash",
        "cost_model_hash": "cost-model-hash",
        "lineage_hash": "lineage-hash",
        "replay_data_hash": "replay-data-hash",
    }
    return [
        {
            **base_row,
            "event_type": "decision",
            "executed_at": "2026-05-20T14:00:00Z",
            "side": "buy",
            "decision_id": "decision-1",
            "order_id": "order-1",
        },
        {
            **base_row,
            "event_type": "order_submitted",
            "executed_at": "2026-05-20T14:00:01Z",
            "side": "buy",
            "decision_id": "decision-1",
            "order_id": "order-1",
        },
        {
            **base_row,
            "event_type": "fill",
            "executed_at": "2026-05-20T14:00:02Z",
            "side": "buy",
            "decision_id": "decision-1",
            "order_id": "order-1",
            "filled_qty": "1",
            "avg_fill_price": "100",
            "filled_notional": "100",
            "cost_amount": "0.10",
            "cost_basis": "explicit_replay_fee_model",
        },
        {
            **base_row,
            "event_type": "decision",
            "executed_at": "2026-05-20T14:10:00Z",
            "side": "sell",
            "decision_id": "decision-2",
            "order_id": "order-2",
        },
        {
            **base_row,
            "event_type": "order_submitted",
            "executed_at": "2026-05-20T14:10:01Z",
            "side": "sell",
            "decision_id": "decision-2",
            "order_id": "order-2",
        },
        {
            **base_row,
            "event_type": "fill",
            "executed_at": "2026-05-20T14:10:02Z",
            "side": "sell",
            "decision_id": "decision-2",
            "order_id": "order-2",
            "filled_qty": "1",
            "avg_fill_price": "101",
            "filled_notional": "101",
            "cost_amount": "0.10",
            "cost_basis": "explicit_replay_fee_model",
        },
    ]


def _source_jsonl_payload() -> dict[str, object]:
    return {
        "run_id": "paper-jsonl-2026",
        "title": "Fresh 2026 Microstructure Paper",
        "source_url": "https://example.test/fresh-2026.pdf",
        "published_at": "2026-04-01",
        "claims": [
            {
                "claim_id": "claim-order-flow-signal",
                "claim_type": "signal_mechanism",
                "claim_text": "Order-flow clustering can predict short-horizon continuation.",
                "data_requirements": ["order_flow_imbalance", "spread_bps"],
                "confidence": "0.8",
            },
            {
                "claim_id": "claim-liquidity-risk",
                "claim_type": "risk_constraint",
                "claim_text": "Sizing should be reduced during spread-widening regimes.",
                "data_requirements": ["spread_bps"],
                "confidence": "0.75",
            },
            {
                "claim_id": "claim-holdout-validation",
                "claim_type": "validation_requirement",
                "claim_text": "Validate the signal on held-out liquidity stress windows.",
                "data_requirements": ["spread_bps"],
                "confidence": "0.7",
            },
        ],
        "claim_relations": [
            {
                "relation_id": "rel-support",
                "relation_type": "supports",
                "source_claim_id": "claim-holdout-validation",
                "target_claim_id": "claim-order-flow-signal",
            }
        ],
    }


def _source_from_payload(payload: dict[str, object]) -> runner.WhitepaperResearchSource:
    return runner.WhitepaperResearchSource(
        run_id=str(payload["run_id"]),
        title=str(payload["title"]),
        source_url=str(payload["source_url"]),
        published_at=str(payload["published_at"]),
        claims=tuple(
            cast(dict[str, object], claim)
            for claim in cast(list[object], payload["claims"])
        ),
        claim_relations=tuple(
            cast(dict[str, object], relation)
            for relation in cast(list[object], payload["claim_relations"])
        ),
    )


@contextmanager
def _compact_recent_whitepaper_sources(
    source_count: int = 4,
) -> Any:
    sources: list[runner.WhitepaperResearchSource] = []
    for index in range(source_count):
        payload = _source_jsonl_payload()
        payload["run_id"] = f"compact-seed-2026-{index}"
        payload["title"] = f"Compact 2026 Microstructure Seed {index}"
        sources.append(_source_from_payload(payload))

    midpoint = max(1, source_count // 2)
    with (
        patch.object(
            runner, "_program_whitepaper_sources", return_value=sources[:midpoint]
        ),
        patch.object(runner, "RECENT_WHITEPAPER_SEEDS", tuple(sources[midpoint:])),
    ):
        yield


__all__: tuple[str, ...] = (
    "Any",
    "AutoresearchCandidateSpec",
    "AutoresearchEpoch",
    "AutoresearchPortfolioCandidate",
    "AutoresearchProposalScore",
    "Base",
    "Decimal",
    "Namespace",
    "Path",
    "REPLAY_TAPE_MANIFEST_SCHEMA_VERSION",
    "RejectedSignalOutcomeEvent",
    "ReplayTapeManifest",
    "Sequence",
    "Session",
    "SignalEnvelope",
    "TemporaryDirectory",
    "TestCase",
    "WhitepaperAnalysisRun",
    "WhitepaperClaim",
    "WhitepaperClaimRelation",
    "WhitepaperDocument",
    "WhitepaperDocumentVersion",
    "_CHIP_UNIVERSE",
    "_FakeSigalrmSignal",
    "_authoritative_exact_replay_ledger_rows",
    "_compact_recent_whitepaper_sources",
    "_source_from_payload",
    "_source_jsonl_payload",
    "cast",
    "claim_compiler_script",
    "contextmanager",
    "create_engine",
    "date",
    "datetime",
    "evidence_bundle_blockers",
    "fast_replay",
    "json",
    "materialize_signal_tape",
    "patch",
    "ranker_trainer",
    "replace",
    "runner",
    "select",
    "sys",
    "timezone",
)
