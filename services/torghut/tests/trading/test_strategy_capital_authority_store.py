from __future__ import annotations

import uuid
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import Base, EvidenceEpochRecord, Strategy, TradeDecision
from app.trading.strategy_capital_authority import (
    AuthorityProofBindings,
    CapitalAccountMode,
    CapitalSessionWindow,
    CapitalStage,
    CapitalVenue,
    StrategyCapitalAuthority,
    StrategyCapitalVerdict,
    canonical_payload_digest,
)
from app.trading.strategy_capital_authority_store import (
    StrategyCapitalUsageQuery,
    activate_strategy_capital_authority,
    count_strategy_authority_usage,
    load_active_strategy_capital_authority,
    strategy_capital_authority_status,
)
from app.trading.strategy_capital_runtime import (
    RuntimeStrategyCapitalRequest,
    evaluate_runtime_strategy_capital_authority,
    hold_runtime_strategy_capital_authority_for_submission,
)


def _strategy(name: str, *, enabled: bool = True) -> Strategy:
    return Strategy(
        name=name,
        enabled=enabled,
        base_timeframe="1Min",
        universe_type="static",
        universe_symbols=["NVDA"],
    )


def _safe_authority(
    strategy_ref: str,
    stage: CapitalStage,
) -> StrategyCapitalAuthority:
    return StrategyCapitalAuthority(
        authority_id=f"catalog-{strategy_ref}-safe-v1",
        strategy_ref=strategy_ref,
        stage=stage,
        blockers=("p0_capital_freeze",),
    )


def _broker_authority(
    strategy_ref: str,
    *,
    evidence_digest: str,
) -> StrategyCapitalAuthority:
    digest = "sha256:" + "a" * 64
    return StrategyCapitalAuthority(
        authority_id=f"catalog-{strategy_ref}-paper-v1",
        strategy_ref=strategy_ref,
        candidate_ref=strategy_ref,
        evidence_epoch_id=f"tee-{strategy_ref}",
        stage=CapitalStage.PAPER_PROBATION,
        account_label="paper",
        account_mode=CapitalAccountMode.PAPER,
        venue=CapitalVenue.ALPACA,
        allowed_symbols=("NVDA",),
        max_order_notional=Decimal("1000"),
        max_gross_notional=Decimal("5000"),
        max_net_notional=Decimal("5000"),
        max_loss=Decimal("100"),
        max_orders_per_minute=2,
        max_orders_per_session=10,
        session=CapitalSessionWindow(
            timezone_name="UTC",
            weekdays=(0, 1, 2, 3, 4, 5, 6),
            start=time(0, 0),
            end=time(23, 59, 59),
        ),
        issued_at=datetime(2026, 7, 13, 13, 0, tzinfo=timezone.utc),
        expires_at=datetime(2026, 7, 13, 20, 0, tzinfo=timezone.utc),
        proofs=AuthorityProofBindings(
            policy_digest=digest,
            evidence_digest=evidence_digest,
            code_commit="a" * 40,
            image_digest=digest,
            data_digest=digest,
            execution_digest=digest,
        ),
        issued_by="research-owner",
        approved_by="risk-owner",
        reduce_only=False,
    )


def test_activation_is_idempotent_but_authority_identity_is_immutable() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        strategy = _strategy("alpha-v1")
        session.add(strategy)
        session.flush()
        authority = _safe_authority("alpha-v1", CapitalStage.SHADOW_ALLOWED)
        first = activate_strategy_capital_authority(
            session,
            strategy=strategy,
            authority=authority,
        )
        second = activate_strategy_capital_authority(
            session,
            strategy=strategy,
            authority=authority,
        )
        assert first.id == second.id
        assert strategy.active_capital_authority_id == first.id

        changed = authority.model_copy(update={"blockers": ("different_reason",)})
        with pytest.raises(ValueError, match="different immutable content"):
            activate_strategy_capital_authority(
                session,
                strategy=strategy,
                authority=changed,
            )


def test_status_reports_exact_distinct_enabled_stages_without_live_grant() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        shadow = _strategy("shadow-v1")
        research = _strategy("research-v1")
        session.add_all((shadow, research))
        session.flush()
        activate_strategy_capital_authority(
            session,
            strategy=shadow,
            authority=_safe_authority("shadow-v1", CapitalStage.SHADOW_ALLOWED),
        )
        activate_strategy_capital_authority(
            session,
            strategy=research,
            authority=_safe_authority("research-v1", CapitalStage.RESEARCH_ONLY),
        )
        session.commit()

        payload = strategy_capital_authority_status(
            session,
            observed_at=datetime(2026, 7, 13, 14, 0, tzinfo=timezone.utc),
        )

    assert payload["strategy_count"] == 2
    assert payload["enabled_strategy_count"] == 2
    assert payload["active_broker_grant_count"] == 0
    assert payload["stage_counts"] == {
        "research_only": 1,
        "shadow_allowed": 1,
    }
    items = {item["strategy_ref"]: item for item in payload["strategies"]}
    assert items["shadow-v1"]["stage"] == "shadow_allowed"
    assert items["research-v1"]["stage"] == "research_only"
    assert all(item["contract_valid"] for item in items.values())
    assert not any(item["broker_risk_increase_grant_active"] for item in items.values())


def test_status_requires_current_evidence_and_runtime_artifact_bindings() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    observed_at = datetime(2026, 7, 13, 14, 0, tzinfo=timezone.utc)
    evidence_payload = {
        "schema_version": "torghut.evidence-epoch.v1",
        "evidence_epoch_id": "tee-broker-v1",
        "account_label": "paper",
        "stage_scope": "paper",
        "created_at": datetime(2026, 7, 13, 13, 0, tzinfo=timezone.utc).isoformat(),
        "fresh_until": datetime(2026, 7, 13, 16, 0, tzinfo=timezone.utc).isoformat(),
        "decision": "paper_allowed",
        "reason_codes": [],
        "receipt_ids": [],
        "receipts": [],
    }
    with Session(engine) as session:
        strategy = _strategy("broker-v1")
        session.add(strategy)
        session.add(
            EvidenceEpochRecord(
                evidence_epoch_id="tee-broker-v1",
                account_label="paper",
                stage_scope="paper",
                decision="paper_allowed",
                fresh_until=datetime(2026, 7, 13, 16, 0, tzinfo=timezone.utc),
                reason_codes_json=[],
                receipt_ids_json=[],
                payload_json=evidence_payload,
            )
        )
        session.flush()
        authority = _broker_authority(
            "broker-v1",
            evidence_digest=canonical_payload_digest(evidence_payload),
        )
        activate_strategy_capital_authority(
            session,
            strategy=strategy,
            authority=authority,
        )
        session.commit()

        matching = strategy_capital_authority_status(
            session,
            observed_at=observed_at,
            runtime_code_commit="a" * 40,
            runtime_image_digest="sha256:" + "a" * 64,
        )
        stale_image = strategy_capital_authority_status(
            session,
            observed_at=observed_at,
            runtime_code_commit="a" * 40,
            runtime_image_digest="sha256:" + "b" * 64,
        )
        strategy.enabled = False
        session.commit()
        disabled = strategy_capital_authority_status(
            session,
            observed_at=observed_at,
            runtime_code_commit="a" * 40,
            runtime_image_digest="sha256:" + "a" * 64,
        )
        evidence_record = session.execute(
            select(EvidenceEpochRecord).where(
                EvidenceEpochRecord.evidence_epoch_id == "tee-broker-v1"
            )
        ).scalar_one()
        evidence_record.payload_json = {**evidence_payload, "receipts": ["tampered"]}
        session.commit()
        tampered_evidence = strategy_capital_authority_status(
            session,
            observed_at=observed_at,
            runtime_code_commit="a" * 40,
            runtime_image_digest="sha256:" + "a" * 64,
        )

    assert matching["active_broker_grant_count"] == 1
    assert matching["strategies"][0]["evidence_epoch_current"] is True
    assert matching["strategies"][0]["runtime_artifact_match"] is True
    assert stale_image["active_broker_grant_count"] == 0
    assert (
        "authority_runtime_image_digest_mismatch"
        in stale_image["strategies"][0]["reason_codes"]
    )
    assert disabled["active_broker_grant_count"] == 0
    assert "strategy_disabled" in disabled["strategies"][0]["reason_codes"]
    assert tampered_evidence["active_broker_grant_count"] == 0
    assert (
        "authority_evidence_digest_mismatch"
        in tampered_evidence["strategies"][0]["reason_codes"]
    )


def test_usage_counts_allowed_broker_attempts_including_rejections() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    observed_at = datetime.now(timezone.utc)
    with Session(engine) as session:
        strategy = _strategy("rate-bounded-v1")
        session.add(strategy)
        session.flush()
        current_decision_id = uuid.uuid4()
        rows = (
            (
                uuid.uuid4(),
                "paper",
                True,
                "rejected",
                observed_at - timedelta(seconds=30),
            ),
            (uuid.uuid4(), "paper", True, "rejected", observed_at),
            (current_decision_id, "paper", True, "planned", observed_at),
            (
                uuid.uuid4(),
                "paper",
                False,
                "blocked",
                observed_at - timedelta(seconds=20),
            ),
            (
                uuid.uuid4(),
                "other",
                True,
                "rejected",
                observed_at - timedelta(seconds=10),
            ),
            (
                uuid.uuid4(),
                "paper",
                True,
                "submitted",
                observed_at - timedelta(hours=2),
            ),
        )
        for index, (row_id, account, allowed, status, evaluated_at) in enumerate(rows):
            session.add(
                TradeDecision(
                    id=row_id,
                    strategy_id=strategy.id,
                    alpaca_account_label=account,
                    symbol="NVDA",
                    timeframe="1Min",
                    decision_json={
                        "params": {"strategy_capital_authority": {"allowed": allowed}}
                    },
                    decision_hash=f"{index:064x}",
                    status=status,
                    created_at=observed_at - timedelta(days=1),
                    strategy_capital_authority_id="rate-authority-v1",
                    strategy_capital_authority_digest="sha256:" + "a" * 64,
                    strategy_capital_authority_evaluated_at=evaluated_at,
                    strategy_capital_authority_allowed=allowed,
                )
            )
        session.commit()

        usage = count_strategy_authority_usage(
            session,
            query=StrategyCapitalUsageQuery(
                strategy_id=strategy.id,
                decision_id=current_decision_id,
                account_label="paper",
                observed_at=observed_at,
                session_started_at=observed_at - timedelta(hours=1),
            ),
        )

    assert usage == (2, 2)


def test_invalid_active_authority_denial_persists_paired_record_identity() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    observed_at = datetime.now(timezone.utc)
    with Session(engine) as session:
        strategy = _strategy("invalid-record-v1")
        session.add(strategy)
        session.flush()
        record = activate_strategy_capital_authority(
            session,
            strategy=strategy,
            authority=_safe_authority(
                "invalid-record-v1",
                CapitalStage.SHADOW_ALLOWED,
            ),
        )
        session.commit()

        record.payload_json = {"schema_version": "invalid"}
        session.commit()
        verdict = evaluate_runtime_strategy_capital_authority(
            session,
            strategy=strategy,
            request=RuntimeStrategyCapitalRequest(
                decision_id=uuid.uuid4(),
                account_label="paper",
                account_mode="paper",
                adapter_name="alpaca",
                symbol="NVDA",
                side="buy",
                order_notional=Decimal("100"),
                positions=[],
                capital_loss=Decimal("0"),
                observed_at=observed_at,
            ),
        )

        assert verdict.allowed is False
        assert verdict.contract_valid is False
        assert verdict.authority_id == record.authority_id
        assert verdict.authority_digest == record.authority_digest
        assert verdict.reason_codes

        decision = TradeDecision(
            strategy_id=strategy.id,
            alpaca_account_label="paper",
            symbol="NVDA",
            timeframe="1Min",
            decision_json={
                "params": {"strategy_capital_authority": verdict.to_payload()}
            },
            decision_hash="f" * 64,
            status="blocked",
            strategy_capital_authority_id=verdict.authority_id,
            strategy_capital_authority_digest=verdict.authority_digest,
            strategy_capital_authority_evaluated_at=verdict.evaluated_at,
            strategy_capital_authority_allowed=verdict.allowed,
        )
        session.add(decision)
        session.commit()

        session.refresh(decision)
        assert decision.strategy_capital_authority_id == record.authority_id
        assert decision.strategy_capital_authority_digest == record.authority_digest


def test_locked_load_uses_fresh_pointer_and_detects_rotation() -> None:
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    first_session = Session(engine, expire_on_commit=False)
    second_session = Session(engine, expire_on_commit=False)
    try:
        strategy = _strategy("rotated-v1")
        first_session.add(strategy)
        first_session.flush()
        first = _safe_authority("rotated-v1", CapitalStage.SHADOW_ALLOWED)
        activate_strategy_capital_authority(
            first_session,
            strategy=strategy,
            authority=first,
        )
        first_session.commit()

        rotated_strategy = second_session.get(Strategy, strategy.id)
        assert rotated_strategy is not None
        second = StrategyCapitalAuthority(
            authority_id="catalog-rotated-v1-safe-v2",
            strategy_ref="rotated-v1",
            stage=CapitalStage.RESEARCH_ONLY,
            blockers=("p0_capital_freeze",),
        )
        activate_strategy_capital_authority(
            second_session,
            strategy=rotated_strategy,
            authority=second,
        )
        second_session.commit()

        assert (
            strategy.active_capital_authority_id
            != second_session.get(Strategy, strategy.id).active_capital_authority_id
        )
        loaded = load_active_strategy_capital_authority(
            first_session,
            strategy=strategy,
            lock_for_update=True,
        )
        assert loaded is not None
        assert loaded.authority_id == second.authority_id
        rotated_verdict = hold_runtime_strategy_capital_authority_for_submission(
            first_session,
            strategy=strategy,
            verdict=StrategyCapitalVerdict(
                allowed=True,
                contract_valid=True,
                strategy_ref=strategy.name,
                authority_id=first.authority_id,
                authority_digest=first.digest,
                stage=first.stage,
                evaluated_at=datetime.now(timezone.utc),
                reason_codes=(),
            ),
            observed_at=datetime.now(timezone.utc),
        )
        assert rotated_verdict.reason_codes == ("authority_changed_before_submission",)
    finally:
        first_session.close()
        second_session.close()


def test_final_submission_hold_rejects_authority_that_expired_after_evaluation() -> (
    None
):
    engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    evaluated_at = datetime(2026, 7, 13, 19, 59, 59, tzinfo=timezone.utc)
    evidence_payload = {
        "schema_version": "torghut.evidence-epoch.v1",
        "evidence_epoch_id": "tee-expiring-v1",
        "account_label": "paper",
        "stage_scope": "paper",
        "created_at": datetime(2026, 7, 13, 13, 0, tzinfo=timezone.utc).isoformat(),
        "fresh_until": datetime(2026, 7, 13, 21, 0, tzinfo=timezone.utc).isoformat(),
        "decision": "paper_allowed",
        "reason_codes": [],
        "receipt_ids": [],
        "receipts": [],
    }
    with Session(engine) as session:
        strategy = _strategy("expiring-v1")
        session.add(strategy)
        session.add(
            EvidenceEpochRecord(
                evidence_epoch_id="tee-expiring-v1",
                account_label="paper",
                stage_scope="paper",
                decision="paper_allowed",
                fresh_until=datetime(2026, 7, 13, 21, 0, tzinfo=timezone.utc),
                reason_codes_json=[],
                receipt_ids_json=[],
                payload_json=evidence_payload,
            )
        )
        session.flush()
        authority = _broker_authority(
            "expiring-v1",
            evidence_digest=canonical_payload_digest(evidence_payload),
        )
        activate_strategy_capital_authority(
            session,
            strategy=strategy,
            authority=authority,
        )
        session.commit()

        with (
            patch(
                "app.trading.strategy_capital_runtime.BUILD_COMMIT",
                "a" * 40,
            ),
            patch(
                "app.trading.strategy_capital_runtime.BUILD_IMAGE_DIGEST",
                "sha256:" + "a" * 64,
            ),
        ):
            verdict = evaluate_runtime_strategy_capital_authority(
                session,
                strategy=strategy,
                request=RuntimeStrategyCapitalRequest(
                    decision_id=uuid.uuid4(),
                    account_label="paper",
                    account_mode="paper",
                    adapter_name="alpaca",
                    symbol="NVDA",
                    side="buy",
                    order_notional=Decimal("100"),
                    positions=[],
                    capital_loss=Decimal("0"),
                    observed_at=evaluated_at,
                ),
            )
            held_verdict = hold_runtime_strategy_capital_authority_for_submission(
                session,
                strategy=strategy,
                verdict=verdict,
                observed_at=evaluated_at + timedelta(milliseconds=500),
            )
            with (
                patch.object(
                    settings,
                    "tigerbeetle_economic_parity_required",
                    True,
                ),
                patch(
                    "app.trading.strategy_capital_runtime.load_broker_economic_ledger_status",
                    return_value={
                        "schema_version": ("torghut.broker-economic-ledger-status.v1"),
                        "entry_dependency_satisfied": False,
                        "reason_codes": ["tigerbeetle_economic_transfer_missing"],
                    },
                ),
            ):
                parity_blocked_verdict = evaluate_runtime_strategy_capital_authority(
                    session,
                    strategy=strategy,
                    request=RuntimeStrategyCapitalRequest(
                        decision_id=uuid.uuid4(),
                        account_label="paper",
                        account_mode="paper",
                        adapter_name="alpaca",
                        symbol="NVDA",
                        side="buy",
                        order_notional=Decimal("100"),
                        positions=[],
                        capital_loss=Decimal("0"),
                        observed_at=evaluated_at,
                    ),
                )
                parity_blocked_hold = (
                    hold_runtime_strategy_capital_authority_for_submission(
                        session,
                        strategy=strategy,
                        verdict=verdict,
                        observed_at=evaluated_at + timedelta(milliseconds=750),
                    )
                )
            final_verdict = hold_runtime_strategy_capital_authority_for_submission(
                session,
                strategy=strategy,
                verdict=verdict,
                observed_at=authority.expires_at,
            )

    assert verdict.allowed is True
    assert held_verdict.allowed is True
    assert held_verdict.evaluated_at == evaluated_at + timedelta(milliseconds=500)
    assert parity_blocked_verdict.allowed is False
    assert parity_blocked_verdict.reason_codes == (
        "tigerbeetle_economic_transfer_missing",
    )
    assert parity_blocked_hold.allowed is False
    assert parity_blocked_hold.reason_codes == (
        "tigerbeetle_economic_transfer_missing",
    )
    assert final_verdict.allowed is False
    assert final_verdict.reason_codes == ("authority_expired",)
