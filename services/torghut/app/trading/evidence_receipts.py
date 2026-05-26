"""Evidence receipt builders for cross-plane Torghut promotion gates."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal, cast

ReceiptState = Literal["pass", "warn", "stale", "timeout", "missing", "fail", "unknown"]

_DEFAULT_TTL_SECONDS = 600


def _empty_payload() -> dict[str, object]:
    return {}


@dataclass(frozen=True)
class EvidenceReceipt:
    receipt_id: str
    receipt_type: str
    producer: str
    subject_ref: str
    state: ReceiptState
    observed_at: datetime
    fresh_until: datetime
    reason_codes: tuple[str, ...] = ()
    decision: str | None = None
    payload: Mapping[str, object] = field(default_factory=_empty_payload)
    consumer_refs: tuple[str, ...] = ()

    def to_payload(self) -> dict[str, object]:
        return {
            "receipt_id": self.receipt_id,
            "receipt_type": self.receipt_type,
            "producer": self.producer,
            "subject_ref": self.subject_ref,
            "state": self.state,
            "decision": self.decision,
            "observed_at": _datetime_iso(self.observed_at),
            "fresh_until": _datetime_iso(self.fresh_until),
            "reason_codes": list(self.reason_codes),
            "consumer_refs": list(self.consumer_refs),
            "payload": dict(self.payload),
        }


def _datetime_iso(value: datetime) -> str:
    return _ensure_aware(value).isoformat()


def _ensure_aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        return _datetime_iso(value)
    if isinstance(value, Decimal):
        return _decimal_string(value)
    return str(value)


def _payload_hash(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        dict(payload),
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _receipt_id(
    *,
    receipt_type: str,
    subject_ref: str,
    observed_at: datetime,
    payload: Mapping[str, object],
) -> str:
    digest = _payload_hash(
        {
            "receipt_type": receipt_type,
            "subject_ref": subject_ref,
            "observed_at": _datetime_iso(observed_at),
            "payload": dict(payload),
        }
    )
    return f"ter-{digest[:32]}"


def _string(value: object) -> str:
    return str(value or "").strip()


def _string_list(value: object) -> tuple[str, ...]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        return ()
    return tuple(
        item for raw in cast(Sequence[object], value) if (item := _string(raw))
    )


def _decimal_string(value: Decimal) -> str:
    rendered = format(value, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered or "0"


def _dedupe_reasons(reasons: Sequence[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(reason for reason in reasons if reason.strip()))


def _fresh_until(
    *,
    observed_at: datetime,
    ttl_seconds: int,
    state: ReceiptState,
) -> datetime:
    if state in {"pass", "warn"}:
        return observed_at + timedelta(seconds=max(ttl_seconds, 1))
    return observed_at


def _receipt(
    *,
    receipt_type: str,
    producer: str,
    subject_ref: str,
    state: ReceiptState,
    observed_at: datetime,
    reason_codes: Sequence[str],
    payload: Mapping[str, object],
    decision: str | None = None,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
    consumer_refs: Sequence[str] = (),
) -> EvidenceReceipt:
    observed = _ensure_aware(observed_at)
    normalized_payload = dict(payload)
    return EvidenceReceipt(
        receipt_id=_receipt_id(
            receipt_type=receipt_type,
            subject_ref=subject_ref,
            observed_at=observed,
            payload=normalized_payload,
        ),
        receipt_type=receipt_type,
        producer=producer,
        subject_ref=subject_ref,
        state=state,
        observed_at=observed,
        fresh_until=_fresh_until(
            observed_at=observed,
            ttl_seconds=ttl_seconds,
            state=state,
        ),
        reason_codes=_dedupe_reasons(reason_codes),
        decision=decision,
        payload=normalized_payload,
        consumer_refs=tuple(
            str(item).strip() for item in consumer_refs if str(item).strip()
        ),
    )


def build_jangar_authority_receipt(
    *,
    quorum_payload: Mapping[str, object],
    observed_at: datetime | None = None,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    decision = _string(quorum_payload.get("decision")) or "unknown"
    reasons = list(_string_list(quorum_payload.get("reasons")))
    if decision == "allow":
        state: ReceiptState = "pass"
        reasons.append("jangar_dependency_quorum_allow")
    elif decision == "delay":
        state = "fail"
        reasons.append("jangar_dependency_quorum_delay")
    elif decision == "block":
        state = "fail"
        reasons.append("jangar_dependency_quorum_block")
    else:
        state = "missing"
        reasons.append("jangar_dependency_quorum_missing")

    return _receipt(
        receipt_type="jangar_authority",
        producer="jangar-control-plane",
        subject_ref="dependency_quorum",
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        decision=decision,
        payload=dict(quorum_payload),
        ttl_seconds=ttl_seconds,
        consumer_refs=("research", "paper", "canary", "live", "scale"),
    )


def build_service_health_receipt(
    *,
    role: str,
    liveness_ok: bool,
    readiness_ok: bool,
    observed_at: datetime | None = None,
    db_check_ok: bool | None = None,
    trading_status_ok: bool | None = None,
    image_digest: str | None = None,
    revision: str | None = None,
    timeout_reason_codes: Sequence[str] = (),
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    reasons = list(timeout_reason_codes)
    if timeout_reason_codes:
        state: ReceiptState = "timeout"
    elif not liveness_ok:
        state = "fail"
        reasons.append("service_liveness_failed")
    elif not readiness_ok:
        state = "fail"
        reasons.append("service_readiness_failed")
    elif db_check_ok is False:
        state = "fail"
        reasons.append("db_check_failed")
    elif trading_status_ok is False:
        state = "fail"
        reasons.append("trading_status_failed")
    else:
        state = "pass"
        reasons.append("service_health_pass")

    return _receipt(
        receipt_type="service_health",
        producer="torghut",
        subject_ref=role,
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        payload={
            "role": role,
            "liveness_ok": liveness_ok,
            "readiness_ok": readiness_ok,
            "db_check_ok": db_check_ok,
            "trading_status_ok": trading_status_ok,
            "image_digest": image_digest,
            "revision": revision,
            "timeout_reason_codes": list(timeout_reason_codes),
        },
        ttl_seconds=ttl_seconds,
        consumer_refs=("research", "paper", "canary", "live", "scale"),
    )


def build_schema_receipt(
    *,
    schema_current: bool,
    lineage_ready: bool,
    observed_at: datetime | None = None,
    schema_head_signature: str | None = None,
    reason_codes: Sequence[str] = (),
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    reasons = list(reason_codes)
    if not schema_current:
        state: ReceiptState = "fail"
        reasons.append("schema_not_current")
    elif not lineage_ready:
        state = "fail"
        reasons.append("schema_lineage_not_ready")
    else:
        state = "pass"
        reasons.append("schema_current")

    return _receipt(
        receipt_type="schema",
        producer="torghut",
        subject_ref="db_schema",
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        payload={
            "schema_current": schema_current,
            "schema_lineage_ready": lineage_ready,
            "schema_head_signature": schema_head_signature,
        },
        ttl_seconds=ttl_seconds,
        consumer_refs=("research", "paper", "canary", "live", "scale"),
    )


def build_data_freshness_receipt(
    *,
    source: str,
    fresh: bool,
    observed_at: datetime | None = None,
    as_of: datetime | None = None,
    max_age_seconds: int = _DEFAULT_TTL_SECONDS,
    reason_codes: Sequence[str] = (),
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    reasons = list(reason_codes)
    normalized_as_of = _ensure_aware(as_of) if as_of is not None else None
    if normalized_as_of is None:
        state: ReceiptState = "unknown"
        reasons.append("data_freshness_as_of_missing")
    elif observed - normalized_as_of > timedelta(seconds=max(max_age_seconds, 1)):
        state = "stale"
        reasons.append("data_freshness_stale")
    elif not fresh:
        state = "stale"
        reasons.append("data_freshness_failed")
    else:
        state = "pass"
        reasons.append("data_freshness_fresh")

    return _receipt(
        receipt_type="data_freshness",
        producer="torghut",
        subject_ref=source,
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        payload={
            "source": source,
            "fresh": fresh,
            "as_of": _datetime_iso(normalized_as_of)
            if normalized_as_of is not None
            else None,
            "max_age_seconds": max_age_seconds,
        },
        ttl_seconds=max_age_seconds,
        consumer_refs=("research", "paper", "canary", "live", "scale"),
    )


def build_empirical_jobs_receipt(
    *,
    empirical_status: Mapping[str, object],
    observed_at: datetime | None = None,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    stale_jobs = _string_list(empirical_status.get("stale_jobs"))
    missing_jobs = _string_list(empirical_status.get("missing_jobs"))
    ineligible_jobs = _string_list(empirical_status.get("ineligible_jobs"))
    blocked_reasons = _string_list(empirical_status.get("blocked_reasons"))
    if bool(empirical_status.get("ready")):
        state: ReceiptState = "pass"
        reasons = ["empirical_jobs_fresh"]
    elif stale_jobs:
        state = "stale"
        reasons = [
            "empirical_jobs_stale",
            *(f"empirical_job_stale:{job}" for job in stale_jobs),
        ]
    elif missing_jobs:
        state = "missing"
        reasons = [
            "empirical_jobs_missing",
            *(f"empirical_job_missing:{job}" for job in missing_jobs),
        ]
    else:
        state = "fail"
        reasons = [
            "empirical_jobs_ineligible",
            *(f"empirical_job_ineligible:{job}" for job in ineligible_jobs),
            *blocked_reasons,
        ]

    return _receipt(
        receipt_type="empirical_jobs",
        producer="torghut",
        subject_ref="vnext_empirical_job_runs",
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        payload=dict(empirical_status),
        ttl_seconds=ttl_seconds,
        consumer_refs=("research", "paper", "canary", "live", "scale"),
    )


def build_artifact_parity_receipt(
    *,
    consumer_ref: str,
    image_ref: str | None,
    required_platforms: Sequence[str],
    observed_platforms: Sequence[str],
    runtime_pull_failures: Sequence[str] = (),
    observed_at: datetime | None = None,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    required = tuple(platform for platform in required_platforms if platform.strip())
    observed_values = tuple(
        platform for platform in observed_platforms if platform.strip()
    )
    observed_set = set(observed_values)
    missing_platforms = tuple(
        platform for platform in required if platform not in observed_set
    )
    pull_failures = tuple(item for item in runtime_pull_failures if item.strip())
    reasons: list[str] = []
    if pull_failures:
        state: ReceiptState = "fail"
        decision = "fail_pull_observed"
        reasons.append("artifact_runtime_pull_failure")
    elif missing_platforms:
        state = "fail"
        decision = "fail_missing_required_platform"
        reasons.extend(
            f"artifact_required_platform_missing:{platform}"
            for platform in missing_platforms
        )
    elif not _string(image_ref):
        state = "missing"
        decision = "fail_manifest_unreadable"
        reasons.append("artifact_image_ref_missing")
    elif not required or not observed_values:
        state = "unknown"
        decision = "unknown_registry"
        reasons.append("artifact_platform_parity_unknown")
    else:
        state = "pass"
        decision = "pass"
        reasons.append("artifact_platform_parity_pass")

    return _receipt(
        receipt_type="artifact_parity",
        producer="torghut-gitops",
        subject_ref=consumer_ref,
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        decision=decision,
        payload={
            "consumer_ref": consumer_ref,
            "image_ref": image_ref,
            "required_platforms": list(required),
            "observed_platforms": list(observed_values),
            "missing_platforms": list(missing_platforms),
            "runtime_pull_failures": list(pull_failures),
        },
        ttl_seconds=ttl_seconds,
        consumer_refs=("research", "paper", "canary", "live", "scale"),
    )


def build_portfolio_proof_receipt(
    *,
    portfolio_candidate_id: str,
    target_net_pnl_per_day: Decimal,
    post_cost_net_pnl_per_day: Decimal,
    holdout_result: Mapping[str, object] | None,
    runtime_closure_artifact_refs: Sequence[str],
    contribution: Mapping[str, object] | None = None,
    runtime_ledger_summary: Mapping[str, object] | None = None,
    require_runtime_ledger_summary: bool = False,
    observed_at: datetime | None = None,
    ttl_seconds: int = _DEFAULT_TTL_SECONDS,
) -> EvidenceReceipt:
    observed = observed_at or datetime.now(timezone.utc)
    holdout = dict(holdout_result or {})
    holdout_status = _string(holdout.get("status"))
    refs = tuple(item for item in runtime_closure_artifact_refs if item.strip())
    ledger_summary = dict(runtime_ledger_summary or {})
    reasons: list[str] = []
    if require_runtime_ledger_summary and not ledger_summary:
        state: ReceiptState = "missing"
        reasons.append("portfolio_runtime_ledger_summary_missing")
    elif (
        require_runtime_ledger_summary
        and int(Decimal(str(ledger_summary.get("evidence_grade_bucket_count") or "0")))
        <= 0
    ):
        state = "fail"
        reasons.append("portfolio_runtime_ledger_summary_not_evidence_grade")
    elif not _string(portfolio_candidate_id):
        state: ReceiptState = "missing"
        reasons.append("portfolio_proof_missing")
    elif post_cost_net_pnl_per_day < target_net_pnl_per_day:
        state = "fail"
        reasons.append("portfolio_proof_below_target")
    elif not holdout:
        state = "fail"
        reasons.append("portfolio_holdout_missing")
    elif holdout_status not in {"pass", "passed", "within_budget"}:
        state = "fail"
        reasons.append("portfolio_holdout_failed")
    elif not refs:
        state = "fail"
        reasons.append("portfolio_runtime_closure_refs_missing")
    else:
        state = "pass"
        reasons.append("portfolio_proof_pass")

    return _receipt(
        receipt_type="portfolio_proof",
        producer="torghut-runtime-closure",
        subject_ref=portfolio_candidate_id or "missing",
        state=state,
        observed_at=observed,
        reason_codes=reasons,
        payload={
            "portfolio_candidate_id": portfolio_candidate_id,
            "target_net_pnl_per_day": _decimal_string(target_net_pnl_per_day),
            "post_cost_net_pnl_per_day": _decimal_string(post_cost_net_pnl_per_day),
            "holdout_result": holdout,
            "runtime_closure_artifact_refs": list(refs),
            "contribution": dict(contribution or {}),
            "runtime_ledger_summary": ledger_summary,
            "require_runtime_ledger_summary": require_runtime_ledger_summary,
        },
        ttl_seconds=ttl_seconds,
        consumer_refs=("paper", "canary", "live", "scale"),
    )


__all__ = [
    "EvidenceReceipt",
    "ReceiptState",
    "build_artifact_parity_receipt",
    "build_data_freshness_receipt",
    "build_empirical_jobs_receipt",
    "build_jangar_authority_receipt",
    "build_portfolio_proof_receipt",
    "build_schema_receipt",
    "build_service_health_receipt",
]
