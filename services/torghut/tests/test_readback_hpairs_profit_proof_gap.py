from __future__ import annotations

import json
from pathlib import Path
from types import TracebackType
from typing import Any
from urllib.request import Request

from scripts import readback_hpairs_profit_proof_gap as cli


_ABSENT = object()


def _write_json(path: Path, payload: dict[str, Any]) -> str:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def _target() -> dict[str, Any]:
    return {
        "hypothesis_id": cli.DEFAULT_HPAIRS_HYPOTHESIS_ID,
        "candidate_id": cli.DEFAULT_HPAIRS_CANDIDATE_ID,
        "runtime_strategy_name": cli.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
        "account_label": cli.DEFAULT_ACCOUNT_LABEL,
        "paper_route_enabled": True,
        "paper_route_eligible": True,
        "submit_enabled": True,
    }


def _readyz(revision: str = "rev-a") -> dict[str, Any]:
    return {"schema_version": "readyz.v1", "ready": True, "revision": revision}


def _status(revision: str = "rev-a") -> dict[str, Any]:
    return {
        "schema_version": "trading-status.v1",
        "running": True,
        "revision": revision,
        "target": _target(),
    }


def _target_plan() -> dict[str, Any]:
    return {
        "schema_version": "torghut.paper-route-target-plan.v1",
        "target_count": 1,
        "targets": [_target()],
    }


def _paper_route_evidence(active: bool = True) -> dict[str, Any]:
    return {
        "schema_version": "torghut.paper-route-evidence.v1",
        "paper_route_active": active,
        "targets": [
            _target() | {"paper_route_eligible": active, "paper_route_enabled": active}
        ],
        "blockers": [] if active else ["paper_route_inactive"],
    }


def _source_census(
    source_refs: bool = True, lifecycle: bool = True, economics: bool = True
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.hpairs-source-proof-census.v1",
        "source_refs": ["postgres:trade_decisions", "postgres:executions"]
        if source_refs
        else [],
        "source_window_ids": ["window-1"] if source_refs else [],
        "source_ref_count": 2 if source_refs else 0,
        "source_window_count": 1 if source_refs else 0,
        "order_feed_lifecycle_complete": lifecycle,
        "execution_economics_complete": economics,
        "blockers": [] if source_refs else ["runtime_ledger_source_refs_missing"],
    }


def _runtime_summary(
    *,
    days: int = 20,
    net_pnl: str = "600",
    filled_notional: str = "12000000",
    closed_trades: int = 400,
    open_positions: int = 0,
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.runtime-ledger-daily-summary.v1",
        "trading_days": [
            {
                "date": f"2026-05-{day + 1:02d}",
                "net_pnl_after_costs": net_pnl,
                "filled_notional": "600000",
                "closed_trades": 20,
                "open_positions": 0,
            }
            for day in range(days)
        ],
        "filled_notional": filled_notional,
        "closed_trades": closed_trades,
        "open_positions": open_positions,
    }


def _proof_packet(
    proof_mode: str = "authority", final_authority: bool = True
) -> dict[str, Any]:
    return {
        "schema_version": "torghut.runtime-ledger-proof-packet.v1",
        "revision": "rev-a",
        "proof_mode": proof_mode,
        "final_authority": final_authority,
        "final_authority_ok": final_authority,
        "promotion_allowed": final_authority,
        "capital_promotion_allowed": final_authority,
        "final_promotion_allowed": final_authority,
        "post_cost_proof_authority": {"allowed": final_authority},
    }


def _sources(
    *,
    readyz: dict[str, Any] | None | object = _ABSENT,
    status: dict[str, Any] | None | object = _ABSENT,
    target_plan: dict[str, Any] | None | object = _ABSENT,
    paper_route_evidence: dict[str, Any] | None | object = _ABSENT,
    proof_packet: dict[str, Any] | None | object = _ABSENT,
    source_census: dict[str, Any] | None | object = _ABSENT,
    runtime_summary: dict[str, Any] | None | object = _ABSENT,
) -> dict[cli.EndpointName, cli.LoadedSource]:
    payloads: dict[cli.EndpointName, dict[str, Any] | None] = {
        "readyz": _readyz() if readyz is _ABSENT else readyz,
        "trading_status": _status() if status is _ABSENT else status,
        "paper_route_target_plan": _target_plan()
        if target_plan is _ABSENT
        else target_plan,
        "paper_route_evidence": _paper_route_evidence()
        if paper_route_evidence is _ABSENT
        else paper_route_evidence,
        "proof_packet": _proof_packet() if proof_packet is _ABSENT else proof_packet,
        "source_proof_census": _source_census()
        if source_census is _ABSENT
        else source_census,
        "runtime_ledger_daily_summary": _runtime_summary()
        if runtime_summary is _ABSENT
        else runtime_summary,
    }
    return {
        name: cli.LoadedSource(
            name=name,
            location=f"fixture://{name}",
            payload={} if payload is None else payload,
            present=payload is not None,
            required=name in cli.REQUIRED_ENDPOINTS,
        )
        for name, payload in payloads.items()
    }


def _report(**overrides: Any) -> dict[str, Any]:
    return cli.build_readback_report(
        _sources(**overrides),
        identity=cli.Identity(
            hypothesis_id=cli.DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=cli.DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=cli.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=cli.DEFAULT_ACCOUNT_LABEL,
        ),
    )


def test_merged_happy_path_authority_classification() -> None:
    report = _report()

    assert report["schema_version"] == cli.SCHEMA_VERSION
    assert report["read_only"] is True
    assert report["mutation_requests_performed"] is False
    assert report["blocker_stage"] == "no_authority_blocker_detected"
    assert report["promotion_allowed"] is True
    assert report["final_authority_ok"] is True
    assert report["numeric_readback"]["trading_days"] == 20
    assert report["numeric_readback"]["mean_daily_net_pnl_after_costs"] == "600"
    assert report["numeric_readback"]["median_daily_net_pnl_after_costs"] == "600"
    assert report["numeric_readback"]["worst_daily_net_pnl_after_costs"] == "600"
    assert report["numeric_readback"]["filled_notional"] == "12000000"
    assert report["numeric_readback"]["closed_trades"] == 400
    assert report["numeric_readback"]["open_positions"] == 0


def test_negative_one_day_current_hpairs_state_classification() -> None:
    report = _report(
        runtime_summary=_runtime_summary(
            days=1,
            net_pnl="-2.49365856",
            filled_notional="8703.84",
            closed_trades=16,
            open_positions=70,
        )
    )

    assert report["blocker_stage"] == "negative_pnl"
    assert report["promotion_allowed"] is False
    assert report["final_authority_ok"] is False
    assert report["numeric_readback"] == {
        "trading_days": 1,
        "daily_net_pnl_after_costs": ["-2.49365856"],
        "mean_daily_net_pnl_after_costs": "-2.49365856",
        "median_daily_net_pnl_after_costs": "-2.49365856",
        "worst_daily_net_pnl_after_costs": "-2.49365856",
        "filled_notional": "8703.84",
        "closed_trades": 16,
        "open_positions": 70,
        "max_drawdown_pct_equity": None,
        "best_day_share": None,
        "symbol_concentration_share": None,
    }
    assert "daily_net_pnl_negative" in report["blockers"]
    assert "insufficient_trading_days" in report["blockers"]
    assert "open_positions_block_authority" in report["blockers"]


def test_missing_source_refs_fail_closed_before_authority() -> None:
    report = _report(source_census=_source_census(source_refs=False))

    assert report["blocker_stage"] == "source_refs_missing"
    assert report["source_proof"]["source_refs_present"] is False
    assert report["source_proof"]["source_windows_present"] is False
    assert report["promotion_allowed"] is False


def test_missing_proof_packet_is_proof_mode_not_authority() -> None:
    report = _report(proof_packet=None)

    assert report["blocker_stage"] == "proof_mode_not_authority"
    assert report["proof_authority"] == {
        "present": False,
        "proof_mode": None,
        "authority_mode": False,
        "final_authority": None,
        "final_authority_ok": None,
        "promotion_allowed": None,
        "ambiguous": True,
    }
    assert report["promotion_allowed"] is False
    assert "runtime_ledger_proof_mode_not_authority" in report["blockers"]


def test_embedded_source_collection_readback_does_not_create_authority() -> None:
    source_target = _target() | {
        "runtime_strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
        "source_kind": "runtime_ledger_source_collection_candidate",
        "source_collection_profit_target_candidate": True,
        "source_collection_net_strategy_pnl_after_costs": "567.44720578",
        "source_collection_filled_notional": "127090.02495200",
        "source_collection_post_cost_expectancy_bps": "44.64923238",
        "target_notional": "75000",
        "max_notional": "75000",
        "source_collection_next_action": "materialize_runtime_ledger_source_window_refs",
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_tca_metrics",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_window_ids": ["window-1", "window-2"],
        "source_row_counts": {
            "trade_decisions": 3,
            "executions": 3,
            "execution_tca_metrics": 3,
            "execution_order_events": 8,
            "order_feed_source_windows": 8,
        },
        "final_promotion_blockers": [
            "runtime_ledger_source_collection_only",
            "live_runtime_ledger_required",
        ],
    }
    evidence = _paper_route_evidence() | {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": {
                "targets": [source_target],
            }
        }
    }

    report = _report(
        paper_route_evidence=evidence,
        proof_packet=None,
        source_census=None,
        runtime_summary=None,
    )

    assert report["blocker_stage"] == "proof_mode_not_authority"
    assert report["source_proof"]["source_refs_present"] is True
    assert report["source_proof"]["source_windows_present"] is True
    assert report["source_proof"]["source_ref_count"] == 5
    assert report["source_proof"]["source_window_count"] == 2
    assert report["lifecycle_economics"]["lifecycle_complete"] is True
    assert report["lifecycle_economics"]["economics_complete"] is True
    assert report["source_collection_readback"]["present"] is True
    assert report["source_collection_readback"]["source_refs_present"] is True
    assert report["source_collection_readback"]["source_windows_present"] is True
    assert report["source_collection_readback"]["profit_target_present"] is True
    assert (
        report["source_collection_readback"]["profit_target_source_refs_present"]
        is True
    )
    assert (
        report["source_collection_readback"]["profit_target_source_windows_present"]
        is True
    )
    selected = report["source_collection_readback"]["selected_observation"]
    assert selected["source_collection_net_strategy_pnl_after_costs"] == "567.44720578"
    assert selected["source_collection_filled_notional"] == "127090.02495200"
    assert selected["source_collection_next_action"] == (
        "materialize_runtime_ledger_source_window_refs"
    )
    assert report["promotion_allowed"] is False
    assert report["final_authority_ok"] is False
    assert "runtime_ledger_proof_mode_not_authority" in report["blockers"]


def test_source_collection_readback_prefers_materialized_refs_over_blank_target() -> (
    None
):
    blank_target = _target() | {
        "runtime_strategy_name": "69cf50e3-4815-47c2-b802-1efbaac09ecb",
        "source_kind": "runtime_ledger_source_collection_candidate",
        "source_collection_profit_target_candidate": True,
        "source_collection_net_strategy_pnl_after_costs": "567.44720578",
        "source_collection_filled_notional": "127090.02495200",
        "source_collection_post_cost_expectancy_bps": "44.64923238",
        "target_notional": "75000",
        "max_notional": "75000",
        "source_collection_next_action": "materialize_runtime_ledger_source_window_refs",
        "source_row_counts": {"strategy_runtime_ledger_buckets": 1},
        "final_promotion_blockers": [
            "runtime_ledger_source_refs_missing",
            "runtime_ledger_source_collection_only",
            "live_runtime_ledger_required",
        ],
    }
    materialized_source = blank_target | {
        "bucket_started_at": "2026-05-13T17:00:00+00:00",
        "bucket_ended_at": "2026-05-13T17:30:00+00:00",
        "source_refs": [
            "postgres:trade_decisions",
            "postgres:executions",
            "postgres:execution_tca_metrics",
            "postgres:execution_order_events",
            "postgres:order_feed_source_windows",
        ],
        "source_window_ids": ["window-1", "window-2"],
        "source_row_counts": {
            "trade_decisions": 3,
            "executions": 3,
            "execution_tca_metrics": 3,
            "execution_order_events": 8,
            "order_feed_source_windows": 8,
        },
    }
    evidence = _paper_route_evidence() | {
        "live_submission_gate": {
            "runtime_ledger_paper_probation_import_plan": {
                "targets": [blank_target],
            }
        }
    }
    status = _status() | {
        "live_submission_gate": {
            "runtime_ledger_source_collection_profit_target_candidates": [
                materialized_source
            ],
        }
    }

    report = _report(
        status=status,
        paper_route_evidence=evidence,
        proof_packet=None,
        source_census=None,
        runtime_summary=None,
    )

    assert report["blocker_stage"] == "proof_mode_not_authority"
    assert report["source_proof"]["source_refs_present"] is True
    assert report["source_proof"]["source_windows_present"] is True
    assert report["source_proof"]["reported_source_blockers"] == [
        "runtime_ledger_source_refs_missing"
    ]
    selected = report["source_collection_readback"]["selected_observation"]
    assert selected["bucket_started_at"] == "2026-05-13T17:00:00+00:00"
    assert selected["bucket_ended_at"] == "2026-05-13T17:30:00+00:00"
    assert selected["source_ref_count"] == 5
    assert selected["source_window_count"] == 2
    assert report["source_collection_readback"]["source_refs_present"] is True
    assert report["source_collection_readback"]["source_windows_present"] is True
    profit_target = report["source_collection_readback"]["profit_target_observation"]
    assert profit_target["source_collection_net_strategy_pnl_after_costs"] == (
        "567.44720578"
    )
    assert (
        report["source_collection_readback"]["profit_target_source_refs_present"]
        is True
    )
    assert (
        report["source_collection_readback"]["profit_target_source_windows_present"]
        is True
    )
    assert report["promotion_allowed"] is False
    assert report["final_authority_ok"] is False


def test_rollout_drift_is_first_blocker() -> None:
    report = _report(status=_status(revision="rev-b"))

    assert report["blocker_stage"] == "rollout_drift"
    assert report["rollout"]["drift_detected"] is True
    assert "rollout_revision_drift" in report["blockers"]


def test_missing_target_plan_is_reported_before_route_checks() -> None:
    report = _report(
        status={
            "schema_version": "trading-status.v1",
            "running": True,
            "revision": "rev-a",
        },
        target_plan={
            "schema_version": "torghut.paper-route-target-plan.v1",
            "targets": [],
        },
        paper_route_evidence={
            "schema_version": "torghut.paper-route-evidence.v1",
            "targets": [],
        },
    )

    assert report["blocker_stage"] == "target_plan_missing"
    assert report["target_plan"]["present"] is False
    assert report["target_plan"]["target_count"] == 0
    assert "hpairs_target_plan_missing" in report["blockers"]


def test_inactive_paper_route_is_reported_after_target_match() -> None:
    report = _report(paper_route_evidence=_paper_route_evidence(active=False))

    assert report["blocker_stage"] == "paper_route_inactive"
    assert report["paper_route"]["active"] is False
    assert "hpairs_paper_route_inactive_or_ambiguous" in report["blockers"]


def test_lifecycle_and_execution_cost_blockers_fail_closed() -> None:
    source_census = _source_census(lifecycle=False, economics=False) | {
        "blockers": ["order_feed_lifecycle_missing", "explicit_cost_missing"],
    }

    report = _report(source_census=source_census)

    assert report["blocker_stage"] == "lifecycle_economics_blocked"
    assert report["lifecycle_economics"]["lifecycle_complete"] is False
    assert report["lifecycle_economics"]["economics_complete"] is False
    assert "runtime_lifecycle_or_execution_economics_blocked" in report["blockers"]


def test_missing_numeric_readback_blocks_authority() -> None:
    report = _report(
        runtime_summary={
            "schema_version": "torghut.runtime-ledger-daily-summary.v1",
            "trading_days": [],
        }
    )

    assert report["blocker_stage"] == "insufficient_days"
    assert report["numeric_readback"]["trading_days"] == 0
    assert "mean_daily_net_pnl_after_costs_missing" in report["blockers"]
    assert "filled_notional_missing_or_below_threshold" in report["blockers"]
    assert "closed_trades_missing_or_below_threshold" in report["blockers"]
    assert "open_positions_missing" in report["blockers"]


def test_positive_but_below_target_daily_pnl_blocks_authority() -> None:
    report = _report(runtime_summary=_runtime_summary(days=20, net_pnl="499.99"))

    assert report["blocker_stage"] == "insufficient_daily_pnl"
    assert "mean_daily_net_pnl_after_costs_below_threshold" in report["blockers"]
    assert "median_daily_net_pnl_after_costs_below_threshold" in report["blockers"]
    assert "worst_daily_net_pnl_after_costs_below_threshold" in report["blockers"]


def test_concentration_and_drawdown_evidence_blocks_authority() -> None:
    runtime_summary = _runtime_summary() | {
        "max_drawdown_pct_equity": "0.01",
        "best_day_share": "0.25",
        "symbol_concentration_share": "0.35",
    }

    report = _report(runtime_summary=runtime_summary)

    assert report["blocker_stage"] == "concentration_or_drawdown_blocked"
    assert report["promotion_allowed"] is False


def test_json_source_non_object_and_read_errors_are_reported(tmp_path: Path) -> None:
    list_path = tmp_path / "payload.json"
    list_path.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")

    sources = dict(_sources())
    sources["readyz"] = cli._load_json_location(
        "readyz", str(list_path), required=True, timeout_seconds=1.0
    )

    report = cli.build_readback_report(
        sources,
        identity=cli.Identity(
            hypothesis_id=cli.DEFAULT_HPAIRS_HYPOTHESIS_ID,
            candidate_id=cli.DEFAULT_HPAIRS_CANDIDATE_ID,
            runtime_strategy_name=cli.DEFAULT_HPAIRS_RUNTIME_STRATEGY,
            account_label=cli.DEFAULT_ACCOUNT_LABEL,
        ),
    )

    assert report["blocker_stage"] == "rollout_drift"
    assert "readyz_missing_or_unreadable" in report["blockers"]
    assert "readyz_read_error:json_payload_not_object" in report["blockers"]


def test_parser_helpers_accept_live_payload_shapes() -> None:
    assert cli._text(1) == "1"
    assert cli._text(True) == "True"
    assert cli._text_list({"a": True, "b": False}) == ["a"]
    assert cli._bool_or_none("enabled") is True
    assert cli._bool_or_none("disabled") is False
    assert cli._bool_or_none(1) is True
    assert cli._int_or_none(True) is None
    assert cli._int_or_none("bad") is None
    assert cli._decimal(True) is None
    assert cli._decimal(12) == cli.Decimal("12")
    assert cli._decimal(12.5) == cli.Decimal("12.5")
    assert cli._decimal("not-decimal") is None
    assert cli._truthy_route_flag({"unrelated": "value"}) is None
    assert cli._has_positive_key({"source_ref_count": "2"}, cli.SOURCE_REF_KEYS) is True
    assert (
        cli._has_positive_key({"source_ref_count": "0"}, cli.SOURCE_REF_KEYS) is False
    )
    assert cli._daily_net_pnls(
        [{"daily_net_pnl": ["1.25", "bad", {"net_pnl_after_costs": "2.5"}]}]
    ) == [
        cli.Decimal("1.25"),
        cli.Decimal("2.5"),
    ]


class _FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")


def test_cli_uses_only_get_readback_requests(
    monkeypatch: Any, tmp_path: Path, capsys: Any
) -> None:
    proof_path = _write_json(tmp_path / "proof.json", _proof_packet())
    source_path = _write_json(tmp_path / "source.json", _source_census())
    summary_path = _write_json(tmp_path / "summary.json", _runtime_summary())
    requests: list[Request] = []
    payload_by_path = {
        "/readyz": _readyz(),
        "/trading/status": _status(),
        "/trading/proofs?kind=runtime_window&window=next&limit=20": _target_plan(),
        "/trading/proofs?kind=runtime_window&window=latest_closed&full_audit=true&limit=20": _paper_route_evidence(),
    }

    def fake_urlopen(request: Request, timeout: float) -> _FakeResponse:
        del timeout
        requests.append(request)
        assert request.get_method() == "GET"
        path = request.full_url.removeprefix("http://torghut.example")
        return _FakeResponse(payload_by_path[path])

    monkeypatch.setattr(cli.urllib.request, "urlopen", fake_urlopen)

    exit_code = cli.main(
        [
            "--service-base-url",
            "http://torghut.example",
            "--proof-packet-json",
            proof_path,
            "--source-proof-census-json",
            source_path,
            "--runtime-ledger-daily-summary-json",
            summary_path,
        ]
    )

    assert exit_code == 0
    report = json.loads(capsys.readouterr().out)
    assert report["blocker_stage"] == "no_authority_blocker_detected"
    assert report["mutation_requests_performed"] is False
    assert [request.get_method() for request in requests] == [
        "GET",
        "GET",
        "GET",
        "GET",
    ]
    assert [request.full_url for request in requests] == [
        "http://torghut.example/readyz",
        "http://torghut.example/trading/status",
        "http://torghut.example/trading/proofs?kind=runtime_window&window=next&limit=20",
        "http://torghut.example/trading/proofs?kind=runtime_window&window=latest_closed&full_audit=true&limit=20",
    ]


def test_guard_rejects_mutation_like_endpoint(tmp_path: Path) -> None:
    args = cli.parse_args(
        [
            "--readyz",
            str(tmp_path / "readyz.json"),
            "--trading-status",
            str(tmp_path / "status.json"),
            "--paper-route-target-plan",
            "http://torghut.example/trading/promote",
            "--paper-route-evidence",
            str(tmp_path / "evidence.json"),
        ]
    )

    sources = cli.load_sources(args)

    assert sources["paper_route_target_plan"].present is False
    assert "refusing non-readback endpoint" in (
        sources["paper_route_target_plan"].read_error or ""
    )
