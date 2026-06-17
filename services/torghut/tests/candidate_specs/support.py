from __future__ import annotations

# ruff: noqa: F401

from decimal import Decimal
from pathlib import Path
from unittest import TestCase

from app.strategies.catalog import StrategyCatalogConfig
import app.trading.discovery.candidate_specs as candidate_specs_module
from app.trading.discovery.candidate_specs import (
    candidate_spec_from_payload,
    compile_candidate_specs,
)
from app.trading.discovery.factor_acceptance import build_factor_acceptance_artifact
from app.trading.discovery.factor_acceptance import (
    build_factor_acceptance_artifact_from_scorecard,
)
from app.trading.discovery.hypothesis_cards import (
    HYPOTHESIS_CARD_SCHEMA_VERSION,
    HypothesisCard,
    build_hypothesis_cards,
)
from app.trading.discovery.mlx_training_data import candidate_spec_capital_features
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_whitepaper_candidate_specs,
)
from app.trading.semiconductor_universe import RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE


_CHIP_UNIVERSE_SYMBOLS = set(RESEARCHED_SEMICONDUCTOR_TECH_UNIVERSE)


def _capital_profile(spec: candidate_specs_module.CandidateSpec) -> object:
    params = spec.strategy_overrides.get("params")
    return params.get("capital_profile") if isinstance(params, dict) else None


class _TestCandidateSpecsBase(TestCase):
    pass


__all__: tuple[str, ...] = ()
