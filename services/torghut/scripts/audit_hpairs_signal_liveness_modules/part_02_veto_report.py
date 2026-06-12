# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false
#!/usr/bin/env python
"""Read-only H-PAIRS signal/route liveness diagnostics.

The audit intentionally consumes only fixture JSON, local status JSON, or an
optional bounded HTTP GET. It never submits orders, writes proof artifacts, or
mutates database/cluster state.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import cast

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_21 import *


def _veto_report(
    target: Mapping[str, object],
    signal: Mapping[str, object],
    risk: Mapping[str, object],
) -> dict[str, object]:
    entry_vetoes = _unique_text_items(target.get("entry_vetoes"))
    entry_vetoes.extend(_unique_text_items(signal.get("entry_vetoes")))
    exit_vetoes = _unique_text_items(target.get("exit_vetoes"))
    exit_vetoes.extend(_unique_text_items(signal.get("exit_vetoes")))
    risk_vetoes = _unique_text_items(
        risk.get("vetoes") or risk.get("risk_vetoes") or risk.get("blockers")
    )
    if (
        _bool_or_none(risk.get("risk_veto") or risk.get("vetoed")) is True
        and not risk_vetoes
    ):
        risk_vetoes.append("risk_veto")
    return {
        "entry_vetoes": sorted(set(entry_vetoes)),
        "exit_vetoes": sorted(set(exit_vetoes)),
        "risk_vetoes": sorted(set(risk_vetoes)),
        "has_risk_veto": bool(risk_vetoes),
    }


def _nested_flag_containers(
    container: Mapping[str, object],
) -> list[Mapping[str, object]]:
    containers = [container]
    for key in (
        "simple_lane",
        "live_submission_gate",
        "submission_gate",
        "submit_gate",
        "gate",
    ):
        nested = _mapping(container.get(key))
        if nested:
            containers.extend(_nested_flag_containers(nested))
    return containers


def _flag_report(
    containers: Sequence[Mapping[str, object]], keys: Sequence[str]
) -> dict[str, object]:
    observed: dict[str, object] = {}
    disabled: list[str] = []
    enabled: list[str] = []
    for root_container in containers:
        for container in _nested_flag_containers(root_container):
            for key in keys:
                if key not in container or key in observed:
                    continue
                value = _bool_or_none(container.get(key))
                if value is None:
                    observed[key] = container.get(key)
                    continue
                observed[key] = value
                if value:
                    enabled.append(key)
                else:
                    disabled.append(key)
    return {
        "observed": observed,
        "enabled_flags": sorted(enabled),
        "disabled_flags": sorted(disabled),
        "eligible": not disabled,
        "observed_any": bool(observed),
    }


def _choose_next_action(blocker_codes: Sequence[str], unsupported: bool) -> str:
    blockers = set(blocker_codes)
    if "target_missing" in blockers:
        return "no_target"
    if blockers.intersection(
        {
            "account_label_mismatch",
            "observed_stage_mismatch",
            "runtime_strategy_mismatch",
        }
    ):
        return "wrong_account"
    if blockers.intersection(
        {
            "latest_features_missing",
            "latest_quotes_missing",
            "latest_features_not_ready",
            "latest_quotes_not_ready",
        }
    ):
        return "no_market_data"
    if "signal_below_threshold" in blockers:
        return "signal_below_threshold"
    if blockers.intersection({"risk_veto", "entry_veto_present", "exit_veto_present"}):
        return "risk_veto"
    if blockers.intersection({"route_disabled", "simple_submit_disabled"}):
        return "route_disabled"
    if "evidence_collection_disabled" in blockers:
        return "evidence_collection_disabled"
    if "drift_checks_missing" in blockers:
        return "materialize_drift_checks"
    if "runtime_materialization_missing" in blockers:
        return "materialize_runtime_buckets"
    if "signal_lag_exceeded" in blockers:
        return "wait_for_fresh_signal_window"
    if "market_session_closed" in blockers:
        return "wait_for_market_session_open"
    if unsupported:
        return "unsupported_inputs"
    return "ready_to_submit_sim_order"


def build_liveness_report(
    source: Mapping[str, object], expectations: AuditExpectations
) -> dict[str, object]:
    target = _target_from_source(source, expectations)
    status = _first_mapping_from_keys(
        source, ("status", "service_status", "runtime_status")
    )
    features = _first_mapping_from_keys(
        source, ("features", "latest_features", "feature_status")
    )
    quotes = _first_mapping_from_keys(
        source, ("quotes", "latest_quotes", "quote_status", "market_data")
    )
    signal = _first_mapping_from_keys(source, ("signal", "signals", "signal_status"))
    route = _first_mapping_from_keys(
        source, ("route", "route_eligibility", "route_status")
    )
    risk = _first_mapping_from_keys(source, ("risk", "risk_status", "risk_veto"))

    identity = _candidate_identity(target, expectations)
    symbols = _symbols_from_target(target)
    if not symbols:
        symbols = _normalize_symbols(
            str(key) for key in _symbol_payload(features).keys()
        )
    if not symbols:
        symbols = _normalize_symbols(str(key) for key in _symbol_payload(quotes).keys())

    feature_report = _availability_report(
        features,
        symbols,
        max_age_seconds=expectations.max_feature_age_seconds,
        quote_mode=False,
    )
    quote_report = _availability_report(
        quotes,
        symbols,
        max_age_seconds=expectations.max_quote_age_seconds,
        quote_mode=True,
    )
    signal_report = _signal_threshold_report(signal)
    signal_drift_readiness = _signal_drift_readiness_report(
        status=status,
        target=target,
        signal=signal,
        expectations=expectations,
    )
    runtime_materialization = _runtime_materialization_report(
        source=source,
        status=status,
        target=target,
    )
    vetoes = _veto_report(target, signal, risk)
    route_flags = _flag_report((target, status, route), _ROUTE_FLAG_KEYS)
    evidence_flags = _flag_report((target, status, route), _EVIDENCE_COLLECTION_KEYS)
    submit_flags = _flag_report((status, route, target), _SIMPLE_SUBMIT_KEYS)

    blocker_codes: list[str] = []
    if not target:
        blocker_codes.append("target_missing")
    observed = _mapping(identity["observed"])
    if observed.get("account_label") not in (None, expectations.account_label):
        blocker_codes.append("account_label_mismatch")
    if observed.get("observed_stage") not in (None, expectations.observed_stage):
        blocker_codes.append("observed_stage_mismatch")
    if observed.get("runtime_strategy") not in (None, expectations.runtime_strategy):
        blocker_codes.append("runtime_strategy_mismatch")
    if not features:
        blocker_codes.append("latest_features_missing")
    elif not bool(feature_report["ready"]):
        blocker_codes.append("latest_features_not_ready")
    if not quotes:
        blocker_codes.append("latest_quotes_missing")
    elif not bool(quote_report["ready"]):
        blocker_codes.append("latest_quotes_not_ready")
    if signal_report["passes"] is False:
        blocker_codes.append("signal_below_threshold")
    if vetoes["entry_vetoes"]:
        blocker_codes.append("entry_veto_present")
    if vetoes["exit_vetoes"]:
        blocker_codes.append("exit_veto_present")
    if vetoes["has_risk_veto"]:
        blocker_codes.append("risk_veto")
    if route_flags["disabled_flags"]:
        blocker_codes.append("route_disabled")
    if submit_flags["disabled_flags"]:
        blocker_codes.append("simple_submit_disabled")
    if evidence_flags["disabled_flags"]:
        blocker_codes.append("evidence_collection_disabled")
    blocker_codes.extend(cast(Sequence[str], signal_drift_readiness["blockers"]))
    if runtime_materialization["zero_fields"]:
        blocker_codes.append("runtime_materialization_missing")

    explicit_blockers = _unique_text_items(source.get("blockers"))
    explicit_blockers.extend(
        _unique_text_items(status.get("blockers") or status.get("blocked_reasons"))
    )
    for nested_status in _nested_flag_containers(status):
        explicit_blockers.extend(
            _unique_text_items(
                nested_status.get("blockers") or nested_status.get("blocked_reasons")
            )
        )
    explicit_blockers.extend(_unique_text_items(target.get("blockers")))
    explicit_blockers.extend(_unique_text_items(route.get("blockers")))
    blocker_codes.extend(explicit_blockers)

    unsupported = False
    unsupported_reasons: list[str] = []
    if signal_report["passes"] is None:
        unsupported = True
        unsupported_reasons.extend(cast(list[str], signal_report["missing_inputs"]))
        blocker_codes.append("unsupported_signal_threshold_inputs")
    if not symbols and target:
        unsupported = True
        unsupported_reasons.append("symbol_universe")
        blocker_codes.append("unsupported_symbol_universe_inputs")

    blocker_codes = sorted(set(blocker_codes))
    next_action = _choose_next_action(blocker_codes, unsupported)
    ready = next_action == "ready_to_submit_sim_order"
    human_verdict = (
        "H-PAIRS liveness READY: target can submit a TORGHUT_SIM paper order."
        if ready
        else f"H-PAIRS liveness BLOCKED: next_action={next_action}; blockers={','.join(blocker_codes)}."
    )

    return {
        "schema_version": HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION,
        "read_only": True,
        "target_candidate_identity": identity,
        "account_stage_runtime_strategy": {
            "account_label": observed.get("account_label"),
            "observed_stage": observed.get("observed_stage"),
            "runtime_strategy": observed.get("runtime_strategy"),
            "expected_account_label": expectations.account_label,
            "expected_observed_stage": expectations.observed_stage,
            "expected_runtime_strategy": expectations.runtime_strategy,
        },
        "symbol_universe": {
            "symbols": symbols,
            "count": len(symbols),
        },
        "latest_feature_availability": feature_report,
        "latest_quote_availability": quote_report,
        "signal_threshold_status": signal_report,
        "signal_drift_readiness": signal_drift_readiness,
        "runtime_materialization_status": runtime_materialization,
        "entry_exit_vetoes": vetoes,
        "route_eligibility_flags": route_flags,
        "simple_submit_flag_state": submit_flags,
        "evidence_collection_flags": evidence_flags,
        "blocker_codes": blocker_codes,
        "unsupported_reasons": sorted(set(unsupported_reasons)),
        "next_action": next_action,
        "ready_to_submit_sim_order": ready,
        "human_verdict": human_verdict,
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture-json", "--input-json", dest="fixture_json")
    parser.add_argument("--target-json")
    parser.add_argument("--status-json")
    parser.add_argument("--features-json")
    parser.add_argument("--quotes-json")
    parser.add_argument("--signal-json")
    parser.add_argument("--route-json")
    parser.add_argument("--risk-json")
    parser.add_argument(
        "--status-url",
        help="optional bounded read-only HTTP GET that returns status JSON",
    )
    parser.add_argument("--http-timeout-seconds", type=float, default=2.0)
    parser.add_argument("--hypothesis-id", default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument("--candidate-id", default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument("--account-label", default=DEFAULT_HPAIRS_ACCOUNT_LABEL)
    parser.add_argument("--observed-stage", default=DEFAULT_OBSERVED_STAGE)
    parser.add_argument(
        "--runtime-strategy-name", default=DEFAULT_HPAIRS_RUNTIME_STRATEGY
    )
    parser.add_argument("--max-quote-age-seconds", type=float, default=90.0)
    parser.add_argument("--max-feature-age-seconds", type=float, default=180.0)
    parser.add_argument("--max-signal-lag-seconds", type=float, default=90.0)
    parser.add_argument(
        "--fail-on-blockers",
        action="store_true",
        help="exit non-zero when the diagnostic next_action is not ready_to_submit_sim_order",
    )
    return parser.parse_args(list(argv))


def _load_cli_source(args: argparse.Namespace) -> Mapping[str, object]:
    source: Mapping[str, object] = (
        _read_json_path(args.fixture_json) if args.fixture_json else {}
    )
    overrides: dict[str, Mapping[str, object]] = {}
    for key, attr in (
        ("target", "target_json"),
        ("status", "status_json"),
        ("features", "features_json"),
        ("quotes", "quotes_json"),
        ("signal", "signal_json"),
        ("route", "route_json"),
        ("risk", "risk_json"),
    ):
        value = getattr(args, attr)
        if value:
            overrides[key] = _read_json_path(value)
    if args.status_url:
        overrides["status"] = _read_status_url(
            args.status_url, args.http_timeout_seconds
        )
    return _merge_inputs(source, overrides)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    expectations = AuditExpectations(
        hypothesis_id=args.hypothesis_id,
        candidate_id=args.candidate_id,
        account_label=args.account_label,
        observed_stage=args.observed_stage,
        runtime_strategy=args.runtime_strategy_name,
        max_quote_age_seconds=args.max_quote_age_seconds,
        max_feature_age_seconds=args.max_feature_age_seconds,
        max_signal_lag_seconds=args.max_signal_lag_seconds,
    )
    try:
        source = _load_cli_source(args)
        report = build_liveness_report(source, expectations)
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
        report = {
            "schema_version": HPAIRS_SIGNAL_LIVENESS_SCHEMA_VERSION,
            "read_only": True,
            "next_action": "unsupported_inputs",
            "ready_to_submit_sim_order": False,
            "blocker_codes": ["unsupported_input_read_error"],
            "human_verdict": f"H-PAIRS liveness BLOCKED: next_action=unsupported_inputs; error={exc}.",
            "error": str(exc),
        }
    sys.stdout.write(stable_json(report))
    sys.stderr.write(str(report["human_verdict"]) + "\n")
    if (
        args.fail_on_blockers
        and report.get("next_action") != "ready_to_submit_sim_order"
    ):
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [name for name in globals() if not name.startswith("__")]
