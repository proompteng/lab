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


def test_rollout_drift_is_first_blocker() -> None:
    report = _report(status=_status(revision="rev-b"))

    assert report["blocker_stage"] == "rollout_drift"
    assert report["rollout"]["drift_detected"] is True
    assert "rollout_revision_drift" in report["blockers"]


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
        "/trading/paper-route-target-plan": _target_plan(),
        "/trading/paper-route-evidence": _paper_route_evidence(),
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
        "http://torghut.example/trading/paper-route-target-plan",
        "http://torghut.example/trading/paper-route-evidence",
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
