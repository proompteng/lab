#!/usr/bin/env python3
"""Run a whitepaper-driven autoresearch epoch targeting a portfolio profit objective."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


from app.trading.discovery.candidate_specs import (
    CandidateSpec,
)
from app.trading.discovery.evidence_bundles import (
    CandidateEvidenceBundle,
)


@dataclass(frozen=True)
class EpochReplayResult:
    evidence_bundles: tuple[CandidateEvidenceBundle, ...]
    replay_results: tuple[Mapping[str, Any], ...]
    incomplete: bool = False
    failure_reasons: tuple[str, ...] = ()


@dataclass(frozen=True)
class _ReplayShardPlan:
    shard_index: int
    args: argparse.Namespace
    output_dir: Path
    specs: tuple[CandidateSpec, ...]
    timeout_seconds: int


@dataclass(frozen=True)
class _ReplayShardOutcome:
    shard_index: int
    candidate_spec_ids: tuple[str, ...]
    result: EpochReplayResult
    failure: Mapping[str, Any] | None = None


__all__ = [
    "EpochReplayResult",
    "_ReplayShardPlan",
    "_ReplayShardOutcome",
]
