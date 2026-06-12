from __future__ import annotations

# ruff: noqa: F401

from decimal import Decimal
from unittest import TestCase

from app.trading.discovery.candidate_specs import CandidateSpec, compile_candidate_specs
from app.trading.discovery.evidence_bundles import (
    evidence_bundle_from_frontier_candidate,
)
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards
import app.trading.discovery.mlx_training_data as mlx_training_data_module
from app.trading.discovery.mlx_training_data import (
    MlxRankerModel,
    MlxTrainingRow,
    build_mlx_training_rows,
    candidate_spec_capital_features,
    rank_training_rows,
    rank_training_rows_with_lift_policy,
    train_mlx_ranker,
)


def _capital_profile(spec: object) -> object:
    strategy_overrides = getattr(spec, "strategy_overrides", {})
    params = (
        strategy_overrides.get("params")
        if isinstance(strategy_overrides, dict)
        else None
    )
    return params.get("capital_profile") if isinstance(params, dict) else None


class _TestMlxTrainingDataBase(TestCase):
    pass


__all__ = [name for name in globals() if not name.startswith("__")]
