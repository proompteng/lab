#!/usr/bin/env python
"""Read-only H-PAIRS profit proof-gap readback CLI.

The command reads operator-provided endpoint URLs or fixture paths and emits one
machine-readable JSON payload that names the first remaining proof blocker.  It
never writes database rows, calls promotion endpoints, mutates Kubernetes, or
changes runtime configuration.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Literal, cast

SCHEMA_VERSION = "torghut.hpairs-profit-proof-readback.v1"
DEFAULT_HPAIRS_HYPOTHESIS_ID = "H-PAIRS-01"
DEFAULT_HPAIRS_CANDIDATE_ID = "c88421d619759b2cfaa6f4d0"
DEFAULT_HPAIRS_RUNTIME_STRATEGY = "microbar-cross-sectional-pairs-v1"
DEFAULT_ACCOUNT_LABEL = "TORGHUT_SIM"
DEFAULT_MIN_TRADING_DAYS = 20
DEFAULT_MIN_DAILY_NET_PNL = Decimal("500")
DEFAULT_MIN_FILLED_NOTIONAL = Decimal("0")
DEFAULT_MIN_CLOSED_TRADES = 1

EndpointName = Literal[
    "readyz",
    "trading_status",
    "paper_route_target_plan",
    "paper_route_evidence",
    "proof_packet",
    "source_proof_census",
    "runtime_ledger_daily_summary",
]
BlockerStage = Literal[
    "rollout_drift",
    "target_plan_missing",
    "paper_route_inactive",
    "source_refs_missing",
    "lifecycle_economics_blocked",
    "proof_mode_not_authority",
    "insufficient_days",
    "insufficient_daily_pnl",
    "negative_pnl",
    "concentration_or_drawdown_blocked",
    "no_authority_blocker_detected",
]

READ_ONLY_ENDPOINTS: Mapping[EndpointName, str | None] = {
    "readyz": "/readyz",
    "trading_status": "/trading/status",
    "paper_route_target_plan": "/trading/paper-route-target-plan",
    "paper_route_evidence": "/trading/paper-route-evidence",
    "proof_packet": None,
    "source_proof_census": None,
    "runtime_ledger_daily_summary": None,
}
REQUIRED_ENDPOINTS: tuple[EndpointName, ...] = (
    "readyz",
    "trading_status",
    "paper_route_target_plan",
    "paper_route_evidence",
)
MUTATION_WORDS = (
    "apply",
    "config",
    "create",
    "delete",
    "deploy",
    "enable",
    "merge",
    "mutate",
    "patch",
    "promote",
    "promotion",
    "submit",
    "trade",
    "update",
    "write",
)
TARGET_COLLECTION_KEYS = (
    "targets",
    "paper_targets",
    "candidate_targets",
    "route_targets",
    "target_plan",
    "selected_targets",
)
DAILY_COLLECTION_KEYS = (
    "trading_days",
    "daily_pnl",
    "daily_net_pnl",
    "daily_summary",
    "daily_summaries",
    "days",
)
NET_PNL_KEYS = (
    "net_pnl_after_costs",
    "daily_net_pnl_after_costs",
    "net_strategy_pnl_after_costs",
    "net_post_cost_pnl",
    "post_cost_pnl",
    "net_pnl",
)
FILLED_NOTIONAL_KEYS = (
    "filled_notional",
    "total_filled_notional",
    "filled_notional_after_costs",
)
CLOSED_TRADES_KEYS = (
    "closed_trades",
    "closed_trade_count",
    "closed_round_trips",
    "closed_round_trip_count",
)
OPEN_POSITIONS_KEYS = ("open_positions", "open_position_count")
SOURCE_REF_KEYS = (
    "source_refs",
    "source_ref_count",
    "source_references",
    "trade_decision_ids",
    "execution_ids",
    "execution_order_event_ids",
)
SOURCE_WINDOW_KEYS = (
    "source_window_ids",
    "source_windows",
    "source_window_count",
    "order_feed_source_windows",
)
LIFECYCLE_KEYS = (
    "order_feed_lifecycle_complete",
    "lifecycle_complete",
    "runtime_ledger_lifecycle_complete",
)
ECONOMICS_KEYS = (
    "execution_economics_complete",
    "economics_complete",
    "explicit_costs_complete",
    "costs_complete",
)
CONCENTRATION_DRAWDOWN_WORDS = (
    "concentration",
    "drawdown",
    "best_day_share",
    "symbol_concentration",
)
SOURCE_MISSING_WORDS = (
    "source_refs_missing",
    "source_window_missing",
    "source_window_ids_missing",
    "source_offsets_missing",
    "source_materialization_missing",
    "aggregate_only",
)
LIFECYCLE_ECONOMICS_WORDS = (
    "lifecycle",
    "execution_economics",
    "explicit_cost",
    "cost_basis",
    "order_feed",
)


@dataclass(frozen=True)
class LoadedSource:
    name: EndpointName
    location: str | None
    payload: Mapping[str, Any]
    present: bool
    required: bool
    read_error: str | None = None

    def to_payload(self) -> dict[str, Any]:
        return {
            "location": self.location,
            "present": self.present,
            "required": self.required,
            "read_error": self.read_error,
            "schema_version": _text(self.payload.get("schema_version")),
        }


@dataclass(frozen=True)
class Identity:
    hypothesis_id: str
    candidate_id: str
    runtime_strategy_name: str
    account_label: str


@dataclass(frozen=True)
class NumericReadback:
    trading_days: int | None
    daily_net_pnl_after_costs: tuple[Decimal, ...]
    mean_daily_net_pnl_after_costs: Decimal | None
    median_daily_net_pnl_after_costs: Decimal | None
    worst_daily_net_pnl_after_costs: Decimal | None
    filled_notional: Decimal | None
    closed_trades: int | None
    open_positions: int | None
    max_drawdown_pct_equity: Decimal | None
    best_day_share: Decimal | None
    symbol_concentration_share: Decimal | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "trading_days": self.trading_days,
            "daily_net_pnl_after_costs": [
                _decimal_text(value) for value in self.daily_net_pnl_after_costs
            ],
            "mean_daily_net_pnl_after_costs": _decimal_text(
                self.mean_daily_net_pnl_after_costs
            ),
            "median_daily_net_pnl_after_costs": _decimal_text(
                self.median_daily_net_pnl_after_costs
            ),
            "worst_daily_net_pnl_after_costs": _decimal_text(
                self.worst_daily_net_pnl_after_costs
            ),
            "filled_notional": _decimal_text(self.filled_notional),
            "closed_trades": self.closed_trades,
            "open_positions": self.open_positions,
            "max_drawdown_pct_equity": _decimal_text(self.max_drawdown_pct_equity),
            "best_day_share": _decimal_text(self.best_day_share),
            "symbol_concentration_share": _decimal_text(
                self.symbol_concentration_share
            ),
        }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--service-base-url",
        help="Base URL used to read /readyz, /trading/status, /trading/paper-route-target-plan, and /trading/paper-route-evidence.",
    )
    parser.add_argument("--readyz", help="URL or JSON file path for /readyz.")
    parser.add_argument(
        "--trading-status", help="URL or JSON file path for /trading/status."
    )
    parser.add_argument(
        "--paper-route-target-plan",
        help="URL or JSON file path for /trading/paper-route-target-plan.",
    )
    parser.add_argument(
        "--paper-route-evidence",
        help="URL or JSON file path for /trading/paper-route-evidence.",
    )
    parser.add_argument(
        "--proof-packet-json",
        help="Optional runtime-ledger proof-packet JSON URL or path.",
    )
    parser.add_argument(
        "--source-proof-census-json",
        help="Optional source-proof census JSON URL or path.",
    )
    parser.add_argument(
        "--runtime-ledger-daily-summary-json",
        help="Optional runtime-ledger daily summary JSON URL or path.",
    )
    parser.add_argument("--http-timeout-seconds", type=float, default=10.0)
    parser.add_argument("--hypothesis-id", default=DEFAULT_HPAIRS_HYPOTHESIS_ID)
    parser.add_argument("--candidate-id", default=DEFAULT_HPAIRS_CANDIDATE_ID)
    parser.add_argument(
        "--runtime-strategy-name", default=DEFAULT_HPAIRS_RUNTIME_STRATEGY
    )
    parser.add_argument("--account-label", default=DEFAULT_ACCOUNT_LABEL)
    parser.add_argument(
        "--min-trading-days", type=int, default=DEFAULT_MIN_TRADING_DAYS
    )
    parser.add_argument(
        "--min-daily-net-pnl-after-costs", default=str(DEFAULT_MIN_DAILY_NET_PNL)
    )
    parser.add_argument(
        "--min-filled-notional", default=str(DEFAULT_MIN_FILLED_NOTIONAL)
    )
    parser.add_argument(
        "--min-closed-trades", type=int, default=DEFAULT_MIN_CLOSED_TRADES
    )
    parser.add_argument(
        "--fail-on-blocker",
        action="store_true",
        help="Exit non-zero when blocker_stage is not no_authority_blocker_detected.",
    )
    return parser.parse_args(list(argv))


def build_readback_report(
    sources: Mapping[EndpointName, LoadedSource],
    *,
    identity: Identity,
    min_trading_days: int = DEFAULT_MIN_TRADING_DAYS,
    min_daily_net_pnl_after_costs: Decimal = DEFAULT_MIN_DAILY_NET_PNL,
    min_filled_notional: Decimal = DEFAULT_MIN_FILLED_NOTIONAL,
    min_closed_trades: int = DEFAULT_MIN_CLOSED_TRADES,
) -> dict[str, Any]:
    readyz = sources["readyz"].payload
    status = sources["trading_status"].payload
    target_plan = sources["paper_route_target_plan"].payload
    paper_route_evidence = sources["paper_route_evidence"].payload
    proof_packet = sources.get("proof_packet", _absent("proof_packet")).payload
    source_census = sources.get(
        "source_proof_census", _absent("source_proof_census")
    ).payload
    runtime_summary = sources.get(
        "runtime_ledger_daily_summary", _absent("runtime_ledger_daily_summary")
    ).payload

    blockers: list[str] = []
    blockers.extend(_source_read_blockers(sources))
    rollout = _rollout_status(readyz, status, proof_packet)
    if rollout["drift_detected"] is True:
        blockers.append("rollout_revision_drift")
    target = _target_status(
        target_plan, paper_route_evidence, status, identity=identity
    )
    if target["present"] is not True:
        blockers.append("hpairs_target_plan_missing")
    route = _paper_route_status(target, paper_route_evidence, status)
    if route["active"] is not True:
        blockers.append("hpairs_paper_route_inactive_or_ambiguous")
    source_status = _source_ref_status(proof_packet, source_census, runtime_summary)
    if (
        source_status["source_refs_present"] is not True
        or source_status["source_windows_present"] is not True
    ):
        blockers.append("hpairs_source_refs_or_windows_missing")
    lifecycle_economics = _lifecycle_economics_status(
        proof_packet, source_census, runtime_summary
    )
    if (
        lifecycle_economics["lifecycle_complete"] is not True
        or lifecycle_economics["economics_complete"] is not True
    ):
        blockers.append("runtime_lifecycle_or_execution_economics_blocked")
    proof_authority = _proof_authority_status(proof_packet)
    if (
        proof_authority["authority_mode"] is not True
        or proof_authority["final_authority"] is not True
    ):
        blockers.append("runtime_ledger_proof_mode_not_authority")
    numeric = _numeric_readback(proof_packet, source_census, runtime_summary)
    blockers.extend(
        _numeric_blockers(
            numeric,
            min_trading_days=min_trading_days,
            min_daily_net_pnl_after_costs=min_daily_net_pnl_after_costs,
            min_filled_notional=min_filled_notional,
            min_closed_trades=min_closed_trades,
        )
    )
    blockers.extend(
        _reported_blockers(
            proof_packet, source_census, runtime_summary, status, paper_route_evidence
        )
    )
    blocker_stage = _classify_blocker_stage(
        sources=sources,
        rollout=rollout,
        target=target,
        route=route,
        source_status=source_status,
        lifecycle_economics=lifecycle_economics,
        proof_authority=proof_authority,
        numeric=numeric,
        min_trading_days=min_trading_days,
        min_daily_net_pnl_after_costs=min_daily_net_pnl_after_costs,
        reported_blockers=blockers,
    )
    promotion_allowed = _bool_or_none(
        proof_packet.get("promotion_allowed"),
        proof_packet.get("capital_promotion_allowed"),
        proof_packet.get("final_promotion_allowed"),
    )
    final_authority_ok = _bool_or_none(
        proof_packet.get("final_authority_ok"),
        _mapping(proof_packet.get("post_cost_proof_authority")).get("allowed"),
    )
    if blocker_stage != "no_authority_blocker_detected":
        promotion_allowed = False
        final_authority_ok = False

    return {
        "schema_version": SCHEMA_VERSION,
        "read_only": True,
        "mutation_requests_performed": False,
        "blocker_stage": blocker_stage,
        "blockers": _stable_texts(blockers),
        "identity": {
            "hypothesis_id": identity.hypothesis_id,
            "candidate_id": identity.candidate_id,
            "runtime_strategy_name": identity.runtime_strategy_name,
            "account_label": identity.account_label,
        },
        "thresholds": {
            "min_trading_days": min_trading_days,
            "min_daily_net_pnl_after_costs": _decimal_text(
                min_daily_net_pnl_after_costs
            ),
            "min_filled_notional": _decimal_text(min_filled_notional),
            "min_closed_trades": min_closed_trades,
        },
        "sources": {name: source.to_payload() for name, source in sources.items()},
        "rollout": rollout,
        "target_plan": target,
        "paper_route": route,
        "source_proof": source_status,
        "lifecycle_economics": lifecycle_economics,
        "proof_authority": proof_authority,
        "numeric_readback": numeric.to_payload(),
        "promotion_allowed": promotion_allowed is True,
        "final_authority_ok": final_authority_ok is True,
        "final_authority": bool(proof_authority.get("final_authority") is True),
        "semantics": _classification_semantics(),
    }


def load_sources(args: argparse.Namespace) -> dict[EndpointName, LoadedSource]:
    locations: dict[EndpointName, str | None] = {
        "readyz": _explicit_or_base(args.readyz, args.service_base_url, "/readyz"),
        "trading_status": _explicit_or_base(
            args.trading_status, args.service_base_url, "/trading/status"
        ),
        "paper_route_target_plan": _explicit_or_base(
            args.paper_route_target_plan,
            args.service_base_url,
            "/trading/paper-route-target-plan",
        ),
        "paper_route_evidence": _explicit_or_base(
            args.paper_route_evidence,
            args.service_base_url,
            "/trading/paper-route-evidence",
        ),
        "proof_packet": args.proof_packet_json,
        "source_proof_census": args.source_proof_census_json,
        "runtime_ledger_daily_summary": args.runtime_ledger_daily_summary_json,
    }
    loaded: dict[EndpointName, LoadedSource] = {}
    for name, location in locations.items():
        required = name in REQUIRED_ENDPOINTS
        if not location:
            loaded[name] = LoadedSource(
                name=name, location=None, payload={}, present=False, required=required
            )
            continue
        loaded[name] = _load_json_location(
            name, location, required=required, timeout_seconds=args.http_timeout_seconds
        )
    return loaded


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    min_daily = (
        _decimal(args.min_daily_net_pnl_after_costs) or DEFAULT_MIN_DAILY_NET_PNL
    )
    min_filled_notional = (
        _decimal(args.min_filled_notional) or DEFAULT_MIN_FILLED_NOTIONAL
    )
    report = build_readback_report(
        load_sources(args),
        identity=Identity(
            hypothesis_id=args.hypothesis_id,
            candidate_id=args.candidate_id,
            runtime_strategy_name=args.runtime_strategy_name,
            account_label=args.account_label,
        ),
        min_trading_days=args.min_trading_days,
        min_daily_net_pnl_after_costs=min_daily,
        min_filled_notional=min_filled_notional,
        min_closed_trades=args.min_closed_trades,
    )
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    if (
        args.fail_on_blocker
        and report["blocker_stage"] != "no_authority_blocker_detected"
    ):
        return 1
    return 0


def _absent(name: EndpointName) -> LoadedSource:
    return LoadedSource(
        name=name, location=None, payload={}, present=False, required=False
    )


def _explicit_or_base(
    explicit: str | None, base_url: str | None, endpoint: str
) -> str | None:
    if explicit:
        return explicit
    if not base_url:
        return None
    return urllib.parse.urljoin(base_url.rstrip("/") + "/", endpoint.lstrip("/"))


def _load_json_location(
    name: EndpointName, location: str, *, required: bool, timeout_seconds: float
) -> LoadedSource:
    try:
        if _is_url(location):
            _guard_read_only_url(location)
            request = urllib.request.Request(location, method="GET")
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:  # noqa: S310 - operator-supplied read-only URL
                raw = response.read().decode("utf-8")
        else:
            raw = Path(location).read_text(encoding="utf-8")
        decoded = json.loads(raw)
        if not isinstance(decoded, Mapping):
            return LoadedSource(
                name=name,
                location=location,
                payload={},
                present=False,
                required=required,
                read_error="json_payload_not_object",
            )
        return LoadedSource(
            name=name,
            location=location,
            payload=dict(cast(Mapping[str, Any], decoded)),
            present=True,
            required=required,
        )
    except (OSError, json.JSONDecodeError, urllib.error.URLError, ValueError) as exc:
        return LoadedSource(
            name=name,
            location=location,
            payload={},
            present=False,
            required=required,
            read_error=str(exc),
        )


def _guard_read_only_url(location: str) -> None:
    parsed = urllib.parse.urlparse(location)
    lowered_path = parsed.path.lower()
    for word in MUTATION_WORDS:
        if (
            f"/{word}" in lowered_path
            or lowered_path.endswith(f"-{word}")
            or lowered_path.endswith(f"_{word}")
        ):
            raise ValueError(
                f"refusing non-readback endpoint containing mutation word: {word}"
            )


def _is_url(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def _source_read_blockers(sources: Mapping[EndpointName, LoadedSource]) -> list[str]:
    blockers: list[str] = []
    for name in REQUIRED_ENDPOINTS:
        source = sources[name]
        if not source.present:
            blockers.append(f"{name}_missing_or_unreadable")
    for name, source in sources.items():
        if source.read_error:
            blockers.append(f"{name}_read_error:{source.read_error}")
    return blockers


def _rollout_status(
    readyz: Mapping[str, Any],
    status: Mapping[str, Any],
    proof_packet: Mapping[str, Any],
) -> dict[str, Any]:
    revisions = {
        "readyz": _first_text_at_keys(
            readyz,
            (
                "build_version",
                "revision",
                "torghut_revision",
                "git_sha",
                "commit_sha",
                "image",
            ),
        ),
        "trading_status": _first_text_at_keys(
            status,
            (
                "build_version",
                "revision",
                "torghut_revision",
                "git_sha",
                "commit_sha",
                "image",
            ),
        ),
        "proof_packet": _first_text_at_keys(
            proof_packet,
            (
                "build_version",
                "revision",
                "torghut_revision",
                "git_sha",
                "commit_sha",
                "image",
            ),
        ),
    }
    present_revisions = {key: value for key, value in revisions.items() if value}
    normalized = {value for value in present_revisions.values()}
    ready = _bool_or_none(readyz.get("ok"), readyz.get("ready"), readyz.get("healthy"))
    running = _bool_or_none(
        status.get("running"), _mapping(status.get("trading_loop")).get("running")
    )
    return {
        "ready": ready,
        "running": running,
        "revisions": revisions,
        "drift_detected": len(normalized) > 1,
        "ambiguous": len(present_revisions) < 2,
    }


def _target_status(
    target_plan: Mapping[str, Any],
    paper_route_evidence: Mapping[str, Any],
    status: Mapping[str, Any],
    *,
    identity: Identity,
) -> dict[str, Any]:
    candidates = (
        _candidate_mappings(target_plan)
        + _candidate_mappings(paper_route_evidence)
        + _candidate_mappings(status)
    )
    matching = [item for item in candidates if _matches_identity(item, identity)]
    selected = matching[0] if matching else {}
    target_count = _int_or_none(target_plan.get("target_count"))
    if target_count is None:
        target_count = len(_candidate_mappings(target_plan))
    return {
        "present": bool(matching),
        "target_count": target_count,
        "matched_target_count": len(matching),
        "selected_target": _compact_mapping(selected),
    }


def _paper_route_status(
    target: Mapping[str, Any], evidence: Mapping[str, Any], status: Mapping[str, Any]
) -> dict[str, Any]:
    selected = _mapping(target.get("selected_target"))
    values = [
        _truthy_route_flag(selected),
        _truthy_route_flag(evidence),
        _truthy_route_flag(status),
        _bool_or_none(
            evidence.get("paper_route_active"),
            evidence.get("route_active"),
            evidence.get("active"),
        ),
    ]
    blockers = _text_list(selected.get("blockers")) + _text_list(
        evidence.get("blockers")
    )
    has_inactive_blocker = any(
        "inactive" in blocker or "disabled" in blocker or "not_eligible" in blocker
        for blocker in blockers
    )
    active = (
        True
        if any(value is True for value in values) and not has_inactive_blocker
        else False
    )
    return {
        "active": active,
        "route_flags": [value for value in values if value is not None],
        "blockers": blockers,
    }


def _source_ref_status(
    proof_packet: Mapping[str, Any],
    source_census: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
) -> dict[str, Any]:
    payloads = _non_empty_payloads(
        proof_packet,
        source_census,
        runtime_summary,
        _mapping(
            _mapping(proof_packet.get("evidence")).get("hpairs_source_proof_census")
        ),
    )
    source_refs_present = any(
        _has_positive_key(payload, SOURCE_REF_KEYS) for payload in payloads
    )
    source_windows_present = any(
        _has_positive_key(payload, SOURCE_WINDOW_KEYS) for payload in payloads
    )
    blockers = _reported_blockers(*payloads)
    if any(
        any(word in blocker for word in SOURCE_MISSING_WORDS) for blocker in blockers
    ):
        source_refs_present = False
    return {
        "source_refs_present": source_refs_present,
        "source_windows_present": source_windows_present,
        "source_ref_count": _first_int_at_keys(
            payloads, ("source_ref_count", "source_refs_count")
        ),
        "source_window_count": _first_int_at_keys(
            payloads, ("source_window_count", "source_windows_count")
        ),
        "blockers": blockers,
    }


def _lifecycle_economics_status(
    proof_packet: Mapping[str, Any],
    source_census: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
) -> dict[str, Any]:
    payloads = _non_empty_payloads(
        proof_packet,
        source_census,
        runtime_summary,
        _mapping(
            _mapping(proof_packet.get("evidence")).get("hpairs_source_proof_census")
        ),
    )
    lifecycle = _first_bool_at_keys(payloads, LIFECYCLE_KEYS)
    economics = _first_bool_at_keys(payloads, ECONOMICS_KEYS)
    blockers = _reported_blockers(*payloads)
    if any(
        any(word in blocker for word in LIFECYCLE_ECONOMICS_WORDS)
        for blocker in blockers
    ):
        if any(
            "lifecycle" in blocker or "order_feed" in blocker for blocker in blockers
        ):
            lifecycle = False
        if any("economic" in blocker or "cost" in blocker for blocker in blockers):
            economics = False
    return {
        "lifecycle_complete": lifecycle is True,
        "economics_complete": economics is True,
        "lifecycle_observed": lifecycle,
        "economics_observed": economics,
        "blockers": blockers,
    }


def _proof_authority_status(proof_packet: Mapping[str, Any]) -> dict[str, Any]:
    present = bool(proof_packet)
    proof_mode = _text(proof_packet.get("proof_mode"))
    mode_contract = _mapping(proof_packet.get("proof_mode_contract"))
    final_authority = _bool_or_none(
        proof_packet.get("final_authority"),
        _mapping(proof_packet.get("target")).get("final_authority"),
        mode_contract.get("final_authority"),
    )
    final_authority_ok = _bool_or_none(
        proof_packet.get("final_authority_ok"),
        _mapping(proof_packet.get("post_cost_proof_authority")).get("allowed"),
    )
    promotion_allowed = _bool_or_none(
        proof_packet.get("promotion_allowed"),
        proof_packet.get("capital_promotion_allowed"),
        proof_packet.get("final_promotion_allowed"),
    )
    return {
        "present": present,
        "proof_mode": proof_mode,
        "authority_mode": proof_mode == "authority",
        "final_authority": final_authority,
        "final_authority_ok": final_authority_ok,
        "promotion_allowed": promotion_allowed,
        "ambiguous": not present or not proof_mode or final_authority is None,
    }


def _numeric_readback(
    proof_packet: Mapping[str, Any],
    source_census: Mapping[str, Any],
    runtime_summary: Mapping[str, Any],
) -> NumericReadback:
    payloads = _non_empty_payloads(
        runtime_summary,
        proof_packet,
        source_census,
        _mapping(
            _mapping(proof_packet.get("evidence")).get("completion_live_scale")
        ).get("runtime_ledger_summary"),
        _mapping(proof_packet.get("aggregate")),
        _mapping(proof_packet.get("target")),
    )
    daily = tuple(_daily_net_pnls(payloads))
    trading_days = _first_int_at_keys(
        payloads, ("trading_days", "trading_day_count", "clean_authority_trading_days")
    )
    if trading_days is None and daily:
        trading_days = len(daily)
    mean = _first_decimal_at_keys(
        payloads, ("mean_daily_net_pnl_after_costs", "mean_net_pnl_after_costs")
    )
    median = _first_decimal_at_keys(
        payloads, ("median_daily_net_pnl_after_costs", "median_net_pnl_after_costs")
    )
    worst = _first_decimal_at_keys(
        payloads, ("worst_daily_net_pnl_after_costs", "worst_day_net_pnl_after_costs")
    )
    if daily:
        mean = mean if mean is not None else sum(daily) / Decimal(len(daily))
        median = (
            median if median is not None else Decimal(str(statistics.median(daily)))
        )
        worst = worst if worst is not None else min(daily)
    return NumericReadback(
        trading_days=trading_days,
        daily_net_pnl_after_costs=daily,
        mean_daily_net_pnl_after_costs=mean,
        median_daily_net_pnl_after_costs=median,
        worst_daily_net_pnl_after_costs=worst,
        filled_notional=_first_decimal_at_keys(payloads, FILLED_NOTIONAL_KEYS),
        closed_trades=_first_int_at_keys(payloads, CLOSED_TRADES_KEYS),
        open_positions=_first_int_at_keys(payloads, OPEN_POSITIONS_KEYS),
        max_drawdown_pct_equity=_first_decimal_at_keys(
            payloads, ("max_drawdown_pct_equity", "drawdown_pct_equity", "max_drawdown")
        ),
        best_day_share=_first_decimal_at_keys(
            payloads, ("best_day_share", "max_best_day_share")
        ),
        symbol_concentration_share=_first_decimal_at_keys(
            payloads, ("symbol_concentration_share", "max_symbol_concentration_share")
        ),
    )


def _numeric_blockers(
    numeric: NumericReadback,
    *,
    min_trading_days: int,
    min_daily_net_pnl_after_costs: Decimal,
    min_filled_notional: Decimal,
    min_closed_trades: int,
) -> list[str]:
    blockers: list[str] = []
    if numeric.daily_net_pnl_after_costs and min(numeric.daily_net_pnl_after_costs) < 0:
        blockers.append("daily_net_pnl_negative")
    if (
        numeric.mean_daily_net_pnl_after_costs is not None
        and numeric.mean_daily_net_pnl_after_costs < 0
    ):
        blockers.append("mean_daily_net_pnl_negative")
    if numeric.trading_days is None or numeric.trading_days < min_trading_days:
        blockers.append("insufficient_trading_days")
    for name, value in (
        ("mean_daily_net_pnl_after_costs", numeric.mean_daily_net_pnl_after_costs),
        ("median_daily_net_pnl_after_costs", numeric.median_daily_net_pnl_after_costs),
        ("worst_daily_net_pnl_after_costs", numeric.worst_daily_net_pnl_after_costs),
    ):
        if value is None:
            blockers.append(f"{name}_missing")
        elif value < min_daily_net_pnl_after_costs:
            blockers.append(f"{name}_below_threshold")
    if numeric.filled_notional is None or numeric.filled_notional < min_filled_notional:
        blockers.append("filled_notional_missing_or_below_threshold")
    if numeric.closed_trades is None or numeric.closed_trades < min_closed_trades:
        blockers.append("closed_trades_missing_or_below_threshold")
    if numeric.open_positions is None:
        blockers.append("open_positions_missing")
    elif numeric.open_positions > 0:
        blockers.append("open_positions_block_authority")
    return blockers


def _classify_blocker_stage(
    *,
    sources: Mapping[EndpointName, LoadedSource],
    rollout: Mapping[str, Any],
    target: Mapping[str, Any],
    route: Mapping[str, Any],
    source_status: Mapping[str, Any],
    lifecycle_economics: Mapping[str, Any],
    proof_authority: Mapping[str, Any],
    numeric: NumericReadback,
    min_trading_days: int,
    min_daily_net_pnl_after_costs: Decimal,
    reported_blockers: Sequence[str],
) -> BlockerStage:
    if (
        any(not sources[name].present for name in ("readyz", "trading_status"))
        or rollout.get("drift_detected") is True
    ):
        return "rollout_drift"
    if (
        any(not sources[name].present for name in ("paper_route_target_plan",))
        or target.get("present") is not True
    ):
        return "target_plan_missing"
    if (
        any(not sources[name].present for name in ("paper_route_evidence",))
        or route.get("active") is not True
    ):
        return "paper_route_inactive"
    if (
        source_status.get("source_refs_present") is not True
        or source_status.get("source_windows_present") is not True
    ):
        return "source_refs_missing"
    if (
        lifecycle_economics.get("lifecycle_complete") is not True
        or lifecycle_economics.get("economics_complete") is not True
    ):
        return "lifecycle_economics_blocked"
    if (
        proof_authority.get("authority_mode") is not True
        or proof_authority.get("final_authority") is not True
    ):
        return "proof_mode_not_authority"
    if _has_negative_pnl(numeric):
        return "negative_pnl"
    if numeric.trading_days is None or numeric.trading_days < min_trading_days:
        return "insufficient_days"
    if _has_insufficient_daily_pnl(numeric, min_daily_net_pnl_after_costs):
        return "insufficient_daily_pnl"
    if _has_concentration_or_drawdown_blocker(numeric, reported_blockers):
        return "concentration_or_drawdown_blocked"
    return "no_authority_blocker_detected"


def _has_negative_pnl(numeric: NumericReadback) -> bool:
    values = list(numeric.daily_net_pnl_after_costs)
    for value in (
        numeric.mean_daily_net_pnl_after_costs,
        numeric.median_daily_net_pnl_after_costs,
        numeric.worst_daily_net_pnl_after_costs,
    ):
        if value is not None:
            values.append(value)
    return any(value < 0 for value in values)


def _has_insufficient_daily_pnl(numeric: NumericReadback, threshold: Decimal) -> bool:
    values = (
        numeric.mean_daily_net_pnl_after_costs,
        numeric.median_daily_net_pnl_after_costs,
        numeric.worst_daily_net_pnl_after_costs,
    )
    return any(value is None or value < threshold for value in values)


def _has_concentration_or_drawdown_blocker(
    numeric: NumericReadback, blockers: Sequence[str]
) -> bool:
    if any(
        any(word in blocker for word in CONCENTRATION_DRAWDOWN_WORDS)
        for blocker in blockers
    ):
        return True
    for value in (
        numeric.max_drawdown_pct_equity,
        numeric.best_day_share,
        numeric.symbol_concentration_share,
    ):
        if value is not None and value > 0:
            return True
    return False


def _classification_semantics() -> dict[str, str]:
    return {
        "rollout_drift": "A required rollout/status source is unreadable or readyz/status/proof revisions disagree.",
        "target_plan_missing": "No matching H-PAIRS target is present in the configured target-plan/evidence/status sources.",
        "paper_route_inactive": "The matching target exists but paper-route activity/eligibility is false, blocked, or ambiguous.",
        "source_refs_missing": "Runtime/source proof lacks source references or source-window evidence, or reports source-only blockers.",
        "lifecycle_economics_blocked": "Order-feed lifecycle or execution economics/cost evidence is incomplete or blocked.",
        "proof_mode_not_authority": "The proof packet is missing, ambiguous, or not explicit final authority mode.",
        "negative_pnl": "Observed post-cost daily/mean/median/worst PnL is negative.",
        "insufficient_days": "Authority-mode proof exists, but trading-day count is below the configured floor.",
        "insufficient_daily_pnl": "Authority-mode proof exists, but mean/median/worst post-cost daily PnL is missing or below threshold.",
        "concentration_or_drawdown_blocked": "Authority-mode proof exists, but concentration/drawdown evidence reports blockers.",
        "no_authority_blocker_detected": "No readback blocker was detected from the supplied read-only sources; this is not a promotion action.",
    }


def _candidate_mappings(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    candidates: list[Mapping[str, Any]] = []
    stack: list[Any] = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, Mapping):
            mapping = cast(Mapping[str, Any], item)
            if _looks_like_candidate(mapping):
                candidates.append(mapping)
            for key, value in mapping.items():
                if key in TARGET_COLLECTION_KEYS or isinstance(
                    value, (Mapping, list, tuple)
                ):
                    stack.append(value)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)
    return candidates


def _looks_like_candidate(mapping: Mapping[str, Any]) -> bool:
    return any(
        key in mapping
        for key in (
            "hypothesis_id",
            "candidate_id",
            "runtime_strategy_name",
            "strategy_name",
        )
    )


def _matches_identity(mapping: Mapping[str, Any], identity: Identity) -> bool:
    hypothesis = _text(mapping.get("hypothesis_id"))
    candidate = _text(mapping.get("candidate_id"))
    strategy = _text(mapping.get("runtime_strategy_name")) or _text(
        mapping.get("strategy_name")
    )
    account = _text(mapping.get("account_label")) or _text(
        mapping.get("alpaca_account_label")
    )
    checks = [
        not hypothesis or hypothesis == identity.hypothesis_id,
        not candidate or candidate == identity.candidate_id,
        not strategy or strategy == identity.runtime_strategy_name,
        not account or account == identity.account_label,
    ]
    return any((hypothesis, candidate, strategy)) and all(checks)


def _truthy_route_flag(payload: Mapping[str, Any]) -> bool | None:
    values: list[bool] = []
    for key, value in _walk_items(payload):
        lowered = key.lower()
        if any(
            token in lowered
            for token in (
                "route_enabled",
                "route_eligible",
                "paper_route",
                "submit_enabled",
                "active",
            )
        ):
            parsed = _bool_or_none(value)
            if parsed is not None:
                values.append(parsed)
    if not values:
        return None
    return any(values)


def _has_positive_key(payload: Mapping[str, Any], keys: Sequence[str]) -> bool:
    for key, value in _walk_items(payload):
        if key in keys:
            if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                return len(value) > 0
            integer = _int_or_none(value)
            if integer is not None:
                return integer > 0
            if value:
                return True
    return False


def _daily_net_pnls(payloads: Sequence[Mapping[str, Any]]) -> list[Decimal]:
    values: list[Decimal] = []
    for payload in payloads:
        for key, value in _walk_items(payload):
            if (
                key in DAILY_COLLECTION_KEYS
                and isinstance(value, Sequence)
                and not isinstance(value, (str, bytes))
            ):
                for item in value:
                    if isinstance(item, Mapping):
                        number = _first_decimal_at_keys(
                            [cast(Mapping[str, Any], item)], NET_PNL_KEYS
                        )
                    else:
                        number = _decimal(item)
                    if number is not None:
                        values.append(number)
            elif key in NET_PNL_KEYS and not isinstance(value, (Mapping, list, tuple)):
                # Single aggregate PnL values are used only when explicitly named daily.
                if "daily" in key:
                    number = _decimal(value)
                    if number is not None:
                        values.append(number)
    return values


def _reported_blockers(*payloads: Mapping[str, Any]) -> list[str]:
    blockers: list[str] = []
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in {
                "blockers",
                "authority_blockers",
                "blocking_reasons",
                "proof_blockers",
                "failed_checks",
            }:
                blockers.extend(_text_list(value))
    return _stable_texts(blockers)


def _first_text_at_keys(payload: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key, value in _walk_items(payload):
        if key in keys:
            text = _text(value)
            if text:
                return text
    return None


def _first_bool_at_keys(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> bool | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in keys:
                parsed = _bool_or_none(value)
                if parsed is not None:
                    return parsed
    return None


def _first_int_at_keys(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> int | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in keys:
                parsed = _int_or_none(value)
                if parsed is not None:
                    return parsed
                if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
                    return len(value)
    return None


def _first_decimal_at_keys(
    payloads: Sequence[Mapping[str, Any]], keys: Sequence[str]
) -> Decimal | None:
    for payload in payloads:
        for key, value in _walk_items(payload):
            if key in keys:
                parsed = _decimal(value)
                if parsed is not None:
                    return parsed
    return None


def _walk_items(payload: Mapping[str, Any]) -> Iterable[tuple[str, Any]]:
    stack: list[Any] = [payload]
    while stack:
        item = stack.pop()
        if isinstance(item, Mapping):
            for raw_key, value in cast(Mapping[str, Any], item).items():
                key = str(raw_key)
                yield key, value
                if isinstance(value, (Mapping, list, tuple)):
                    stack.append(value)
        elif isinstance(item, (list, tuple)):
            stack.extend(item)


def _non_empty_payloads(*payloads: object) -> list[Mapping[str, Any]]:
    result: list[Mapping[str, Any]] = []
    for payload in payloads:
        if isinstance(payload, Mapping) and payload:
            result.append(cast(Mapping[str, Any], payload))
    return result


def _mapping(value: object) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return cast(Mapping[str, Any], value)
    return {}


def _compact_mapping(value: Mapping[str, Any]) -> dict[str, Any]:
    keys = (
        "hypothesis_id",
        "candidate_id",
        "runtime_strategy_name",
        "strategy_name",
        "account_label",
        "alpaca_account_label",
        "route_enabled",
        "paper_route_enabled",
        "paper_route_eligible",
        "route_eligible",
        "submit_enabled",
        "simple_submit_enabled",
        "promotion_allowed",
        "final_authority_ok",
        "final_promotion_allowed",
        "blockers",
    )
    return {key: value[key] for key in keys if key in value}


def _text(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    if isinstance(value, (int, float, bool, Decimal)):
        return str(value)
    return None


def _text_list(value: object) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Mapping):
        return [str(key) for key, item in value.items() if item]
    if isinstance(value, Iterable):
        result: list[str] = []
        for item in value:
            text = _text(item)
            if text:
                result.append(text)
        return result
    text = _text(value)
    return [] if text is None else [text]


def _stable_texts(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = value.strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


def _bool_or_none(*values: object) -> bool | None:
    for value in values:
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {
                "true",
                "1",
                "yes",
                "y",
                "ok",
                "ready",
                "active",
                "enabled",
            }:
                return True
            if normalized in {
                "false",
                "0",
                "no",
                "n",
                "blocked",
                "inactive",
                "disabled",
            }:
                return False
        if isinstance(value, int) and value in {0, 1}:
            return bool(value)
    return None


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _decimal(value: object) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except (InvalidOperation, ValueError):
            return None
    return None


def _decimal_text(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return format(value, "f")


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
