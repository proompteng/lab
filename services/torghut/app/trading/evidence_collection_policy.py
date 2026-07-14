"""Evidence admissibility policy with no broker or capital authority."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum


EVIDENCE_COLLECTION_POLICY_SCHEMA_VERSION = "torghut.evidence-collection-policy.v1"


class EvidenceCollectionStage(StrEnum):
    SOURCE_COLLECTION = "source_collection"
    PAPER_PROBATION = "paper_probation"
    COLLECTION_BLOCKED = "collection_blocked"
    EVIDENCE_ADMISSIBLE = "evidence_admissible"


@dataclass(frozen=True)
class EvidenceCollectionPolicy:
    stage: EvidenceCollectionStage
    evidence_admissible: bool
    blockers: tuple[str, ...] = ()
    source_collection_authorized: bool = False
    paper_probation_authorized: bool = False
    bounded_live_paper_collection_authorized: bool = False
    evidence_collection_ok: bool = False

    def as_target_fields(self) -> dict[str, object]:
        blockers = list(dict.fromkeys(self.blockers))
        admissible = self.evidence_admissible and not blockers
        capital_blockers = list(
            dict.fromkeys([*blockers, "strategy_capital_authority_required"])
        )
        return {
            "evidence_collection_policy_schema_version": (
                EVIDENCE_COLLECTION_POLICY_SCHEMA_VERSION
            ),
            "evidence_collection_stage": self.stage.value,
            "evidence_admissible": admissible,
            "source_collection_authorized": self.source_collection_authorized,
            "paper_probation_authorized": self.paper_probation_authorized,
            "bounded_live_paper_collection_authorized": (
                self.bounded_live_paper_collection_authorized
            ),
            "evidence_collection_ok": self.evidence_collection_ok,
            "evidence_collection_blockers": blockers,
            "strategy_capital_authority_allowed": False,
            "strategy_capital_authority_blockers": capital_blockers,
            # Read-only compatibility fields. Evidence can never authorize capital.
            "promotion_stage": self.stage.value,
            "capital_promotion_allowed": False,
            "final_authority_ok": False,
            "promotion_blockers": capital_blockers,
            "final_promotion_blockers": capital_blockers,
            # This field drives evidence admissibility and must not ingest a
            # capital-only blocker.
            "runtime_ledger_target_metadata_blockers": blockers,
            "promotion_allowed": False,
            "final_promotion_allowed": False,
            "final_promotion_authorized": False,
        }


def _blockers(values: Sequence[str] | None) -> tuple[str, ...]:
    if values is None:
        return ()
    return tuple(
        dict.fromkeys(str(value).strip() for value in values if str(value).strip())
    )


def source_collection_policy(
    *,
    blockers: Sequence[str] | None,
    bounded_live_paper_collection_authorized: bool = True,
) -> EvidenceCollectionPolicy:
    return EvidenceCollectionPolicy(
        stage=EvidenceCollectionStage.SOURCE_COLLECTION,
        evidence_admissible=False,
        blockers=_blockers(blockers),
        source_collection_authorized=True,
        bounded_live_paper_collection_authorized=bounded_live_paper_collection_authorized,
        evidence_collection_ok=True,
    )


def paper_probation_policy(
    *,
    blockers: Sequence[str] | None,
    bounded_live_paper_collection_authorized: bool = True,
) -> EvidenceCollectionPolicy:
    return EvidenceCollectionPolicy(
        stage=EvidenceCollectionStage.PAPER_PROBATION,
        evidence_admissible=False,
        blockers=_blockers(blockers),
        paper_probation_authorized=True,
        bounded_live_paper_collection_authorized=bounded_live_paper_collection_authorized,
        evidence_collection_ok=True,
    )


def collection_blocked_policy(
    *,
    blockers: Sequence[str] | None,
) -> EvidenceCollectionPolicy:
    return EvidenceCollectionPolicy(
        stage=EvidenceCollectionStage.COLLECTION_BLOCKED,
        evidence_admissible=False,
        blockers=_blockers(blockers),
    )


def evidence_admissibility_policy(
    *,
    blockers: Sequence[str] | None,
) -> EvidenceCollectionPolicy:
    normalized_blockers = _blockers(blockers)
    return EvidenceCollectionPolicy(
        stage=(
            EvidenceCollectionStage.COLLECTION_BLOCKED
            if normalized_blockers
            else EvidenceCollectionStage.EVIDENCE_ADMISSIBLE
        ),
        evidence_admissible=not normalized_blockers,
        blockers=normalized_blockers,
        evidence_collection_ok=not normalized_blockers,
    )


def target_evidence_admissible(target: Mapping[str, object]) -> bool:
    return target.get("evidence_admissible") is True


def target_evidence_collection_stage(
    target: Mapping[str, object],
) -> EvidenceCollectionStage:
    raw = str(target.get("evidence_collection_stage") or "").strip()
    try:
        return EvidenceCollectionStage(raw)
    except ValueError:
        if target_evidence_admissible(target):
            return EvidenceCollectionStage.EVIDENCE_ADMISSIBLE
        if bool(target.get("source_collection_authorized")):
            return EvidenceCollectionStage.SOURCE_COLLECTION
        if bool(target.get("paper_probation_authorized")):
            return EvidenceCollectionStage.PAPER_PROBATION
        return EvidenceCollectionStage.COLLECTION_BLOCKED


__all__ = (
    "EVIDENCE_COLLECTION_POLICY_SCHEMA_VERSION",
    "EvidenceCollectionPolicy",
    "EvidenceCollectionStage",
    "collection_blocked_policy",
    "evidence_admissibility_policy",
    "paper_probation_policy",
    "source_collection_policy",
    "target_evidence_admissible",
    "target_evidence_collection_stage",
)
