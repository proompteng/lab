"""Canonical, strategy-scoped authority for risk-increasing broker orders."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, time, timezone
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Self
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)


STRATEGY_CAPITAL_AUTHORITY_SCHEMA_VERSION = "torghut.strategy-capital-authority.v1"
STRATEGY_CAPITAL_AUTHORITY_STATUS_SCHEMA_VERSION = (
    "torghut.strategy-capital-authority-status.v1"
)

_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
_IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$")


class CapitalStage(StrEnum):
    DISABLED = "disabled"
    QUARANTINED = "quarantined"
    RESEARCH_ONLY = "research_only"
    REPLAY_VERIFIED = "replay_verified"
    SHADOW_ALLOWED = "shadow_allowed"
    PAPER_PROBATION = "paper_probation"
    PAPER_VERIFIED = "paper_verified"
    MICRO_LIVE_ALLOWED = "micro_live_allowed"
    CAPITAL_ALLOWED = "capital_allowed"
    SCALED = "scaled"


class CapitalAccountMode(StrEnum):
    NONE = "none"
    PAPER = "paper"
    LIVE = "live"


class CapitalVenue(StrEnum):
    NONE = "none"
    ALPACA = "alpaca"
    HYPERLIQUID = "hyperliquid"


_PAPER_BROKER_STAGES = frozenset(
    {
        CapitalStage.PAPER_PROBATION,
        CapitalStage.PAPER_VERIFIED,
    }
)
_LIVE_BROKER_STAGES = frozenset(
    {
        CapitalStage.MICRO_LIVE_ALLOWED,
        CapitalStage.CAPITAL_ALLOWED,
        CapitalStage.SCALED,
    }
)
BROKER_RISK_STAGES = _PAPER_BROKER_STAGES | _LIVE_BROKER_STAGES


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must include a timezone")
    return value.astimezone(timezone.utc)


def _clean_identifier(value: str, *, field_name: str) -> str:
    cleaned = value.strip()
    if not _IDENTIFIER_PATTERN.fullmatch(cleaned):
        raise ValueError(f"{field_name} has an invalid format")
    return cleaned


def _clean_reason_values(
    values: Sequence[str],
    *,
    max_length: int = 256,
) -> tuple[str, ...]:
    normalized = tuple(
        dict.fromkeys(str(value).strip() for value in values if str(value).strip())
    )
    if any(len(value) > max_length for value in normalized):
        raise ValueError(f"reason values must not exceed {max_length} characters")
    return normalized


def canonical_payload_digest(payload: Mapping[str, object]) -> str:
    """Return the canonical SHA-256 identity for a JSON-compatible payload."""

    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


class AuthorityProofBindings(BaseModel):
    """Immutable proof identities required for any broker-risk stage."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    policy_digest: str
    evidence_digest: str
    code_commit: str
    image_digest: str
    data_digest: str
    execution_digest: str

    @field_validator(
        "policy_digest",
        "evidence_digest",
        "image_digest",
        "data_digest",
        "execution_digest",
    )
    @classmethod
    def _validate_digest(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not _DIGEST_PATTERN.fullmatch(cleaned):
            raise ValueError("proof digest must use sha256:<64 lowercase hex>")
        return cleaned

    @field_validator("code_commit")
    @classmethod
    def _validate_code_commit(cls, value: str) -> str:
        cleaned = value.strip().lower()
        if not _COMMIT_PATTERN.fullmatch(cleaned):
            raise ValueError("code_commit must be a full 40-character Git SHA")
        return cleaned


class CapitalSessionWindow(BaseModel):
    """Non-overnight local session in which an authority may be exercised."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    timezone_name: str = "America/New_York"
    weekdays: tuple[int, ...] = (0, 1, 2, 3, 4)
    start: time
    end: time

    @field_validator("timezone_name")
    @classmethod
    def _validate_timezone(cls, value: str) -> str:
        cleaned = value.strip()
        try:
            ZoneInfo(cleaned)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("session timezone is unknown") from exc
        return cleaned

    @field_validator("weekdays")
    @classmethod
    def _validate_weekdays(cls, value: tuple[int, ...]) -> tuple[int, ...]:
        normalized = tuple(dict.fromkeys(value))
        if not normalized or any(day < 0 or day > 6 for day in normalized):
            raise ValueError("session weekdays must be unique values from 0 through 6")
        return normalized

    @model_validator(mode="after")
    def _validate_window(self) -> Self:
        if self.start.tzinfo is not None or self.end.tzinfo is not None:
            raise ValueError("session times must be local wall-clock values")
        if self.start >= self.end:
            raise ValueError("overnight or empty authority sessions are not supported")
        return self

    def contains(self, observed_at: datetime) -> bool:
        local = _aware_utc(observed_at).astimezone(ZoneInfo(self.timezone_name))
        local_time = local.time().replace(tzinfo=None)
        return local.weekday() in self.weekdays and self.start <= local_time < self.end

    def bounds_for(self, observed_at: datetime) -> tuple[datetime, datetime] | None:
        local = _aware_utc(observed_at).astimezone(ZoneInfo(self.timezone_name))
        if local.weekday() not in self.weekdays:
            return None
        zone = ZoneInfo(self.timezone_name)
        session_start = datetime.combine(local.date(), self.start, tzinfo=zone)
        session_end = datetime.combine(local.date(), self.end, tzinfo=zone)
        return session_start.astimezone(timezone.utc), session_end.astimezone(
            timezone.utc
        )


class StrategyCapitalAuthority(BaseModel):
    """Versioned grant whose default shape carries no broker authority."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    schema_version: str = STRATEGY_CAPITAL_AUTHORITY_SCHEMA_VERSION
    authority_id: str
    strategy_ref: str
    candidate_ref: str | None = None
    evidence_epoch_id: str | None = None
    stage: CapitalStage
    account_label: str | None = None
    account_mode: CapitalAccountMode = CapitalAccountMode.NONE
    venue: CapitalVenue = CapitalVenue.NONE
    allowed_symbols: tuple[str, ...] = ()
    max_order_notional: Decimal = Field(default=Decimal("0"), ge=0)
    max_gross_notional: Decimal = Field(default=Decimal("0"), ge=0)
    max_net_notional: Decimal = Field(default=Decimal("0"), ge=0)
    max_loss: Decimal = Field(default=Decimal("0"), ge=0)
    max_orders_per_minute: int = Field(default=0, ge=0, le=10_000)
    max_orders_per_session: int = Field(default=0, ge=0, le=1_000_000)
    session: CapitalSessionWindow | None = None
    issued_at: datetime | None = None
    expires_at: datetime | None = None
    proofs: AuthorityProofBindings | None = None
    issued_by: str | None = None
    approved_by: str | None = None
    reduce_only: bool = True
    blockers: tuple[str, ...] = ()

    @field_validator("schema_version")
    @classmethod
    def _validate_schema_version(cls, value: str) -> str:
        if value != STRATEGY_CAPITAL_AUTHORITY_SCHEMA_VERSION:
            raise ValueError("strategy capital authority schema version is unsupported")
        return value

    @field_validator("authority_id")
    @classmethod
    def _validate_authority_id(cls, value: str) -> str:
        return _clean_identifier(value, field_name="authority_id")

    @field_validator("strategy_ref")
    @classmethod
    def _validate_strategy_ref(cls, value: str) -> str:
        return _clean_identifier(value, field_name="strategy_ref")

    @field_validator("candidate_ref", "evidence_epoch_id")
    @classmethod
    def _validate_optional_identifier(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _clean_identifier(value, field_name="authority binding")

    @field_validator("account_label", "issued_by", "approved_by")
    @classmethod
    def _normalize_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 128 or any(ord(char) < 32 for char in cleaned):
            raise ValueError("authority text binding is invalid")
        return cleaned

    @field_validator("allowed_symbols")
    @classmethod
    def _normalize_symbols(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(
            dict.fromkeys(symbol.strip().upper() for symbol in value if symbol.strip())
        )
        if len(normalized) > 256 or any(len(symbol) > 64 for symbol in normalized):
            raise ValueError("allowed_symbols is invalid")
        return normalized

    @field_validator("blockers")
    @classmethod
    def _normalize_blockers(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        return _clean_reason_values(value, max_length=160)

    @field_validator(
        "max_order_notional",
        "max_gross_notional",
        "max_net_notional",
        "max_loss",
    )
    @classmethod
    def _validate_decimal(cls, value: Decimal) -> Decimal:
        if not value.is_finite():
            raise ValueError("authority bounds must be finite")
        return value

    @field_validator("issued_at", "expires_at")
    @classmethod
    def _normalize_timestamp(cls, value: datetime | None) -> datetime | None:
        return _aware_utc(value) if value is not None else None

    def _validate_no_latent_broker_authority(self) -> None:
        latent_broker_fields = (
            self.account_label,
            self.candidate_ref,
            self.evidence_epoch_id,
            self.session,
            self.issued_at,
            self.expires_at,
            self.proofs,
            self.issued_by,
            self.approved_by,
        )
        carries_broker_authority = (
            any(value is not None for value in latent_broker_fields)
            or self.account_mode != CapitalAccountMode.NONE
            or self.venue != CapitalVenue.NONE
            or bool(self.allowed_symbols)
            or any(
                bound != 0
                for bound in (
                    self.max_order_notional,
                    self.max_gross_notional,
                    self.max_net_notional,
                    self.max_loss,
                )
            )
            or self.max_orders_per_minute != 0
            or self.max_orders_per_session != 0
            or not self.reduce_only
        )
        if carries_broker_authority:
            raise ValueError("non-broker stage cannot carry latent broker authority")

    def _validate_broker_bindings(self) -> None:
        required = {
            "account_label": self.account_label,
            "candidate_ref": self.candidate_ref,
            "evidence_epoch_id": self.evidence_epoch_id,
            "session": self.session,
            "issued_at": self.issued_at,
            "expires_at": self.expires_at,
            "proofs": self.proofs,
            "issued_by": self.issued_by,
            "approved_by": self.approved_by,
        }
        missing = sorted(name for name, value in required.items() if value is None)
        if missing:
            raise ValueError(
                f"broker authority is missing required bindings: {','.join(missing)}"
            )
        if (
            self.account_mode == CapitalAccountMode.NONE
            or self.venue == CapitalVenue.NONE
        ):
            raise ValueError("broker authority must bind account mode and venue")
        if not self.allowed_symbols:
            raise ValueError("broker authority must bind at least one symbol")

    def _validate_broker_bounds(self) -> None:
        if any(
            bound <= 0
            for bound in (
                self.max_order_notional,
                self.max_gross_notional,
                self.max_net_notional,
                self.max_loss,
            )
        ):
            raise ValueError("broker authority bounds must be positive")
        if self.max_order_notional > self.max_gross_notional:
            raise ValueError("order notional cannot exceed gross authority")
        if self.max_net_notional > self.max_gross_notional:
            raise ValueError("net authority cannot exceed gross authority")
        if self.max_orders_per_minute <= 0 or self.max_orders_per_session <= 0:
            raise ValueError("broker authority order-rate bounds must be positive")
        if self.max_orders_per_minute > self.max_orders_per_session:
            raise ValueError("minute order bound cannot exceed session order bound")

    def _validate_broker_governance(self) -> None:
        if self.reduce_only:
            raise ValueError(
                "broker authority must permit risk increase; use a safe stage or "
                "the separate risk-reduction permit for reduce-only actions"
            )
        assert self.issued_at is not None
        assert self.expires_at is not None
        if self.expires_at <= self.issued_at:
            raise ValueError("broker authority expiry must follow issuance")
        assert self.issued_by is not None
        assert self.approved_by is not None
        if self.issued_by.casefold() == self.approved_by.casefold():
            raise ValueError("broker authority issuer and approver must be independent")
        if self.blockers:
            raise ValueError("broker authority cannot be issued with blockers")
        if (
            self.stage in _PAPER_BROKER_STAGES
            and self.account_mode != CapitalAccountMode.PAPER
        ):
            raise ValueError("paper authority must bind a paper account")
        if (
            self.stage in _LIVE_BROKER_STAGES
            and self.account_mode != CapitalAccountMode.LIVE
        ):
            raise ValueError("live authority must bind a live account")

    @model_validator(mode="after")
    def _validate_broker_grant(self) -> Self:
        if self.stage == CapitalStage.QUARANTINED and not self.blockers:
            raise ValueError("quarantined authority must explain its blockers")
        if self.stage not in BROKER_RISK_STAGES:
            self._validate_no_latent_broker_authority()
            return self
        self._validate_broker_bindings()
        self._validate_broker_bounds()
        self._validate_broker_governance()
        return self

    def to_payload(self) -> dict[str, object]:
        return self.model_dump(mode="json")

    @property
    def digest(self) -> str:
        return canonical_payload_digest(self.to_payload())


@dataclass(frozen=True)
class StrategyCapitalRequest:
    strategy_ref: str
    candidate_ref: str | None
    evidence_epoch_id: str | None
    evidence_digest: str | None
    evidence_fresh_until: datetime | None
    account_label: str
    account_mode: CapitalAccountMode
    venue: CapitalVenue
    symbol: str
    order_notional: Decimal
    post_gross_notional: Decimal
    post_net_notional: Decimal
    capital_loss: Decimal | None
    orders_last_minute: int
    orders_this_session: int
    observed_at: datetime
    runtime_code_commit: str | None = None
    runtime_image_digest: str | None = None

    def __post_init__(self) -> None:
        _clean_identifier(self.strategy_ref, field_name="request.strategy_ref")
        if self.candidate_ref is not None:
            _clean_identifier(self.candidate_ref, field_name="request.candidate_ref")
        if self.evidence_epoch_id is not None:
            _clean_identifier(
                self.evidence_epoch_id,
                field_name="request.evidence_epoch_id",
            )
        if self.evidence_digest is not None and not _DIGEST_PATTERN.fullmatch(
            self.evidence_digest
        ):
            raise ValueError(
                "request evidence digest must use sha256:<64 lowercase hex>"
            )
        if self.evidence_fresh_until is not None:
            _aware_utc(self.evidence_fresh_until)
        if not self.account_label.strip():
            raise ValueError("request account label is required")
        if not self.symbol.strip():
            raise ValueError("request symbol is required")
        for value in (
            self.order_notional,
            self.post_gross_notional,
            self.post_net_notional,
        ):
            if not value.is_finite() or value < 0:
                raise ValueError(
                    "request monetary values must be finite and non-negative"
                )
        if self.capital_loss is not None and (
            not self.capital_loss.is_finite() or self.capital_loss < 0
        ):
            raise ValueError("request capital loss must be finite and non-negative")
        if self.orders_last_minute < 0 or self.orders_this_session < 0:
            raise ValueError("request order counts must be non-negative")
        _aware_utc(self.observed_at)


@dataclass(frozen=True)
class StrategyCapitalVerdict:
    allowed: bool
    contract_valid: bool
    strategy_ref: str
    authority_id: str | None
    authority_digest: str | None
    stage: CapitalStage
    evaluated_at: datetime
    reason_codes: tuple[str, ...]

    def to_payload(self) -> dict[str, object]:
        return {
            "schema_version": STRATEGY_CAPITAL_AUTHORITY_STATUS_SCHEMA_VERSION,
            "allowed": self.allowed,
            "contract_valid": self.contract_valid,
            "strategy_ref": self.strategy_ref,
            "authority_id": self.authority_id,
            "authority_digest": self.authority_digest,
            "stage": self.stage.value,
            "evaluated_at": _aware_utc(self.evaluated_at).isoformat(),
            "reason_codes": list(self.reason_codes),
        }


def quarantined_strategy_capital_authority(
    *,
    strategy_ref: str,
    reason: str,
    authority_id: str | None = None,
) -> StrategyCapitalAuthority:
    identity = (
        authority_id
        or f"quarantine-{hashlib.sha256(strategy_ref.encode()).hexdigest()[:20]}-v1"
    )
    return StrategyCapitalAuthority(
        authority_id=identity,
        strategy_ref=strategy_ref,
        stage=CapitalStage.QUARANTINED,
        blockers=(reason,),
    )


def _validate_authority_contract(
    *,
    payload: Mapping[str, object] | None,
    persisted_digest: str | None,
    expected_strategy_ref: str,
) -> tuple[StrategyCapitalAuthority | None, tuple[str, ...]]:
    if payload is None:
        return None, ("authority_missing",)
    try:
        authority = StrategyCapitalAuthority.model_validate(payload)
    except ValidationError:
        return None, ("authority_contract_invalid",)
    if persisted_digest is None or not _DIGEST_PATTERN.fullmatch(persisted_digest):
        return authority, ("authority_digest_missing_or_invalid",)
    if authority.digest != persisted_digest:
        return authority, ("authority_digest_mismatch",)
    if authority.strategy_ref != expected_strategy_ref:
        return authority, ("authority_strategy_mismatch",)
    return authority, ()


def validate_strategy_capital_authority(
    *,
    payload: Mapping[str, object] | None,
    persisted_digest: str | None,
    expected_strategy_ref: str,
) -> tuple[StrategyCapitalAuthority | None, tuple[str, ...]]:
    """Validate an immutable stored authority and its strategy binding."""

    return _validate_authority_contract(
        payload=payload,
        persisted_digest=persisted_digest,
        expected_strategy_ref=expected_strategy_ref,
    )


def _stage_allows_mode(stage: CapitalStage, mode: CapitalAccountMode) -> bool:
    if mode == CapitalAccountMode.PAPER:
        return stage in _PAPER_BROKER_STAGES
    if mode == CapitalAccountMode.LIVE:
        return stage in _LIVE_BROKER_STAGES
    return False


def required_evidence_epoch_decision(stage: CapitalStage) -> str | None:
    return {
        CapitalStage.PAPER_PROBATION: "paper_allowed",
        CapitalStage.PAPER_VERIFIED: "paper_allowed",
        CapitalStage.MICRO_LIVE_ALLOWED: "canary_allowed",
        CapitalStage.CAPITAL_ALLOWED: "live_allowed",
        CapitalStage.SCALED: "scale_allowed",
    }.get(stage)


def runtime_artifact_binding_reasons(
    *,
    authority: StrategyCapitalAuthority,
    runtime_code_commit: str | None,
    runtime_image_digest: str | None,
) -> tuple[str, ...]:
    if authority.stage not in BROKER_RISK_STAGES:
        return ()
    assert authority.proofs is not None
    reasons: list[str] = []
    normalized_commit = str(runtime_code_commit or "").strip().lower()
    if not _COMMIT_PATTERN.fullmatch(normalized_commit):
        reasons.append("authority_runtime_code_commit_unavailable")
    elif authority.proofs.code_commit != normalized_commit:
        reasons.append("authority_runtime_code_commit_mismatch")
    normalized_image = str(runtime_image_digest or "").strip().lower()
    if not _DIGEST_PATTERN.fullmatch(normalized_image):
        reasons.append("authority_runtime_image_digest_unavailable")
    elif authority.proofs.image_digest != normalized_image:
        reasons.append("authority_runtime_image_digest_mismatch")
    return tuple(reasons)


def _authority_stage_reasons(
    authority: StrategyCapitalAuthority,
    request: StrategyCapitalRequest,
) -> list[str]:
    reasons: list[str] = []
    if not _stage_allows_mode(authority.stage, request.account_mode):
        reasons.append(
            f"stage_{authority.stage.value}_blocks_{request.account_mode.value}_risk_increase"
        )
    if authority.reduce_only:
        reasons.append("authority_reduce_only")
    reasons.extend(f"authority_blocker:{blocker}" for blocker in authority.blockers)
    return reasons


def _authority_evidence_reasons(
    authority: StrategyCapitalAuthority,
    request: StrategyCapitalRequest,
    *,
    evaluated_at: datetime,
) -> list[str]:
    reasons: list[str] = []
    if request.candidate_ref is None:
        reasons.append("authority_candidate_ref_unavailable")
    elif authority.candidate_ref != request.candidate_ref:
        reasons.append("authority_candidate_mismatch")
    if request.evidence_epoch_id is None:
        reasons.append("authority_evidence_epoch_unavailable")
    elif authority.evidence_epoch_id != request.evidence_epoch_id:
        reasons.append("authority_evidence_epoch_mismatch")
    assert authority.proofs is not None
    if request.evidence_digest is None:
        reasons.append("authority_evidence_digest_unavailable")
    elif authority.proofs.evidence_digest != request.evidence_digest:
        reasons.append("authority_evidence_digest_mismatch")
    if request.evidence_fresh_until is None:
        reasons.append("authority_evidence_freshness_unavailable")
    elif evaluated_at >= _aware_utc(request.evidence_fresh_until):
        reasons.append("authority_evidence_expired")
    return reasons


def _authority_account_reasons(
    authority: StrategyCapitalAuthority,
    request: StrategyCapitalRequest,
) -> list[str]:
    reasons: list[str] = []
    if authority.account_label != request.account_label:
        reasons.append("authority_account_mismatch")
    if authority.account_mode != request.account_mode:
        reasons.append("authority_account_mode_mismatch")
    if authority.venue != request.venue:
        reasons.append("authority_venue_mismatch")
    reasons.extend(
        runtime_artifact_binding_reasons(
            authority=authority,
            runtime_code_commit=request.runtime_code_commit,
            runtime_image_digest=request.runtime_image_digest,
        )
    )
    if request.symbol.strip().upper() not in authority.allowed_symbols:
        reasons.append("authority_symbol_out_of_bounds")
    return reasons


def _authority_limit_reasons(
    authority: StrategyCapitalAuthority,
    request: StrategyCapitalRequest,
) -> list[str]:
    reasons: list[str] = []
    if request.order_notional <= 0:
        reasons.append("authority_order_notional_unavailable")
    elif request.order_notional > authority.max_order_notional:
        reasons.append("authority_order_notional_exceeded")
    if request.post_gross_notional > authority.max_gross_notional:
        reasons.append("authority_gross_notional_exceeded")
    if request.post_net_notional > authority.max_net_notional:
        reasons.append("authority_net_notional_exceeded")
    if request.capital_loss is None:
        reasons.append("authority_capital_loss_unavailable")
    elif request.capital_loss > authority.max_loss:
        reasons.append("authority_loss_bound_exceeded")
    if request.orders_last_minute >= authority.max_orders_per_minute:
        reasons.append("authority_minute_order_rate_exceeded")
    if request.orders_this_session >= authority.max_orders_per_session:
        reasons.append("authority_session_order_rate_exceeded")
    return reasons


def _authority_time_reasons(
    authority: StrategyCapitalAuthority,
    *,
    evaluated_at: datetime,
) -> list[str]:
    reasons: list[str] = []
    if authority.issued_at is None or evaluated_at < authority.issued_at:
        reasons.append("authority_not_yet_effective")
    if authority.expires_at is None or evaluated_at >= authority.expires_at:
        reasons.append("authority_expired")
    if authority.session is None or not authority.session.contains(evaluated_at):
        reasons.append("authority_session_closed")
    return reasons


def evaluate_strategy_capital_authority(
    *,
    payload: Mapping[str, object] | None,
    persisted_digest: str | None,
    request: StrategyCapitalRequest,
) -> StrategyCapitalVerdict:
    evaluated_at = _aware_utc(request.observed_at)
    authority, contract_reasons = _validate_authority_contract(
        payload=payload,
        persisted_digest=persisted_digest,
        expected_strategy_ref=request.strategy_ref,
    )
    if authority is None:
        return StrategyCapitalVerdict(
            allowed=False,
            contract_valid=False,
            strategy_ref=request.strategy_ref,
            authority_id=None,
            authority_digest=persisted_digest,
            stage=CapitalStage.QUARANTINED,
            evaluated_at=evaluated_at,
            reason_codes=contract_reasons,
        )
    if contract_reasons:
        return StrategyCapitalVerdict(
            allowed=False,
            contract_valid=False,
            strategy_ref=request.strategy_ref,
            authority_id=authority.authority_id,
            authority_digest=persisted_digest,
            stage=authority.stage,
            evaluated_at=evaluated_at,
            reason_codes=contract_reasons,
        )

    reasons = _authority_stage_reasons(authority, request)
    if authority.stage not in BROKER_RISK_STAGES:
        return StrategyCapitalVerdict(
            allowed=False,
            contract_valid=True,
            strategy_ref=request.strategy_ref,
            authority_id=authority.authority_id,
            authority_digest=persisted_digest,
            stage=authority.stage,
            evaluated_at=evaluated_at,
            reason_codes=_clean_reason_values(reasons),
        )
    reasons.extend(
        _authority_evidence_reasons(
            authority,
            request,
            evaluated_at=evaluated_at,
        )
    )
    reasons.extend(_authority_account_reasons(authority, request))
    reasons.extend(_authority_limit_reasons(authority, request))
    reasons.extend(_authority_time_reasons(authority, evaluated_at=evaluated_at))

    normalized_reasons = _clean_reason_values(reasons)
    return StrategyCapitalVerdict(
        allowed=not normalized_reasons,
        contract_valid=True,
        strategy_ref=request.strategy_ref,
        authority_id=authority.authority_id,
        authority_digest=persisted_digest,
        stage=authority.stage,
        evaluated_at=evaluated_at,
        reason_codes=normalized_reasons,
    )


@dataclass(frozen=True)
class ProjectedCapitalExposure:
    gross_notional: Decimal
    net_notional: Decimal


def _decimal_value(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def project_post_order_exposure(
    *,
    positions: Sequence[Mapping[str, object]],
    symbol: str,
    side: str,
    order_notional: Decimal,
) -> tuple[ProjectedCapitalExposure | None, tuple[str, ...]]:
    if not order_notional.is_finite() or order_notional <= 0:
        return None, ("authority_order_notional_unavailable",)
    normalized_symbol = symbol.strip().upper()
    if not normalized_symbol or side not in {"buy", "sell"}:
        return None, ("authority_order_identity_invalid",)

    exposures: dict[str, Decimal] = {}
    for position in positions:
        position_symbol = str(position.get("symbol") or "").strip().upper()
        if not position_symbol:
            return None, ("authority_position_symbol_missing",)
        qty = _decimal_value(position.get("qty") or position.get("quantity"))
        position_side = str(position.get("side") or "").strip().lower()
        if position_side not in {"long", "short"}:
            if qty is None or qty == 0:
                return None, ("authority_position_side_missing",)
            position_side = "short" if qty < 0 else "long"
        market_value = _decimal_value(position.get("market_value"))
        if market_value is None:
            price = _decimal_value(position.get("current_price"))
            if qty is None or price is None:
                return None, ("authority_position_market_value_missing",)
            market_value = qty * price
        signed_value = (
            -abs(market_value) if position_side == "short" else abs(market_value)
        )
        exposures[position_symbol] = (
            exposures.get(position_symbol, Decimal("0")) + signed_value
        )

    delta = order_notional if side == "buy" else -order_notional
    exposures[normalized_symbol] = (
        exposures.get(normalized_symbol, Decimal("0")) + delta
    )
    return (
        ProjectedCapitalExposure(
            gross_notional=sum(
                (abs(value) for value in exposures.values()), Decimal("0")
            ),
            net_notional=abs(sum(exposures.values(), Decimal("0"))),
        ),
        (),
    )


__all__ = (
    "BROKER_RISK_STAGES",
    "STRATEGY_CAPITAL_AUTHORITY_SCHEMA_VERSION",
    "STRATEGY_CAPITAL_AUTHORITY_STATUS_SCHEMA_VERSION",
    "AuthorityProofBindings",
    "CapitalAccountMode",
    "CapitalSessionWindow",
    "CapitalStage",
    "CapitalVenue",
    "ProjectedCapitalExposure",
    "StrategyCapitalAuthority",
    "StrategyCapitalRequest",
    "StrategyCapitalVerdict",
    "canonical_payload_digest",
    "evaluate_strategy_capital_authority",
    "project_post_order_exposure",
    "quarantined_strategy_capital_authority",
    "required_evidence_epoch_decision",
    "runtime_artifact_binding_reasons",
    "validate_strategy_capital_authority",
)
