from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.trading.profit_carry_passports import (
    PROFIT_CARRY_PASSPORT_LEDGER_SCHEMA_VERSION,
    PROFIT_CARRY_PASSPORT_SCHEMA_VERSION,
    REPAIR_CAPACITY_FUTURE_SCHEMA_VERSION,
    build_profit_carry_passport_ledger,
)


NOW = datetime(2026, 5, 13, 18, 0, tzinfo=timezone.utc)


def _replay(
    *,
    hypothesis_id: str,
    replay_class: str,
    symbols: list[str],
    expected_blocker_delta: int,
    expected_profit_effect: str,
    expected_cost_class: str,
    max_runtime_seconds: int,
    blockers: list[str],
) -> dict[str, object]:
    return {
        "replay_id": f"replay:{hypothesis_id}",
        "hypothesis_id": hypothesis_id,
        "target_symbols": symbols,
        "replay_class": replay_class,
        "expected_profit_unlock": {
            "expected_blocker_delta": expected_blocker_delta,
            "expected_profit_effect": expected_profit_effect,
        },
        "expected_cost": {
            "class": expected_cost_class,
            "max_runtime_seconds": max_runtime_seconds,
        },
        "max_runtime_seconds": max_runtime_seconds,
        "max_notional": "0",
        "remaining_blockers": blockers,
        "guardrails": [
            {
                "code": "tca_slippage_guardrail",
                "status": "blocked"
                if "execution_tca_above_guardrail" in blockers
                else "pending",
            }
        ],
        "falsification_rules": [
            "after_refs_missing_or_stale",
            "declared_blocker_not_retired",
        ],
        "before_refs": {
            "jangar_contract_graduation": {
                "contract_ref": "docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md",
                "state": "missing",
            }
        },
    }


def _capital_replay_board() -> dict[str, object]:
    return {
        "schema_version": "torghut.capital-replay-board.v1",
        "board_id": "capital-replay-board:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": (NOW + timedelta(seconds=60)).isoformat(),
        "replay_items": [
            _replay(
                hypothesis_id="H-AAPL-ROUTE-REHAB",
                replay_class="route_rehab",
                symbols=["AAPL"],
                expected_blocker_delta=3,
                expected_profit_effect="can_unlock_paper_candidate_after_receipts",
                expected_cost_class="low_receipt_settlement",
                max_runtime_seconds=600,
                blockers=["execution_tca_above_guardrail", "market_context_stale"],
            ),
            _replay(
                hypothesis_id="H-NVDA-SIM-PROOF-REFILL",
                replay_class="scoped_proof_refill",
                symbols=["NVDA"],
                expected_blocker_delta=2,
                expected_profit_effect="repairs_high_activity_route",
                expected_cost_class="medium_route_evidence_repair",
                max_runtime_seconds=600,
                blockers=["execution_tca_route_universe_exclusions_applied"],
            ),
            _replay(
                hypothesis_id="H-MEGACAP-BREADTH-PROBE",
                replay_class="missing_symbol_breadth_probe",
                symbols=["AMZN", "GOOGL", "ORCL"],
                expected_blocker_delta=1,
                expected_profit_effect="fills_route_evidence_gap",
                expected_cost_class="medium_simulation_probe",
                max_runtime_seconds=900,
                blockers=["execution_tca_symbol_missing"],
            ),
        ],
    }


def _hypothesis_payload() -> dict[str, object]:
    return {
        "items": [
            {
                "hypothesis_id": "H-MICRO-01",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["signal_lag_exceeded"],
                "informational_reasons": [],
                "observed": {"signal_lag_seconds": 120},
                "entry_contract": {"max_signal_lag_seconds": 90},
            }
        ]
    }


def _build(
    *,
    repair_outcome_dividend_ledger: dict[str, object] | None = None,
) -> dict[str, object]:
    return build_profit_carry_passport_ledger(
        account_label="PA3SX7FYNUTF",
        window="15m",
        trading_mode="live",
        torghut_revision="torghut-00361",
        capital_replay_board=_capital_replay_board(),
        route_reacquisition_board={
            "schema_version": "torghut.route-reacquisition-board.v1",
            "summary": {"expected_unblock_value": 14},
        },
        proof_floor={
            "schema_version": "torghut.profitability-proof-floor.v1",
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
        },
        market_context_status={
            "status": "degraded",
            "alert_reason": "market_context_stale",
        },
        hypothesis_payload=_hypothesis_payload(),
        repair_outcome_dividend_ledger=repair_outcome_dividend_ledger,
        now=NOW,
    )


def test_profit_carry_passports_cover_named_repair_hypotheses() -> None:
    ledger = _build()

    assert ledger["schema_version"] == PROFIT_CARRY_PASSPORT_LEDGER_SCHEMA_VERSION
    assert ledger["capital_state"] == "zero_notional"
    assert ledger["max_notional"] == "0"
    assert ledger["live_submit_enabled"] is False
    assert ledger["summary"]["passport_count"] == 4
    assert ledger["summary"]["zero_notional_passport_count"] == 4

    passports = {
        str(passport["hypothesis_id"]): passport
        for passport in ledger["profit_carry_passports"]
    }
    assert set(passports) == {
        "H-AAPL-ROUTE-REHAB",
        "H-NVDA-SIM-PROOF-REFILL",
        "H-MEGACAP-BREADTH-PROBE",
        "H-MICRO-01",
    }
    assert passports["H-AAPL-ROUTE-REHAB"]["expected_blocker_delta"] == 3
    assert passports["H-NVDA-SIM-PROOF-REFILL"]["expected_blocker_delta"] == 2
    assert passports["H-MEGACAP-BREADTH-PROBE"]["decision"] == "hold"
    assert (
        "low_delta_repair_requires_spare_capacity"
        in passports["H-MEGACAP-BREADTH-PROBE"]["reason_codes"]
    )
    assert passports["H-MICRO-01"]["repair_class"] == "alpha_window_evidence_refill"
    assert passports["H-MICRO-01"]["required_receipts"] == [
        "torghut.alpha-readiness-current-receipt.v1",
        "torghut.ta-signal-current-receipt.v1",
        "torghut.hypothesis-window-evidence-current-receipt.v1",
    ]
    assert all(
        "torghut.market-context-current-receipt.v1"
        not in passport["required_receipts"]
        for passport in passports.values()
    )
    assert all(
        passport["schema_version"] == PROFIT_CARRY_PASSPORT_SCHEMA_VERSION
        and passport["max_notional"] == "0"
        and passport["required_receipts"]
        for passport in passports.values()
    )

    futures = ledger["repair_capacity_futures"]
    assert all(
        future["schema_version"] == REPAIR_CAPACITY_FUTURE_SCHEMA_VERSION
        for future in futures
    )
    assert {
        future["capacity_decision"]
        for future in futures
        if future["repair_class"] == "route_coverage_probe"
    } == {"constrained"}


def test_no_delta_receipt_downgrades_matching_alpha_passport() -> None:
    ledger = _build(
        repair_outcome_dividend_ledger={
            "ledger_id": "repair-outcome-dividend-ledger:test",
            "outcome_receipts": [
                {
                    "repair_lot_id": "compacted-repair-lot:promotion_custody",
                    "lot_class": "promotion_custody",
                    "outcome": "no_delta",
                    "preserved_reason_codes": ["signal_lag_exceeded"],
                }
            ],
        }
    )

    micro = next(
        passport
        for passport in ledger["profit_carry_passports"]
        if passport["hypothesis_id"] == "H-MICRO-01"
    )

    assert micro["decision"] == "hold"
    assert micro["no_delta_downgraded"] is True
    assert "recent_no_delta_receipt" in micro["reason_codes"]
    future = next(
        future
        for future in ledger["repair_capacity_futures"]
        if future["future_id"] == micro["jangar_runner_capacity_future_ref"]
    )
    assert future["capacity_decision"] == "constrained"


def test_profit_carry_passports_never_unlock_paper_or_live_actions() -> None:
    ledger = _build()

    assert ledger["action_class_decisions"] == {
        "repair_dispatch": "observe_only",
        "paper_canary": "blocked",
        "live_micro_canary": "blocked",
        "live_scale": "blocked",
    }
    for passport in ledger["profit_carry_passports"]:
        assert passport["capital_effect"] == {
            "capital_state": "zero_notional",
            "max_notional": "0",
            "paper_canary": "blocked",
            "live_micro_canary": "blocked",
            "live_scale": "blocked",
        }
        assert passport["action_class_decisions"]["paper_canary"] == "blocked"
        assert passport["action_class_decisions"]["live_micro_canary"] == "blocked"
