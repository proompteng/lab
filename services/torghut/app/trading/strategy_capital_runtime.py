"""Immediate pre-broker evaluation of persisted strategy authority."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import Decimal
from typing import cast
from uuid import UUID

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from ..api.build_metadata import BUILD_COMMIT, BUILD_IMAGE_DIGEST
from ..config import settings
from ..models import Strategy, StrategyCapitalAuthorityRecord
from ..strategies.catalog import extract_catalog_metadata
from .strategy_capital_authority import (
    BROKER_RISK_STAGES,
    CapitalAccountMode,
    CapitalStage,
    CapitalVenue,
    ProjectedCapitalExposure,
    StrategyCapitalAuthority,
    StrategyCapitalRequest,
    StrategyCapitalVerdict,
    evaluate_strategy_capital_authority,
    project_post_order_exposure,
    runtime_artifact_binding_reasons,
)
from .strategy_capital_authority_store import (
    StrategyCapitalEvidenceBinding,
    StrategyCapitalUsageQuery,
    count_strategy_authority_usage,
    load_active_strategy_capital_authority,
    load_strategy_capital_evidence_binding,
    validate_strategy_capital_authority_record,
)
from .economic_ledger import (
    EconomicLedgerError,
    configured_broker_economic_scope,
    load_broker_economic_ledger_status,
)


_ALPACA_ADAPTER_NAMES = frozenset({"alpaca", "alpaca_fallback", "alpaca_paper", "lean"})


@dataclass(frozen=True)
class RuntimeStrategyCapitalRequest:
    decision_id: UUID
    account_label: str
    account_mode: str
    adapter_name: str
    symbol: str
    side: str
    order_notional: Decimal
    positions: Sequence[Mapping[str, object]]
    capital_loss: Decimal | None
    observed_at: datetime


@dataclass(frozen=True)
class _VerdictContext:
    strategy_ref: str
    observed_at: datetime
    stage: CapitalStage = CapitalStage.QUARANTINED
    authority_id: str | None = None
    authority_digest: str | None = None
    contract_valid: bool = False

    def denied(self, reason_codes: tuple[str, ...]) -> StrategyCapitalVerdict:
        return StrategyCapitalVerdict(
            allowed=False,
            contract_valid=self.contract_valid,
            strategy_ref=self.strategy_ref,
            authority_id=self.authority_id,
            authority_digest=self.authority_digest,
            stage=self.stage,
            evaluated_at=self.observed_at,
            reason_codes=reason_codes,
        )


@dataclass(frozen=True)
class _RuntimeAuthorityContext:
    strategy: Strategy
    record: StrategyCapitalAuthorityRecord
    authority: StrategyCapitalAuthority
    candidate_ref: str
    account_mode: CapitalAccountMode
    venue: CapitalVenue
    verdict: _VerdictContext


def _runtime_code_commit() -> str | None:
    normalized = BUILD_COMMIT.strip().lower()
    return normalized if len(normalized) == 40 else None


def _runtime_image_digest() -> str | None:
    normalized = str(BUILD_IMAGE_DIGEST or "").strip().lower()
    return (
        normalized
        if len(normalized) == 71 and normalized.startswith("sha256:")
        else None
    )


def _rollback_read_failure(session: Session) -> None:
    try:
        session.rollback()
    except SQLAlchemyError:
        pass


def _strategy_candidate_ref(strategy: Strategy) -> str:
    metadata = extract_catalog_metadata(strategy.description)
    return str(metadata.get("strategy_id") or strategy.name).strip()


def execution_adapter_capital_venue(adapter_name: str) -> CapitalVenue | None:
    normalized = adapter_name.strip().lower()
    if normalized in _ALPACA_ADAPTER_NAMES:
        return CapitalVenue.ALPACA
    if normalized == "hyperliquid":
        return CapitalVenue.HYPERLIQUID
    return None


def _verdict_context(
    *,
    strategy: Strategy,
    observed_at: datetime,
    record: StrategyCapitalAuthorityRecord | None = None,
    authority: StrategyCapitalAuthority | None = None,
    contract_valid: bool = False,
) -> _VerdictContext:
    return _VerdictContext(
        strategy_ref=strategy.name,
        observed_at=observed_at.astimezone(timezone.utc),
        stage=authority.stage if authority is not None else CapitalStage.QUARANTINED,
        authority_id=(
            authority.authority_id
            if authority is not None
            else record.authority_id
            if record is not None
            else None
        ),
        authority_digest=record.authority_digest if record is not None else None,
        contract_valid=contract_valid,
    )


def _load_runtime_authority(
    session: Session,
    strategy: Strategy,
    request: RuntimeStrategyCapitalRequest,
) -> tuple[_RuntimeAuthorityContext | None, StrategyCapitalVerdict | None]:
    initial_verdict = _verdict_context(
        strategy=strategy,
        observed_at=request.observed_at,
    )
    try:
        record = load_active_strategy_capital_authority(
            session,
            strategy=strategy,
            lock_for_update=True,
        )
    except (SQLAlchemyError, ValueError):
        _rollback_read_failure(session)
        return None, initial_verdict.denied(("authority_read_failed",))
    authority, contract_reasons = validate_strategy_capital_authority_record(
        strategy=strategy,
        record=record,
    )
    authority_verdict = _verdict_context(
        strategy=strategy,
        observed_at=request.observed_at,
        record=record,
        authority=authority,
    )
    if authority is None or contract_reasons:
        return None, authority_verdict.denied(
            contract_reasons or ("authority_contract_invalid",)
        )
    assert record is not None
    authority_verdict = replace(authority_verdict, contract_valid=True)
    try:
        account_mode = CapitalAccountMode(request.account_mode.strip().lower())
    except ValueError:
        return None, authority_verdict.denied(("authority_account_mode_unsupported",))
    venue = execution_adapter_capital_venue(request.adapter_name)
    if venue is None:
        return None, authority_verdict.denied(
            ("authority_execution_venue_unsupported",)
        )
    return (
        _RuntimeAuthorityContext(
            strategy=strategy,
            record=record,
            authority=authority,
            candidate_ref=_strategy_candidate_ref(strategy),
            account_mode=account_mode,
            venue=venue,
            verdict=authority_verdict,
        ),
        None,
    )


def _capital_request(
    context: _RuntimeAuthorityContext,
    request: RuntimeStrategyCapitalRequest,
    *,
    evidence_binding: StrategyCapitalEvidenceBinding | None = None,
    projected: ProjectedCapitalExposure | None = None,
    usage: tuple[int, int] = (0, 0),
) -> StrategyCapitalRequest:
    return StrategyCapitalRequest(
        strategy_ref=context.strategy.name,
        candidate_ref=context.candidate_ref,
        evidence_epoch_id=(
            evidence_binding.evidence_epoch_id if evidence_binding is not None else None
        ),
        evidence_digest=(
            evidence_binding.evidence_digest if evidence_binding is not None else None
        ),
        evidence_fresh_until=(
            evidence_binding.fresh_until if evidence_binding is not None else None
        ),
        account_label=request.account_label,
        account_mode=context.account_mode,
        venue=context.venue,
        symbol=request.symbol,
        order_notional=request.order_notional
        if projected is not None
        else Decimal("0"),
        post_gross_notional=(
            projected.gross_notional if projected is not None else Decimal("0")
        ),
        post_net_notional=(
            projected.net_notional if projected is not None else Decimal("0")
        ),
        capital_loss=request.capital_loss,
        orders_last_minute=usage[0],
        orders_this_session=usage[1],
        observed_at=request.observed_at.astimezone(timezone.utc),
        runtime_code_commit=_runtime_code_commit(),
        runtime_image_digest=_runtime_image_digest(),
    )


def _evaluate_context(
    context: _RuntimeAuthorityContext,
    request: StrategyCapitalRequest,
) -> StrategyCapitalVerdict:
    return evaluate_strategy_capital_authority(
        payload=context.record.payload_json,
        persisted_digest=context.record.authority_digest,
        request=request,
    )


def _load_runtime_evidence(
    session: Session,
    context: _RuntimeAuthorityContext,
    request: RuntimeStrategyCapitalRequest,
) -> tuple[StrategyCapitalEvidenceBinding | None, StrategyCapitalVerdict | None]:
    try:
        evidence_binding, evidence_reasons = load_strategy_capital_evidence_binding(
            session,
            authority=context.authority,
            observed_at=request.observed_at,
        )
    except (SQLAlchemyError, TypeError, ValueError):
        _rollback_read_failure(session)
        return None, context.verdict.denied(("authority_evidence_read_failed",))
    if evidence_binding is None or evidence_reasons:
        return None, context.verdict.denied(
            evidence_reasons or ("authority_evidence_invalid",)
        )
    return evidence_binding, None


def _project_runtime_exposure(
    context: _RuntimeAuthorityContext,
    request: RuntimeStrategyCapitalRequest,
) -> tuple[ProjectedCapitalExposure | None, StrategyCapitalVerdict | None]:
    projected, reasons = project_post_order_exposure(
        positions=request.positions,
        symbol=request.symbol,
        side=request.side,
        order_notional=request.order_notional,
    )
    if projected is None:
        return None, context.verdict.denied(reasons)
    return projected, None


def _load_runtime_usage(
    session: Session,
    context: _RuntimeAuthorityContext,
    request: RuntimeStrategyCapitalRequest,
) -> tuple[tuple[int, int] | None, StrategyCapitalVerdict | None]:
    observed_at = request.observed_at.astimezone(timezone.utc)
    assert context.authority.session is not None
    session_bounds = context.authority.session.bounds_for(observed_at)
    session_started_at = (
        session_bounds[0] if session_bounds is not None else observed_at
    )
    try:
        usage = count_strategy_authority_usage(
            session,
            query=StrategyCapitalUsageQuery(
                strategy_id=UUID(str(context.strategy.id)),
                decision_id=request.decision_id,
                account_label=request.account_label,
                observed_at=observed_at,
                session_started_at=session_started_at,
            ),
        )
    except (SQLAlchemyError, TypeError, ValueError):
        _rollback_read_failure(session)
        return None, context.verdict.denied(("authority_usage_read_failed",))
    return usage, None


def _economic_parity_reasons(
    session: Session,
    *,
    account_label: str,
    observed_at: datetime,
) -> tuple[str, ...]:
    if not settings.tigerbeetle_economic_parity_required:
        return ()
    try:
        status = load_broker_economic_ledger_status(
            session,
            scope=configured_broker_economic_scope(account_label=account_label),
            observed_at=observed_at,
            expected_tigerbeetle_cluster_id=settings.tigerbeetle_cluster_id,
        )
    except (EconomicLedgerError, SQLAlchemyError, TypeError, ValueError):
        _rollback_read_failure(session)
        return ("broker_economic_accounting_parity_read_failed",)
    if status.get("entry_dependency_satisfied") is True:
        return ()
    reason_codes = status.get("reason_codes")
    if not isinstance(reason_codes, Sequence) or isinstance(
        reason_codes, (str, bytes, bytearray)
    ):
        return ("broker_economic_accounting_parity_status_invalid",)
    reason_items = cast(Sequence[object], reason_codes)
    if any(not isinstance(reason, str) for reason in reason_items):
        return ("broker_economic_accounting_parity_status_invalid",)
    typed_reasons = cast(Sequence[str], reason_items)
    reasons = tuple(
        dict.fromkeys(reason.strip() for reason in typed_reasons if reason.strip())
    )
    return reasons or ("broker_economic_accounting_parity_unproven",)


def evaluate_runtime_strategy_capital_authority(
    session: Session,
    *,
    strategy: Strategy,
    request: RuntimeStrategyCapitalRequest,
) -> StrategyCapitalVerdict:
    """Evaluate the exact active authority using current exposure and usage."""

    context, denied = _load_runtime_authority(session, strategy, request)
    if context is None:
        assert denied is not None
        return denied
    if context.authority.stage not in BROKER_RISK_STAGES:
        return _evaluate_context(context, _capital_request(context, request))
    if context.venue is CapitalVenue.ALPACA:
        parity_reasons = _economic_parity_reasons(
            session,
            account_label=request.account_label,
            observed_at=request.observed_at,
        )
        if parity_reasons:
            return context.verdict.denied(parity_reasons)
    evidence_binding, denied = _load_runtime_evidence(session, context, request)
    if evidence_binding is None:
        assert denied is not None
        return denied
    projected, denied = _project_runtime_exposure(context, request)
    if projected is None:
        assert denied is not None
        return denied
    usage, denied = _load_runtime_usage(session, context, request)
    if usage is None:
        assert denied is not None
        return denied
    return _evaluate_context(
        context,
        _capital_request(
            context,
            request,
            evidence_binding=evidence_binding,
            projected=projected,
            usage=usage,
        ),
    )


def _active_submission_authority_reasons(
    session: Session,
    authority: StrategyCapitalAuthority,
    observed_at: datetime,
) -> tuple[str, ...]:
    reasons: list[str] = []
    if authority.stage not in BROKER_RISK_STAGES:
        reasons.append("authority_stage_changed_before_submission")
    if authority.issued_at is None or observed_at < authority.issued_at:
        reasons.append("authority_not_yet_effective")
    if authority.expires_at is None or observed_at >= authority.expires_at:
        reasons.append("authority_expired")
    if authority.session is None or not authority.session.contains(observed_at):
        reasons.append("authority_session_closed")
    if authority.reduce_only:
        reasons.append("authority_reduce_only")
    reasons.extend(f"authority_blocker:{blocker}" for blocker in authority.blockers)
    if authority.venue is CapitalVenue.ALPACA:
        if authority.account_label is None:
            reasons.append("authority_account_label_missing")
        else:
            reasons.extend(
                _economic_parity_reasons(
                    session,
                    account_label=authority.account_label,
                    observed_at=observed_at,
                )
            )
    reasons.extend(
        runtime_artifact_binding_reasons(
            authority=authority,
            runtime_code_commit=_runtime_code_commit(),
            runtime_image_digest=_runtime_image_digest(),
        )
    )
    _evidence_binding, evidence_reasons = load_strategy_capital_evidence_binding(
        session,
        authority=authority,
        observed_at=observed_at,
    )
    reasons.extend(evidence_reasons)
    return tuple(dict.fromkeys(reasons))


def _submission_revalidation_reasons(
    session: Session,
    strategy: Strategy,
    verdict: StrategyCapitalVerdict,
    observed_at: datetime,
) -> tuple[str, ...]:
    record = load_active_strategy_capital_authority(
        session,
        strategy=strategy,
        lock_for_share=True,
    )
    if record is None:
        return ("authority_revoked_before_submission",)
    authority, reasons = validate_strategy_capital_authority_record(
        strategy=strategy,
        record=record,
    )
    if authority is None:
        return reasons or ("authority_revoked_before_submission",)
    if reasons:
        return reasons
    if (
        authority.authority_id != verdict.authority_id
        or record.authority_digest != verdict.authority_digest
    ):
        return ("authority_changed_before_submission",)
    return _active_submission_authority_reasons(session, authority, observed_at)


def hold_runtime_strategy_capital_authority_for_submission(
    session: Session,
    *,
    strategy: Strategy,
    verdict: StrategyCapitalVerdict,
    observed_at: datetime,
) -> StrategyCapitalVerdict:
    """Keep revocation from crossing the final authority-check/broker boundary."""

    observed_utc = observed_at.astimezone(timezone.utc)
    if (
        not verdict.allowed
        or verdict.authority_id is None
        or verdict.authority_digest is None
    ):
        return replace(
            verdict,
            allowed=False,
            evaluated_at=observed_utc,
            reason_codes=("authority_verdict_incomplete",),
        )
    try:
        reasons = _submission_revalidation_reasons(
            session,
            strategy,
            verdict,
            observed_utc,
        )
    except (SQLAlchemyError, TypeError, ValueError):
        _rollback_read_failure(session)
        reasons = ("authority_revalidation_read_failed",)
    if not reasons:
        return replace(verdict, evaluated_at=observed_utc)
    return replace(
        verdict,
        allowed=False,
        evaluated_at=observed_utc,
        reason_codes=reasons,
    )


__all__ = (
    "RuntimeStrategyCapitalRequest",
    "evaluate_runtime_strategy_capital_authority",
    "execution_adapter_capital_venue",
    "hold_runtime_strategy_capital_authority_for_submission",
)
