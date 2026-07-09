from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.models import (
    Base,
    Execution,
    ExecutionOrderEvent,
    ExecutionTCAMetric,
    PositionSnapshot,
    Strategy,
    StrategyRuntimeLedgerBucket,
    TradeDecision,
)
from app.trading.proofs.service import build_proofs_payload


def _session() -> Session:
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine, expire_on_commit=False, future=True)()


def _target(window_start: datetime, window_end: datetime) -> dict[str, object]:
    return {
        "hypothesis_id": "H-PAIRS-01",
        "candidate_id": "candidate-1",
        "strategy_family": "pairs",
        "strategy_name": "pairs-v1",
        "runtime_strategy_name": "pairs-v1",
        "account_label": "TORGHUT_SIM",
        "source_account_label": "TORGHUT_SIM",
        "source_kind": "runtime_window",
        "source_plan_ref": "proof-plan:candidate-1",
        "target_notional": "1000000",
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "paper_route_probe_symbols": ["AAPL", "AMZN"],
        "paper_route_probe_symbol_actions": {"AAPL": "buy", "AMZN": "sell"},
    }


def _gate(
    target: dict[str, object],
    blockers: list[str] | None = None,
    accepted_lag_seconds: object = 420.5,
) -> dict[str, object]:
    return {
        "allowed": False,
        "reason": "accepted_ta_signal_stale",
        "blocked_reasons": blockers or [],
        "schema_version": "torghut.live-submission-gate.v1",
        "reason_codes": ["accepted_ta_signal_stale"],
        "accepted_lag_seconds": accepted_lag_seconds,
        "accepted_max_lag_seconds": 300,
        "accepted_source_state": "stale",
        "capital_stage": "shadow",
        "configured_live_promotion": False,
        "execution_route": "paper",
        "regular_session_open": True,
        "clickhouse_ta_freshness": {
            "accepted_sources": ["ta"],
            "latest_accepted_event_at": "2026-06-08T13:29:00+00:00",
            "accepted_lag_seconds": accepted_lag_seconds,
            "accepted_source_state": "stale",
            "blocking_reason": "accepted_ta_signal_stale",
        },
        "runtime_ledger_paper_probation_import_plan": {
            "target_count": 1,
            "targets": [target],
        },
        "runtime_ledger_repair_candidates": [{"candidate_id": "audit-only"}],
        "segment_summary": {"proof_diagnostics": "audit-only"},
    }


def _tigerbeetle_status(
    *,
    ok: bool = True,
    reconciliation_ok: bool = True,
    reconciliation_stale: bool = False,
    blockers: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.tigerbeetle-ledger-status.v1",
        "ok": ok,
        "protocol_ok": True,
        "protocol_probe_skipped": False,
        "reconciliation_required": True,
        "reconciliation_ok": reconciliation_ok,
        "reconciliation_stale": reconciliation_stale,
        "reconciliation_age_seconds": 30,
        "reconciliation_max_age_seconds": 300,
        "cluster_id": 100,
        "claimed_by_runtime_evidence": True,
        "runtime_ledger_ref_count": 2,
        "runtime_ledger_signed_ref_count": 2,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "latest_reconciliation": {
            "id": "recon-1",
            "cluster_id": 100,
            "status": "ok" if reconciliation_ok else "blocked",
            "ok": reconciliation_ok,
            "started_at": "2026-06-08T20:05:00+00:00",
            "finished_at": "2026-06-08T20:05:02+00:00",
            "age_seconds": 30,
            "reconciliation_stale": reconciliation_stale,
            "checked_transfer_count": 12,
            "runtime_ledger_ref_count": 2,
            "runtime_ledger_signed_ref_count": 2,
            "runtime_ledger_missing_signed_ref_count": 0,
            "runtime_ledger_missing_account_ref_count": 0,
            "blockers": blockers or [],
        },
        "blockers": blockers or [],
    }


def _build(
    session: Session,
    *,
    generated_at: datetime,
    target: dict[str, object] | None = None,
    blockers: list[str] | None = None,
    accepted_lag_seconds: object = 420.5,
    tigerbeetle_ledger_status: dict[str, object] | None = None,
    full_audit: bool = True,
) -> dict[str, object]:
    return build_proofs_payload(
        session,
        live_submission_gate=(
            _gate(target, blockers, accepted_lag_seconds) if target else {}
        ),
        route_reacquisition_book={},
        tigerbeetle_ledger_status=tigerbeetle_ledger_status,
        generated_at=generated_at,
        window="auto",
        full_audit=full_audit,
    )


def test_build_proofs_payload_reports_no_target() -> None:
    with _session() as session:
        payload = _build(
            session, generated_at=datetime(2026, 6, 8, tzinfo=timezone.utc)
        )

    assert payload["schema_version"] == "torghut.proofs.v1"
    assert payload["proofs"] == []
    assert payload["summary"]["target_count"] == 0
    assert payload["promotion_authority"]["allowed"] is False
    assert payload["tigerbeetle_reconciliation"]["status_available"] is False
    assert (
        "tigerbeetle_ledger_status_missing"
        in payload["promotion_authority"]["blockers"]
    )


def test_build_proofs_payload_exposes_live_submission_gate_and_freshness_summary() -> (
    None
):
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    with _session() as session:
        payload = _build(
            session,
            target=target,
            generated_at=window_start - timedelta(minutes=1),
            tigerbeetle_ledger_status=_tigerbeetle_status(),
        )

    assert payload["live_submission_gate"]["allowed"] is False
    assert payload["live_submission_gate"]["reason"] == "accepted_ta_signal_stale"
    assert payload["summary"]["live_submission_allowed"] is False
    assert payload["summary"]["live_submission_reason"] == "accepted_ta_signal_stale"
    assert payload["summary"]["accepted_source_state"] == "stale"
    assert payload["summary"]["accepted_lag_seconds"] == 420.5
    assert payload["summary"]["tigerbeetle_reconciliation_ok"] is True
    assert payload["summary"]["tigerbeetle_reconciliation_stale"] is False
    assert payload["summary"]["tigerbeetle_reconciliation_age_seconds"] == 30
    assert payload["summary"]["tigerbeetle_reconciliation_required"] is True
    assert payload["tigerbeetle_reconciliation"]["latest_reconciliation"] == {
        "id": "recon-1",
        "cluster_id": 100,
        "status": "ok",
        "ok": True,
        "started_at": "2026-06-08T20:05:00+00:00",
        "finished_at": "2026-06-08T20:05:02+00:00",
        "age_seconds": 30,
        "reconciliation_stale": False,
        "checked_transfer_count": 12,
        "runtime_ledger_ref_count": 2,
        "runtime_ledger_signed_ref_count": 2,
        "runtime_ledger_missing_signed_ref_count": 0,
        "runtime_ledger_missing_account_ref_count": 0,
        "blockers": [],
    }
    assert payload["promotion_authority"] == {
        "allowed": False,
        "final_promotion_allowed": False,
        "reason": "proof_collection_only",
        "blockers": ["live_runtime_ledger_authority_required"],
    }


def test_build_proofs_payload_defaults_to_slim_machine_contract() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    with _session() as session:
        payload = _build(
            session,
            target=target,
            generated_at=window_start - timedelta(minutes=1),
            full_audit=False,
        )

    assert set(payload["live_submission_gate"]) == {
        "allowed",
        "reason",
        "blocked_reasons",
        "clickhouse_ta_freshness",
    }
    assert "accepted_source_state" not in payload["live_submission_gate"]
    assert "capital_stage" not in payload["live_submission_gate"]
    assert "configured_live_promotion" not in payload["live_submission_gate"]
    assert "execution_route" not in payload["live_submission_gate"]
    assert "reason_codes" not in payload["live_submission_gate"]
    assert "regular_session_open" not in payload["live_submission_gate"]
    assert "runtime_ledger_repair_candidates" not in payload["live_submission_gate"]
    assert "segment_summary" not in payload["live_submission_gate"]
    assert payload["live_submission_gate"]["clickhouse_ta_freshness"] == {
        "accepted_sources": ["ta"],
        "latest_accepted_event_at": "2026-06-08T13:29:00+00:00",
        "accepted_lag_seconds": 420.5,
        "accepted_source_state": "stale",
        "blocking_reason": "accepted_ta_signal_stale",
    }
    proof = payload["proofs"][0]
    assert set(proof) == {
        "proof_id",
        "identity",
        "window",
        "symbols",
        "account_state",
        "state",
        "blockers",
        "next_action",
    }
    assert proof["state"] == "waiting_for_session"
    assert "runtime_ledger" not in proof
    assert "source_counts" not in proof
    assert "health" not in proof
    assert proof["account_state"]["clean_baseline"] is None
    assert proof["account_state"]["blockers"] == ["clean_baseline_snapshot_missing"]


def test_build_proofs_payload_full_audit_keeps_diagnostics() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    with _session() as session:
        payload = _build(
            session,
            target=target,
            generated_at=window_start - timedelta(minutes=1),
            full_audit=True,
        )

    assert "runtime_ledger_repair_candidates" in payload["live_submission_gate"]
    assert "segment_summary" in payload["live_submission_gate"]
    proof = payload["proofs"][0]
    assert "runtime_ledger" in proof
    assert "account_state" in proof
    assert "source_counts" in proof
    assert "health" in proof


def test_build_proofs_payload_blocks_promotion_authority_on_stale_reconciliation() -> (
    None
):
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    with _session() as session:
        payload = _build(
            session,
            target=target,
            generated_at=window_start - timedelta(minutes=1),
            tigerbeetle_ledger_status=_tigerbeetle_status(
                ok=False,
                reconciliation_ok=False,
                reconciliation_stale=True,
                blockers=["tigerbeetle_reconciliation_stale"],
            ),
        )

    assert payload["summary"]["tigerbeetle_reconciliation_ok"] is False
    assert payload["summary"]["tigerbeetle_reconciliation_stale"] is True
    assert (
        "tigerbeetle_reconciliation_stale" in payload["promotion_authority"]["blockers"]
    )


def test_build_proofs_payload_blocks_promotion_authority_on_unavailable_reconciliation() -> (
    None
):
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    status = _tigerbeetle_status()
    status["read_model_unavailable"] = True
    status["blockers"] = "tigerbeetle_read_model_unavailable"

    with _session() as session:
        payload = _build(
            session,
            generated_at=window_start - timedelta(minutes=1),
            tigerbeetle_ledger_status=status,
        )

    assert payload["tigerbeetle_reconciliation"]["status_available"] is False
    assert payload["tigerbeetle_reconciliation"]["blockers"] == [
        "tigerbeetle_read_model_unavailable",
        "tigerbeetle_ledger_status_unavailable",
    ]
    assert (
        "tigerbeetle_read_model_unavailable"
        in payload["promotion_authority"]["blockers"]
    )
    assert (
        "tigerbeetle_ledger_status_unavailable"
        in payload["promotion_authority"]["blockers"]
    )


def test_build_proofs_payload_adds_default_tigerbeetle_blocker_when_status_not_ok() -> (
    None
):
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    status = _tigerbeetle_status(ok=False)
    status["blockers"] = 123

    with _session() as session:
        payload = _build(
            session,
            generated_at=window_start - timedelta(minutes=1),
            tigerbeetle_ledger_status=status,
        )

    assert payload["tigerbeetle_reconciliation"]["blockers"] == [
        "tigerbeetle_ledger_not_ok"
    ]
    assert "tigerbeetle_ledger_not_ok" in payload["promotion_authority"]["blockers"]


def test_build_proofs_payload_normalizes_tigerbeetle_numeric_fields() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    status = _tigerbeetle_status()
    status["reconciliation_age_seconds"] = Decimal("42")
    status["reconciliation_max_age_seconds"] = 300.0
    status["cluster_id"] = "100"
    status["runtime_ledger_ref_count"] = "2"
    status["runtime_ledger_signed_ref_count"] = 3.0
    status["runtime_ledger_missing_signed_ref_count"] = "not-an-int"
    status["runtime_ledger_missing_account_ref_count"] = Decimal("1")

    with _session() as session:
        payload = _build(
            session,
            generated_at=window_start - timedelta(minutes=1),
            tigerbeetle_ledger_status=status,
        )

    assert payload["tigerbeetle_reconciliation"]["reconciliation_age_seconds"] == 42
    assert (
        payload["tigerbeetle_reconciliation"]["reconciliation_max_age_seconds"] == 300
    )
    assert payload["tigerbeetle_reconciliation"]["cluster_id"] == 100
    assert payload["tigerbeetle_reconciliation"]["runtime_ledger_ref_count"] == 2
    assert payload["tigerbeetle_reconciliation"]["runtime_ledger_signed_ref_count"] == 3
    assert (
        payload["tigerbeetle_reconciliation"]["runtime_ledger_missing_signed_ref_count"]
        == 0
    )
    assert (
        payload["tigerbeetle_reconciliation"][
            "runtime_ledger_missing_account_ref_count"
        ]
        == 1
    )


def test_build_proofs_payload_normalizes_invalid_accepted_lag_summary() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    cases: list[tuple[object, float | None]] = [
        ("421.75", 421.75),
        (True, None),
        ({"lag": 421}, None),
        ("not-a-number", None),
    ]

    for raw_lag, expected_lag in cases:
        with _session() as session:
            payload = _build(
                session,
                target=target,
                generated_at=window_start - timedelta(minutes=1),
                accepted_lag_seconds=raw_lag,
            )

        assert payload["summary"]["accepted_lag_seconds"] == expected_lag


def test_build_proofs_payload_fills_missing_symbols_from_strategy_universe() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    target.pop("paper_route_probe_symbols")
    target.pop("paper_route_probe_symbol_actions")

    with _session() as session:
        session.add(
            Strategy(
                name="pairs-v1",
                description="proof fixture",
                enabled=True,
                base_timeframe="1Min",
                universe_type="static",
                universe_symbols=[" amzn ", "", "AAPL", "AMZN"],
            )
        )
        session.commit()
        payload = _build(
            session,
            target=target,
            generated_at=window_start - timedelta(minutes=1),
        )

    assert payload["proofs"][0]["symbols"] == ["AAPL", "AMZN"]


def test_build_proofs_payload_waiting_and_collecting_states() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    with _session() as session:
        waiting = _build(
            session,
            target=target,
            generated_at=window_start - timedelta(minutes=1),
        )
        collecting = _build(
            session,
            target=target,
            generated_at=window_start + timedelta(minutes=1),
        )

    assert waiting["proofs"][0]["state"] == "waiting_for_session"
    assert waiting["proofs"][0]["next_action"] == "wait_for_session_open"
    assert collecting["proofs"][0]["state"] == "collecting"
    assert collecting["proofs"][0]["next_action"] == "collect_source_activity"


def test_build_proofs_payload_blocks_missing_source_activity() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    with _session() as session:
        _add_clean_snapshots(session, window_start, window_end)
        payload = _build(
            session,
            target=_target(window_start, window_end),
            generated_at=window_end + timedelta(hours=2),
        )

    proof = payload["proofs"][0]
    assert proof["state"] == "blocked"
    assert "source_decisions_missing" in proof["blockers"]
    assert "executions_missing" in proof["blockers"]
    assert "execution_tca_missing" in proof["blockers"]


def test_build_proofs_payload_marks_import_due_without_runtime_ledger() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    with _session() as session:
        _add_clean_snapshots(session, window_start, window_end)
        _add_source_activity(session, window_start)
        payload = _build(
            session,
            target=_target(window_start, window_end),
            generated_at=window_end + timedelta(hours=2),
        )

    proof = payload["proofs"][0]
    assert proof["state"] == "import_due"
    assert "runtime_ledger_materialization_missing" in proof["blockers"]


def test_build_proofs_payload_marks_proof_ready_with_closed_flat_ledger() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    with _session() as session:
        _add_clean_snapshots(session, window_start, window_end)
        _add_source_activity(session, window_start)
        _add_runtime_ledger(session, window_start, window_end)
        payload = _build(
            session,
            target=_target(window_start, window_end),
            generated_at=window_end + timedelta(hours=2),
        )

    proof = payload["proofs"][0]
    assert proof["state"] == "proof_ready"
    assert "target" not in proof
    assert proof["post_cost_pnl_basis"] == "realized_strategy_pnl_after_explicit_costs"
    assert proof["post_cost_pnl_value"] == "60"
    assert proof["runtime_ledger"]["bucket_count"] == 1


def test_build_proofs_payload_blocks_dirty_or_non_flat_account() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    with _session() as session:
        _add_clean_snapshots(
            session,
            window_start,
            window_end,
            pre_positions=[{"symbol": "AAPL", "qty": "1"}],
        )
        _add_source_activity(session, window_start)
        payload = _build(
            session,
            target=_target(window_start, window_end),
            generated_at=window_end + timedelta(hours=2),
        )

    assert payload["proofs"][0]["state"] == "blocked"
    assert "account_dirty_before_window" in payload["proofs"][0]["blockers"]

    with _session() as session:
        _add_clean_snapshots(
            session,
            window_start,
            window_end,
            close_positions=[{"symbol": "AMZN", "qty": "1"}],
        )
        _add_source_activity(session, window_start)
        payload = _build(
            session,
            target=_target(window_start, window_end),
            generated_at=window_end + timedelta(hours=2),
        )

    assert payload["proofs"][0]["state"] == "blocked"
    assert "account_not_flat_after_window" in payload["proofs"][0]["blockers"]


def test_build_proofs_payload_blocks_dependency_continuity_and_drift() -> None:
    window_start = datetime(2026, 6, 8, 13, 30, tzinfo=timezone.utc)
    window_end = datetime(2026, 6, 8, 20, 0, tzinfo=timezone.utc)
    target = _target(window_start, window_end)
    with _session() as session:
        _add_clean_snapshots(session, window_start, window_end)
        _add_source_activity(session, window_start)
        payload = _build(
            session,
            target=target,
            blockers=[
                "dependency_quorum_not_allow",
                "continuity_not_ok",
                "drift_blocker",
            ],
            generated_at=window_end + timedelta(hours=2),
        )

    blockers = payload["proofs"][0]["blockers"]
    assert "dependency_quorum_blocked" in blockers
    assert "continuity_failure" in blockers
    assert "drift_blocker" in blockers


def _add_clean_snapshots(
    session: Session,
    window_start: datetime,
    window_end: datetime,
    *,
    pre_positions: list[dict[str, str]] | None = None,
    close_positions: list[dict[str, str]] | None = None,
) -> None:
    session.add_all(
        [
            PositionSnapshot(
                alpaca_account_label="TORGHUT_SIM",
                as_of=window_start - timedelta(minutes=5),
                equity=Decimal("100000"),
                cash=Decimal("100000"),
                buying_power=Decimal("100000"),
                positions=pre_positions or [],
            ),
            PositionSnapshot(
                alpaca_account_label="TORGHUT_SIM",
                as_of=window_end + timedelta(minutes=5),
                equity=Decimal("100060"),
                cash=Decimal("100060"),
                buying_power=Decimal("100060"),
                positions=close_positions or [],
            ),
        ]
    )
    session.commit()


def _add_source_activity(session: Session, window_start: datetime) -> None:
    strategy = Strategy(
        name="pairs-v1",
        description="proof fixture",
        enabled=True,
        base_timeframe="1Min",
        universe_type="static",
        universe_symbols=["AAPL", "AMZN"],
    )
    session.add(strategy)
    session.flush()
    decision = TradeDecision(
        strategy_id=strategy.id,
        alpaca_account_label="TORGHUT_SIM",
        symbol="AAPL",
        timeframe="1Min",
        decision_json={"action": "buy"},
        status="submitted",
        created_at=window_start + timedelta(minutes=1),
    )
    session.add(decision)
    session.flush()
    execution = Execution(
        trade_decision_id=decision.id,
        alpaca_account_label="TORGHUT_SIM",
        alpaca_order_id="order-1",
        client_order_id="client-1",
        symbol="AAPL",
        side="buy",
        order_type="market",
        time_in_force="day",
        submitted_qty=Decimal("1"),
        filled_qty=Decimal("1"),
        avg_fill_price=Decimal("100"),
        status="filled",
        created_at=window_start + timedelta(minutes=2),
        updated_at=window_start + timedelta(minutes=2),
    )
    session.add(execution)
    session.flush()
    session.add(
        ExecutionOrderEvent(
            event_fingerprint="event-1",
            source_topic="orders",
            alpaca_account_label="TORGHUT_SIM",
            event_ts=window_start + timedelta(minutes=3),
            symbol="AAPL",
            alpaca_order_id="order-1",
            client_order_id="client-1",
            event_type="fill",
            status="filled",
            raw_event={},
            execution_id=execution.id,
            trade_decision_id=decision.id,
        )
    )
    session.add(
        ExecutionTCAMetric(
            execution_id=execution.id,
            trade_decision_id=decision.id,
            strategy_id=strategy.id,
            alpaca_account_label="TORGHUT_SIM",
            symbol="AAPL",
            side="buy",
            arrival_price=Decimal("100"),
            avg_fill_price=Decimal("100"),
            filled_qty=Decimal("1"),
            signed_qty=Decimal("1"),
            computed_at=window_start + timedelta(minutes=4),
        )
    )
    session.commit()


def _add_runtime_ledger(
    session: Session,
    window_start: datetime,
    window_end: datetime,
) -> None:
    session.add(
        StrategyRuntimeLedgerBucket(
            run_id="proof-run-1",
            candidate_id="candidate-1",
            hypothesis_id="H-PAIRS-01",
            observed_stage="paper",
            bucket_started_at=window_start,
            bucket_ended_at=window_end,
            account_label="TORGHUT_SIM",
            runtime_strategy_name="pairs-v1",
            strategy_family="pairs",
            fill_count=1,
            decision_count=1,
            submitted_order_count=1,
            cancelled_order_count=0,
            rejected_order_count=0,
            unfilled_order_count=0,
            closed_trade_count=1,
            open_position_count=0,
            filled_notional=Decimal("100"),
            gross_strategy_pnl=Decimal("75"),
            cost_amount=Decimal("15"),
            net_strategy_pnl_after_costs=Decimal("60"),
            ledger_schema_version="torghut.runtime-ledger-bucket.v1",
            pnl_basis="realized_strategy_pnl_after_explicit_costs",
        )
    )
    session.commit()
