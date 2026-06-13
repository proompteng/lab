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
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
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
    "paper_route_target_plan": "/trading/proofs?kind=runtime_window&window=next&limit=20",
    "paper_route_evidence": "/trading/proofs?kind=runtime_window&window=latest_closed&full_audit=true&limit=20",
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
        from .source_readback import _text

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
        from .source_readback import _decimal_text

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
        help="Base URL used to read /readyz, /trading/status, and /trading/proofs.",
    )
    parser.add_argument("--readyz", help="URL or JSON file path for /readyz.")
    parser.add_argument(
        "--trading-status", help="URL or JSON file path for /trading/status."
    )
    parser.add_argument(
        "--paper-route-target-plan",
        help="URL or JSON file path for /trading/proofs?window=next.",
    )
    parser.add_argument(
        "--paper-route-evidence",
        help="URL or JSON file path for /trading/proofs?window=latest_closed.",
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
    from .target_status import (
        _classify_blocker_stage,
        _classification_semantics,
        _lifecycle_economics_status,
        _numeric_blockers,
        _numeric_readback,
        _paper_route_status,
        _proof_authority_status,
        _source_collection_readback,
        _source_ref_status,
        _target_status,
    )

    from .source_readback import (
        _bool_or_none,
        _decimal_text,
        _mapping,
        _reported_blockers,
        _stable_texts,
    )

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
    source_status = _source_ref_status(
        proof_packet,
        source_census,
        runtime_summary,
        target_plan,
        paper_route_evidence,
        status,
        identity=identity,
    )
    if (
        source_status["source_refs_present"] is not True
        or source_status["source_windows_present"] is not True
    ):
        blockers.append("hpairs_source_refs_or_windows_missing")
    lifecycle_economics = _lifecycle_economics_status(
        proof_packet,
        source_census,
        runtime_summary,
        target_plan,
        paper_route_evidence,
        status,
        identity=identity,
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
        "source_collection_readback": _source_collection_readback(
            target_plan, paper_route_evidence, status, identity=identity
        ),
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
            READ_ONLY_ENDPOINTS["paper_route_target_plan"],
        ),
        "paper_route_evidence": _explicit_or_base(
            args.paper_route_evidence,
            args.service_base_url,
            READ_ONLY_ENDPOINTS["paper_route_evidence"],
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
    from .source_readback import _decimal

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
    from .source_readback import _bool_or_none, _first_text_at_keys, _mapping

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
