"""Profit-carry passport reducer for zero-notional repair prioritization."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import json
from typing import Any, cast


PROFIT_CARRY_PASSPORT_LEDGER_SCHEMA_VERSION = "torghut.profit-carry-passport-ledger.v1"
PROFIT_CARRY_PASSPORT_SCHEMA_VERSION = "torghut.profit-carry-passport.v1"
REPAIR_CAPACITY_FUTURE_SCHEMA_VERSION = "torghut.repair-capacity-future.v1"

_FRESHNESS_SECONDS = 60
_ZERO_NOTIONAL = "0"
_VALUE_GATES = [
    "routeable_candidate_count",
    "fill_tca_or_slippage_quality",
    "zero_notional_or_stale_evidence_rate",
    "post_cost_daily_net_pnl",
    "capital_gate_safety",
]
_DOC_REFS = [
    "docs/torghut/design-system/v6/196-torghut-profit-carry-passports-and-repair-capacity-futures-2026-05-13.md",
    "docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md",
    "swarm-validation-contract:every-run-cites-governing-requirement",
]
_ACTION_CLASS_DECISIONS = {
    "repair_dispatch": "observe_only",
    "paper_canary": "blocked",
    "live_micro_canary": "blocked",
    "live_scale": "blocked",
}
_RECEIPTS_BY_REPAIR_CLASS = {
    "route_rehab": [
        "torghut.execution-tca-current-receipt.v1",
        "torghut.alpha-readiness-current-receipt.v1",
    ],
    "scoped_proof_refill": [
        "torghut.execution-tca-current-receipt.v1",
        "torghut.route-universe-current-receipt.v1",
    ],
    "missing_symbol_breadth_probe": [
        "torghut.route-coverage-current-receipt.v1",
    ],
    "alpha_window_evidence_refill": [
        "torghut.alpha-readiness-current-receipt.v1",
        "torghut.ta-signal-current-receipt.v1",
        "torghut.hypothesis-window-evidence-current-receipt.v1",
    ],
}
_CAPACITY_REPAIR_CLASSES = {
    "route_rehab": "route_repair",
    "scoped_proof_refill": "simulation_proof_refill",
    "missing_symbol_breadth_probe": "route_coverage_probe",
    "alpha_window_evidence_refill": "alpha_readiness_refill",
}
_REPAIR_CLASS_LOT_ALIASES = {
    "route_rehab": {"execution_tca", "route_rehab", "route_universe"},
    "scoped_proof_refill": {"execution_tca", "empirical_replay", "feature_lineage"},
    "missing_symbol_breadth_probe": {
        "execution_tca",
        "feature_lineage",
        "route_coverage",
    },
    "alpha_window_evidence_refill": {"promotion_custody", "alpha_readiness"},
}
_FALLBACK_FALSIFICATION_RULES = [
    "after_refs_missing_or_stale",
    "declared_blocker_not_retired",
    "capital_notional_requested",
]


def _mapping(value: object) -> Mapping[str, Any]:
    return cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}


def _sequence(value: object) -> Sequence[object]:
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return cast(Sequence[object], value)
    return ()


def _text(value: object, default: str = "") -> str:
    if value is None:
        return default
    text = str(value).strip()
    return text or default


def _int(value: object, default: int = 0) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip():
        try:
            return int(float(value.strip()))
        except ValueError:
            return default
    return default


def _unique(values: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            result.append(normalized)
            seen.add(normalized)
    return result


def _strings(value: object) -> list[str]:
    return _unique([_text(item) for item in _sequence(value)])


def _stable_ref(prefix: str, payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return f"{prefix}:{sha256(encoded.encode()).hexdigest()[:20]}"


def _fresh(value: datetime) -> str:
    return (value + timedelta(seconds=_FRESHNESS_SECONDS)).isoformat()


def _source_ref(payload: Mapping[str, Any], *keys: str) -> object | None:
    for key in keys:
        value = payload.get(key)
        if _text(value):
            return value
    return None


def _expected_profit_unlock(replay: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(replay.get("expected_profit_unlock"))


def _expected_cost(replay: Mapping[str, Any]) -> Mapping[str, Any]:
    return _mapping(replay.get("expected_cost"))


def _required_receipts(repair_class: str) -> list[str]:
    return list(_RECEIPTS_BY_REPAIR_CLASS.get(repair_class, ()))


def _target_value_gate(repair_class: str) -> str:
    if repair_class in {"route_rehab", "scoped_proof_refill"}:
        return "fill_tca_or_slippage_quality"
    if repair_class == "missing_symbol_breadth_probe":
        return "routeable_candidate_count"
    if repair_class == "alpha_window_evidence_refill":
        return "routeable_candidate_count"
    return "zero_notional_or_stale_evidence_rate"


def _action_class_guardrails() -> list[dict[str, object]]:
    return [
        {
            "code": "zero_notional_required",
            "status": "pass",
            "limit": _ZERO_NOTIONAL,
        },
        {
            "code": "paper_live_blocked",
            "status": "pass",
            "action_class_decisions": dict(_ACTION_CLASS_DECISIONS),
        },
    ]


def _normalize_guardrails(raw_guardrails: object) -> list[dict[str, object]]:
    guardrails: list[dict[str, object]] = []
    for raw_guardrail in _sequence(raw_guardrails):
        guardrail = _mapping(raw_guardrail)
        if guardrail:
            guardrails.append(dict(guardrail))
    return guardrails


def _passport_decision(
    *,
    repair_class: str,
    expected_blocker_delta: int,
    no_delta_downgraded: bool,
) -> tuple[str, list[str]]:
    if no_delta_downgraded:
        return "hold", ["recent_no_delta_receipt"]
    if expected_blocker_delta <= 0:
        return "block", ["non_positive_expected_blocker_delta"]
    if repair_class == "missing_symbol_breadth_probe" and expected_blocker_delta < 2:
        return "hold", ["low_delta_repair_requires_spare_capacity"]
    return "repair_only", []


def _capacity_decision(passport_decision: str) -> str:
    if passport_decision == "repair_only":
        return "available"
    if passport_decision == "hold":
        return "constrained"
    return "unavailable"


def _no_delta_receipts(
    repair_outcome_dividend_ledger: Mapping[str, Any] | None,
) -> list[Mapping[str, Any]]:
    ledger = _mapping(repair_outcome_dividend_ledger)
    receipts: list[Mapping[str, Any]] = []
    for raw_receipt in _sequence(ledger.get("outcome_receipts")):
        receipt = _mapping(raw_receipt)
        if _text(receipt.get("outcome")) == "no_delta":
            receipts.append(receipt)
    return receipts


def _no_delta_matches(
    *,
    repair_class: str,
    current_blockers: Sequence[str],
    no_delta_receipts: Sequence[Mapping[str, Any]],
) -> bool:
    aliases = _REPAIR_CLASS_LOT_ALIASES.get(repair_class, {repair_class})
    blocker_set = set(current_blockers)
    for receipt in no_delta_receipts:
        lot_class = _text(receipt.get("lot_class"))
        preserved = set(_strings(receipt.get("preserved_reason_codes")))
        if lot_class in aliases:
            return True
        if blocker_set and preserved and blocker_set.intersection(preserved):
            return True
    return False


def _future_for_passport(
    *,
    passport_id: str,
    generated_at: datetime,
    account_label: str,
    window: str,
    repair_class: str,
    expected_runtime_seconds: int,
    expected_cost_class: str,
    expected_blocker_delta: int,
    decision: str,
    reason_codes: Sequence[str],
) -> dict[str, object]:
    capacity_decision = _capacity_decision(decision)
    future_id = _stable_ref(
        "repair-capacity-future",
        {
            "passport_id": passport_id,
            "repair_class": repair_class,
            "expected_runtime_seconds": expected_runtime_seconds,
            "capacity_decision": capacity_decision,
        },
    )
    future_reasons = list(reason_codes)
    if capacity_decision == "constrained" and not future_reasons:
        future_reasons = ["repair_capacity_constrained"]
    if capacity_decision == "unavailable" and not future_reasons:
        future_reasons = ["repair_capacity_unavailable"]
    return {
        "schema_version": REPAIR_CAPACITY_FUTURE_SCHEMA_VERSION,
        "future_id": future_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": _fresh(generated_at),
        "account": account_label,
        "window": window,
        "repair_class": _CAPACITY_REPAIR_CLASSES.get(repair_class, repair_class),
        "expected_runtime_seconds": expected_runtime_seconds,
        "expected_cost_class": expected_cost_class,
        "expected_blocker_delta": expected_blocker_delta,
        "jangar_stage_launch_ticket_ref": None,
        "capacity_decision": capacity_decision,
        "reason_codes": _unique(list(reason_codes) + future_reasons),
    }


def _passport_from_replay(
    *,
    replay: Mapping[str, Any],
    generated_at: datetime,
    account_label: str,
    window: str,
    torghut_revision: str | None,
    repair_outcome_no_delta_receipts: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, object], dict[str, object]]:
    repair_class = _text(replay.get("replay_class"), "unknown")
    target_symbols = _strings(replay.get("target_symbols"))
    profit_unlock = _expected_profit_unlock(replay)
    cost = _expected_cost(replay)
    expected_blocker_delta = _int(profit_unlock.get("expected_blocker_delta"), 1)
    current_blockers = _strings(replay.get("remaining_blockers"))
    before_refs = _mapping(replay.get("before_refs"))
    jangar_graduation = _mapping(before_refs.get("jangar_contract_graduation"))
    no_delta_downgraded = _no_delta_matches(
        repair_class=repair_class,
        current_blockers=current_blockers,
        no_delta_receipts=repair_outcome_no_delta_receipts,
    )
    decision, decision_reasons = _passport_decision(
        repair_class=repair_class,
        expected_blocker_delta=expected_blocker_delta,
        no_delta_downgraded=no_delta_downgraded,
    )
    expected_cost_class = _text(cost.get("class"), "unknown")
    max_runtime_seconds = _int(
        replay.get("max_runtime_seconds"),
        _int(cost.get("max_runtime_seconds"), 600),
    )
    passport_id = _stable_ref(
        "profit-carry-passport",
        {
            "account_label": account_label,
            "window": window,
            "hypothesis_id": replay.get("hypothesis_id"),
            "repair_class": repair_class,
            "target_symbols": target_symbols,
            "expected_blocker_delta": expected_blocker_delta,
            "source_replay_id": replay.get("replay_id"),
        },
    )
    future = _future_for_passport(
        passport_id=passport_id,
        generated_at=generated_at,
        account_label=account_label,
        window=window,
        repair_class=repair_class,
        expected_runtime_seconds=max_runtime_seconds,
        expected_cost_class=expected_cost_class,
        expected_blocker_delta=expected_blocker_delta,
        decision=decision,
        reason_codes=decision_reasons,
    )
    passport = {
        "schema_version": PROFIT_CARRY_PASSPORT_SCHEMA_VERSION,
        "passport_id": passport_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": _fresh(generated_at),
        "account": account_label,
        "window": window,
        "hypothesis_id": replay.get("hypothesis_id"),
        "candidate_id": None,
        "target_symbols": target_symbols,
        "repair_class": repair_class,
        "target_value_gate": _target_value_gate(repair_class),
        "expected_blocker_delta": expected_blocker_delta,
        "expected_profit_effect": _text(
            profit_unlock.get("expected_profit_effect"),
            "repair_profit_evidence",
        ),
        "expected_cost_class": expected_cost_class,
        "max_runtime_seconds": max_runtime_seconds,
        "max_notional": _ZERO_NOTIONAL,
        "required_receipts": _required_receipts(repair_class),
        "current_blockers": current_blockers,
        "guardrails": [
            *_normalize_guardrails(replay.get("guardrails")),
            *_action_class_guardrails(),
        ],
        "falsification_rules": _strings(replay.get("falsification_rules"))
        or list(_FALLBACK_FALSIFICATION_RULES),
        "jangar_rollout_proof_passport_ref": _source_ref(
            jangar_graduation,
            "contract_ref",
            "epoch_id",
        ),
        "jangar_runner_capacity_future_ref": future["future_id"],
        "decision": decision,
        "reason_codes": _unique([*decision_reasons, *current_blockers]),
        "source_refs": {
            "capital_replay_ref": replay.get("replay_id"),
            "torghut_revision": torghut_revision,
        },
        "action_class_decisions": dict(_ACTION_CLASS_DECISIONS),
        "capital_effect": {
            "capital_state": "zero_notional",
            "max_notional": _ZERO_NOTIONAL,
            "paper_canary": "blocked",
            "live_micro_canary": "blocked",
            "live_scale": "blocked",
        },
        "no_delta_downgraded": no_delta_downgraded,
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "ignore_profit_carry_passport": True,
        },
    }
    return passport, future


def _hypothesis_items(hypothesis_payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [_mapping(item) for item in _sequence(hypothesis_payload.get("items"))]


def _alpha_passport(
    *,
    hypothesis_payload: Mapping[str, Any],
    generated_at: datetime,
    account_label: str,
    window: str,
    torghut_revision: str | None,
    market_context_status: Mapping[str, Any],
    repair_outcome_no_delta_receipts: Sequence[Mapping[str, Any]],
) -> tuple[dict[str, object], dict[str, object]] | None:
    micro = next(
        (
            item
            for item in _hypothesis_items(hypothesis_payload)
            if _text(item.get("hypothesis_id")) == "H-MICRO-01"
        ),
        None,
    )
    if micro is None:
        return None

    observed = _mapping(micro.get("observed"))
    current_blockers = _unique(
        [
            *_strings(micro.get("reasons")),
            *_strings(micro.get("informational_reasons")),
        ]
    )
    if not current_blockers and not bool(micro.get("promotion_eligible")):
        current_blockers = ["alpha_readiness_not_promotion_eligible"]
    repair_class = "alpha_window_evidence_refill"
    no_delta_downgraded = _no_delta_matches(
        repair_class=repair_class,
        current_blockers=current_blockers,
        no_delta_receipts=repair_outcome_no_delta_receipts,
    )
    expected_blocker_delta = 2
    decision, decision_reasons = _passport_decision(
        repair_class=repair_class,
        expected_blocker_delta=expected_blocker_delta,
        no_delta_downgraded=no_delta_downgraded,
    )
    max_runtime_seconds = 900
    expected_cost_class = "medium_evidence_refill"
    hypothesis_id = _text(micro.get("hypothesis_id"), "H-MICRO-01")
    passport_id = _stable_ref(
        "profit-carry-passport",
        {
            "account_label": account_label,
            "window": window,
            "hypothesis_id": hypothesis_id,
            "repair_class": repair_class,
            "candidate_id": micro.get("candidate_id"),
            "current_blockers": current_blockers,
        },
    )
    future = _future_for_passport(
        passport_id=passport_id,
        generated_at=generated_at,
        account_label=account_label,
        window=window,
        repair_class=repair_class,
        expected_runtime_seconds=max_runtime_seconds,
        expected_cost_class=expected_cost_class,
        expected_blocker_delta=expected_blocker_delta,
        decision=decision,
        reason_codes=decision_reasons,
    )
    market_state = _text(
        market_context_status.get("state")
        or market_context_status.get("overallState")
        or market_context_status.get("overall_state")
        or market_context_status.get("status"),
        "unknown",
    )
    passport = {
        "schema_version": PROFIT_CARRY_PASSPORT_SCHEMA_VERSION,
        "passport_id": passport_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": _fresh(generated_at),
        "account": account_label,
        "window": window,
        "hypothesis_id": hypothesis_id,
        "candidate_id": micro.get("candidate_id"),
        "target_symbols": _strings(micro.get("target_symbols")),
        "repair_class": repair_class,
        "target_value_gate": _target_value_gate(repair_class),
        "expected_blocker_delta": expected_blocker_delta,
        "expected_profit_effect": (
            "can_move_lineage_ready_hypothesis_to_paper_candidate_after_freshness_repair"
        ),
        "expected_cost_class": expected_cost_class,
        "max_runtime_seconds": max_runtime_seconds,
        "max_notional": _ZERO_NOTIONAL,
        "required_receipts": _required_receipts(repair_class),
        "current_blockers": current_blockers,
        "guardrails": [
            {
                "code": "signal_lag_under_threshold",
                "status": "blocked"
                if "signal_lag_exceeded" in current_blockers
                else "pending",
                "observed_seconds": observed.get("signal_lag_seconds"),
                "limit_seconds": _mapping(micro.get("entry_contract")).get(
                    "max_signal_lag_seconds"
                ),
            },
            {
                "code": "market_context_not_worse",
                "status": "pass"
                if market_state in {"ok", "healthy", "fresh", "current"}
                else "pending",
                "state": market_state,
            },
            *_action_class_guardrails(),
        ],
        "falsification_rules": [
            "window_evidence_remains_stale_after_repair",
            "signal_lag_exceeded_after_repair",
            "promotion_eligible_total_unchanged",
            "paper_or_live_notional_requested",
        ],
        "jangar_rollout_proof_passport_ref": None,
        "jangar_runner_capacity_future_ref": future["future_id"],
        "decision": decision,
        "reason_codes": _unique([*decision_reasons, *current_blockers]),
        "source_refs": {
            "hypothesis_id": hypothesis_id,
            "strategy_id": micro.get("strategy_id"),
            "dataset_snapshot_ref": micro.get("dataset_snapshot_ref"),
            "torghut_revision": torghut_revision,
        },
        "action_class_decisions": dict(_ACTION_CLASS_DECISIONS),
        "capital_effect": {
            "capital_state": "zero_notional",
            "max_notional": _ZERO_NOTIONAL,
            "paper_canary": "blocked",
            "live_micro_canary": "blocked",
            "live_scale": "blocked",
        },
        "no_delta_downgraded": no_delta_downgraded,
        "rollback_target": {
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "ignore_profit_carry_passport": True,
        },
    }
    return passport, future


def build_profit_carry_passport_ledger(
    *,
    account_label: str,
    window: str,
    trading_mode: str,
    torghut_revision: str | None,
    capital_replay_board: Mapping[str, Any],
    route_reacquisition_board: Mapping[str, Any],
    proof_floor: Mapping[str, Any],
    market_context_status: Mapping[str, Any],
    hypothesis_payload: Mapping[str, Any],
    repair_outcome_dividend_ledger: Mapping[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, object]:
    """Build observe-mode profit-carry passports without changing capital authority."""

    generated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    no_delta_receipts = _no_delta_receipts(repair_outcome_dividend_ledger)
    passports: list[dict[str, object]] = []
    futures: list[dict[str, object]] = []

    for raw_replay in _sequence(capital_replay_board.get("replay_items")):
        replay = _mapping(raw_replay)
        if not replay:
            continue
        passport, future = _passport_from_replay(
            replay=replay,
            generated_at=generated_at,
            account_label=account_label,
            window=window,
            torghut_revision=torghut_revision,
            repair_outcome_no_delta_receipts=no_delta_receipts,
        )
        passports.append(passport)
        futures.append(future)

    alpha_result = _alpha_passport(
        hypothesis_payload=hypothesis_payload,
        generated_at=generated_at,
        account_label=account_label,
        window=window,
        torghut_revision=torghut_revision,
        market_context_status=market_context_status,
        repair_outcome_no_delta_receipts=no_delta_receipts,
    )
    if alpha_result is not None:
        passport, future = alpha_result
        passports.append(passport)
        futures.append(future)

    ledger_id = _stable_ref(
        "profit-carry-passport-ledger",
        {
            "account_label": account_label,
            "window": window,
            "capital_replay_board": capital_replay_board.get("board_id"),
            "route_reacquisition_board": route_reacquisition_board.get(
                "schema_version"
            ),
            "passport_ids": [
                _text(passport.get("passport_id")) for passport in passports
            ],
        },
    )
    return {
        "schema_version": PROFIT_CARRY_PASSPORT_LEDGER_SCHEMA_VERSION,
        "ledger_id": ledger_id,
        "generated_at": generated_at.isoformat(),
        "fresh_until": _fresh(generated_at),
        "account": account_label,
        "window": window,
        "trading_mode": trading_mode,
        "torghut_revision": torghut_revision,
        "governing_design_refs": list(_DOC_REFS),
        "source_refs": {
            "capital_replay_board_ref": capital_replay_board.get("board_id"),
            "route_reacquisition_board_schema": route_reacquisition_board.get(
                "schema_version"
            ),
            "proof_floor_ref": proof_floor.get("receipt_id")
            or proof_floor.get("schema_version"),
            "revenue_repair_digest_ref": "/trading/revenue-repair",
            "repair_outcome_dividend_ledger_ref": _mapping(
                repair_outcome_dividend_ledger
            ).get("ledger_id"),
        },
        "capital_state": "zero_notional",
        "max_notional": _ZERO_NOTIONAL,
        "live_submit_enabled": False,
        "action_class_decisions": dict(_ACTION_CLASS_DECISIONS),
        "profit_carry_passports": passports,
        "repair_capacity_futures": futures,
        "summary": {
            "passport_count": len(passports),
            "repair_only_passport_count": sum(
                1 for passport in passports if passport.get("decision") == "repair_only"
            ),
            "held_passport_count": sum(
                1 for passport in passports if passport.get("decision") == "hold"
            ),
            "blocked_passport_count": sum(
                1 for passport in passports if passport.get("decision") == "block"
            ),
            "zero_notional_passport_count": sum(
                1
                for passport in passports
                if _text(passport.get("max_notional")) == "0"
            ),
            "capacity_available_count": sum(
                1
                for future in futures
                if future.get("capacity_decision") == "available"
            ),
            "capacity_constrained_count": sum(
                1
                for future in futures
                if future.get("capacity_decision") == "constrained"
            ),
            "no_delta_downgraded_count": sum(
                1 for passport in passports if bool(passport.get("no_delta_downgraded"))
            ),
            "top_passport_ids": [
                _text(passport.get("passport_id")) for passport in passports[:3]
            ],
            "value_gates": list(_VALUE_GATES),
            "paper_live_locked": True,
            "max_notional": _ZERO_NOTIONAL,
        },
        "rollback_target": {
            "profit_carry_passport_consumption_enabled": False,
            "capital_state": "zero_notional",
            "live_submit_enabled": False,
            "fallback_payload": "torghut.consumer-evidence-status.v1",
            "preserve_profit_carry_passports": True,
        },
    }


__all__ = [
    "PROFIT_CARRY_PASSPORT_LEDGER_SCHEMA_VERSION",
    "PROFIT_CARRY_PASSPORT_SCHEMA_VERSION",
    "REPAIR_CAPACITY_FUTURE_SCHEMA_VERSION",
    "build_profit_carry_passport_ledger",
]
