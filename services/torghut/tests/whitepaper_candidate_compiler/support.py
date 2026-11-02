from __future__ import annotations


from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

import app.trading.discovery.candidate_specs as candidate_specs_module
import app.trading.discovery.whitepaper_candidate_compiler as compiler_module
from app.trading.discovery.hypothesis_cards import build_hypothesis_cards
from app.trading.discovery.whitepaper_candidate_compiler import (
    compile_claim_payloads_to_whitepaper_experiments,
    compile_whitepaper_candidate_specs,
)


_PORTFOLIO_TARGET_FAMILIES = set(candidate_specs_module._FAMILY_EXECUTION_PROFILES)


def _profile_count_for_family(
    family_template_id: str,
    *,
    target_net_pnl_per_day: Decimal = Decimal("300"),
) -> int:
    return len(
        candidate_specs_module._execution_profiles_for_target(
            family_template_id=family_template_id,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
    )


def _expected_candidate_count(
    family_ids: set[str],
    *,
    target_net_pnl_per_day: Decimal = Decimal("300"),
) -> int:
    return sum(
        _profile_count_for_family(
            family_id,
            target_net_pnl_per_day=target_net_pnl_per_day,
        )
        for family_id in family_ids
    )


def _expected_portfolio_target_candidate_count() -> int:
    return _expected_candidate_count(
        _PORTFOLIO_TARGET_FAMILIES,
        target_net_pnl_per_day=Decimal("500"),
    )


class _TestWhitepaperCandidateCompilerBase(TestCase):
    pass


__all__: tuple[str, ...] = (
    "Decimal",
    "Path",
    "TemporaryDirectory",
    "TestCase",
    "_PORTFOLIO_TARGET_FAMILIES",
    "_TestWhitepaperCandidateCompilerBase",
    "_expected_candidate_count",
    "_expected_portfolio_target_candidate_count",
    "_profile_count_for_family",
    "build_hypothesis_cards",
    "candidate_specs_module",
    "compile_claim_payloads_to_whitepaper_experiments",
    "compile_whitepaper_candidate_specs",
    "compiler_module",
)
