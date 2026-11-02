from __future__ import annotations

from dataclasses import replace
from datetime import datetime, time, timezone
from decimal import Decimal

import pytest
from pydantic import ValidationError

from app.trading.strategy_capital_authority import (
    AuthorityProofBindings,
    CapitalAccountMode,
    CapitalSessionWindow,
    CapitalStage,
    CapitalVenue,
    StrategyCapitalAuthority,
    StrategyCapitalRequest,
    evaluate_strategy_capital_authority,
    project_post_order_exposure,
    quarantined_strategy_capital_authority,
)


_OBSERVED_AT = datetime(2026, 7, 13, 14, 0, tzinfo=timezone.utc)
_DIGEST = "sha256:" + "a" * 64


def _authority(**updates: object) -> StrategyCapitalAuthority:
    values: dict[str, object] = {
        "authority_id": "paper-alpha-v1",
        "strategy_ref": "alpha-v1",
        "candidate_ref": "candidate-42",
        "evidence_epoch_id": "tee-candidate-42",
        "stage": CapitalStage.PAPER_PROBATION,
        "account_label": "paper",
        "account_mode": CapitalAccountMode.PAPER,
        "venue": CapitalVenue.ALPACA,
        "allowed_symbols": ("NVDA", "AMD"),
        "max_order_notional": Decimal("1000"),
        "max_gross_notional": Decimal("5000"),
        "max_net_notional": Decimal("3000"),
        "max_loss": Decimal("250"),
        "max_orders_per_minute": 2,
        "max_orders_per_session": 10,
        "session": CapitalSessionWindow(
            timezone_name="America/New_York",
            weekdays=(0, 1, 2, 3, 4),
            start=time(9, 30),
            end=time(16, 0),
        ),
        "issued_at": datetime(2026, 7, 13, 13, 0, tzinfo=timezone.utc),
        "expires_at": datetime(2026, 7, 14, 20, 0, tzinfo=timezone.utc),
        "proofs": AuthorityProofBindings(
            policy_digest=_DIGEST,
            evidence_digest=_DIGEST,
            code_commit="a" * 40,
            image_digest=_DIGEST,
            data_digest=_DIGEST,
            execution_digest=_DIGEST,
        ),
        "issued_by": "research-owner",
        "approved_by": "risk-owner",
        "reduce_only": False,
    }
    values.update(updates)
    return StrategyCapitalAuthority.model_validate(values)


def _request(**updates: object) -> StrategyCapitalRequest:
    request = StrategyCapitalRequest(
        strategy_ref="alpha-v1",
        candidate_ref="candidate-42",
        evidence_epoch_id="tee-candidate-42",
        evidence_digest=_DIGEST,
        evidence_fresh_until=datetime(2026, 7, 14, 20, 0, tzinfo=timezone.utc),
        account_label="paper",
        account_mode=CapitalAccountMode.PAPER,
        venue=CapitalVenue.ALPACA,
        symbol="NVDA",
        order_notional=Decimal("500"),
        post_gross_notional=Decimal("1500"),
        post_net_notional=Decimal("1000"),
        capital_loss=Decimal("20"),
        orders_last_minute=0,
        orders_this_session=3,
        observed_at=_OBSERVED_AT,
        runtime_code_commit="a" * 40,
        runtime_image_digest=_DIGEST,
    )
    return replace(request, **updates)


def test_stage_vocabulary_is_exact_and_ordered() -> None:
    assert [stage.value for stage in CapitalStage] == [
        "disabled",
        "quarantined",
        "research_only",
        "replay_verified",
        "shadow_allowed",
        "paper_probation",
        "paper_verified",
        "micro_live_allowed",
        "capital_allowed",
        "scaled",
    ]


def test_non_broker_stage_cannot_hide_broker_fields() -> None:
    with pytest.raises(ValidationError, match="latent broker authority"):
        StrategyCapitalAuthority(
            authority_id="shadow-alpha-v1",
            strategy_ref="alpha-v1",
            stage=CapitalStage.SHADOW_ALLOWED,
            account_mode=CapitalAccountMode.PAPER,
        )


def test_broker_grant_requires_independent_approval_and_complete_bounds() -> None:
    with pytest.raises(ValidationError, match="independent"):
        _authority(approved_by="research-owner")
    with pytest.raises(ValidationError, match="positive"):
        _authority(max_loss=Decimal("0"))
    with pytest.raises(ValidationError, match="evidence_epoch_id"):
        _authority(evidence_epoch_id=None)
    proofs = _authority().proofs
    assert proofs is not None
    with pytest.raises(ValidationError, match="40-character Git SHA"):
        _authority(proofs={**proofs.model_dump(mode="json"), "code_commit": "short"})
    with pytest.raises(ValidationError, match="must permit risk increase"):
        _authority(reduce_only=True)


def test_authority_digest_is_canonical_and_content_bound() -> None:
    first = _authority()
    second = StrategyCapitalAuthority.model_validate(first.model_dump(mode="json"))
    changed = _authority(max_order_notional=Decimal("999"))
    assert first.digest == second.digest
    assert first.digest.startswith("sha256:")
    assert len(first.digest) == 71
    assert first.digest != changed.digest


def test_matching_bounded_authority_allows_request() -> None:
    authority = _authority()
    verdict = evaluate_strategy_capital_authority(
        payload=authority.to_payload(),
        persisted_digest=authority.digest,
        request=_request(),
    )
    assert verdict.allowed is True
    assert verdict.contract_valid is True
    assert verdict.reason_codes == ()
    assert verdict.authority_digest == authority.digest


@pytest.mark.parametrize(
    ("request_updates", "reason"),
    [
        ({"strategy_ref": "other-v1"}, "authority_strategy_mismatch"),
        ({"candidate_ref": "candidate-other"}, "authority_candidate_mismatch"),
        (
            {"evidence_epoch_id": "tee-candidate-other"},
            "authority_evidence_epoch_mismatch",
        ),
        (
            {"evidence_digest": "sha256:" + "b" * 64},
            "authority_evidence_digest_mismatch",
        ),
        (
            {
                "evidence_fresh_until": datetime(
                    2026, 7, 13, 13, 59, tzinfo=timezone.utc
                )
            },
            "authority_evidence_expired",
        ),
        ({"account_label": "live"}, "authority_account_mismatch"),
        ({"symbol": "TSLA"}, "authority_symbol_out_of_bounds"),
        ({"order_notional": Decimal("1001")}, "authority_order_notional_exceeded"),
        ({"post_gross_notional": Decimal("5001")}, "authority_gross_notional_exceeded"),
        ({"post_net_notional": Decimal("3001")}, "authority_net_notional_exceeded"),
        ({"capital_loss": Decimal("251")}, "authority_loss_bound_exceeded"),
        ({"capital_loss": None}, "authority_capital_loss_unavailable"),
        ({"orders_last_minute": 2}, "authority_minute_order_rate_exceeded"),
        ({"orders_this_session": 10}, "authority_session_order_rate_exceeded"),
        (
            {"runtime_code_commit": "b" * 40},
            "authority_runtime_code_commit_mismatch",
        ),
        (
            {"runtime_image_digest": "sha256:" + "b" * 64},
            "authority_runtime_image_digest_mismatch",
        ),
        (
            {"runtime_code_commit": None},
            "authority_runtime_code_commit_unavailable",
        ),
        (
            {"observed_at": datetime(2026, 7, 13, 21, 0, tzinfo=timezone.utc)},
            "authority_session_closed",
        ),
        (
            {"observed_at": datetime(2026, 7, 15, 14, 0, tzinfo=timezone.utc)},
            "authority_expired",
        ),
    ],
)
def test_authority_fails_closed_on_binding_or_limit_violation(
    request_updates: dict[str, object],
    reason: str,
) -> None:
    authority = _authority()
    verdict = evaluate_strategy_capital_authority(
        payload=authority.to_payload(),
        persisted_digest=authority.digest,
        request=_request(**request_updates),
    )
    assert verdict.allowed is False
    assert reason in verdict.reason_codes


def test_missing_tampered_and_shadow_authorities_fail_closed() -> None:
    missing = evaluate_strategy_capital_authority(
        payload=None,
        persisted_digest=None,
        request=_request(),
    )
    assert missing.reason_codes == ("authority_missing",)
    assert missing.contract_valid is False

    authority = _authority()
    tampered = evaluate_strategy_capital_authority(
        payload=authority.to_payload(),
        persisted_digest="sha256:" + "b" * 64,
        request=_request(),
    )
    assert tampered.reason_codes == ("authority_digest_mismatch",)
    assert tampered.contract_valid is False

    shadow = StrategyCapitalAuthority(
        authority_id="shadow-alpha-v1",
        strategy_ref="alpha-v1",
        stage=CapitalStage.SHADOW_ALLOWED,
        blockers=("p0_capital_freeze",),
    )
    shadow_verdict = evaluate_strategy_capital_authority(
        payload=shadow.to_payload(),
        persisted_digest=shadow.digest,
        request=_request(),
    )
    assert shadow_verdict.reason_codes == (
        "stage_shadow_allowed_blocks_paper_risk_increase",
        "authority_reduce_only",
        "authority_blocker:p0_capital_freeze",
    )

    long_blocker = "x" * 160
    bounded_shadow = StrategyCapitalAuthority(
        authority_id="shadow-alpha-bounded-v1",
        strategy_ref="alpha-v1",
        stage=CapitalStage.SHADOW_ALLOWED,
        blockers=(long_blocker,),
    )
    bounded_verdict = evaluate_strategy_capital_authority(
        payload=bounded_shadow.to_payload(),
        persisted_digest=bounded_shadow.digest,
        request=_request(),
    )
    assert bounded_verdict.allowed is False
    assert f"authority_blocker:{long_blocker}" in bounded_verdict.reason_codes


def test_quarantine_requires_a_reason() -> None:
    with pytest.raises(ValidationError, match="explain its blockers"):
        StrategyCapitalAuthority(
            authority_id="quarantine-alpha-v1",
            strategy_ref="alpha-v1",
            stage=CapitalStage.QUARANTINED,
        )
    quarantine = quarantined_strategy_capital_authority(
        strategy_ref="alpha-v1",
        reason="catalog_authority_missing",
    )
    assert quarantine.stage == CapitalStage.QUARANTINED
    assert quarantine.blockers == ("catalog_authority_missing",)


def test_projected_exposure_is_signed_and_fails_on_missing_market_value() -> None:
    projected, reasons = project_post_order_exposure(
        positions=[
            {"symbol": "NVDA", "market_value": "1000", "side": "long"},
            {"symbol": "AMD", "market_value": "400", "side": "short"},
        ],
        symbol="NVDA",
        side="buy",
        order_notional=Decimal("500"),
    )
    assert reasons == ()
    assert projected is not None
    assert projected.gross_notional == Decimal("1900")
    assert projected.net_notional == Decimal("1100")

    missing, missing_reasons = project_post_order_exposure(
        positions=[{"symbol": "NVDA", "qty": "2"}],
        symbol="NVDA",
        side="buy",
        order_notional=Decimal("500"),
    )
    assert missing is None
    assert missing_reasons == ("authority_position_market_value_missing",)
