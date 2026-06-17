"""Canonical promotion authority state for Torghut trading targets."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


PROMOTION_AUTHORITY_SCHEMA_VERSION = "torghut.promotion-authority.v1"


class PromotionStage(StrEnum):
    SOURCE_COLLECTION = "source_collection"
    PAPER_PROBATION = "paper_probation"
    CAPITAL_BLOCKED = "capital_blocked"
    CAPITAL_ALLOWED = "capital_allowed"


@dataclass(frozen=True)
class PromotionAuthority:
    stage: PromotionStage
    capital_promotion_allowed: bool
    blockers: tuple[str, ...] = ()
    source_collection_authorized: bool = False
    paper_probation_authorized: bool = False
    bounded_live_paper_collection_authorized: bool = False
    evidence_collection_ok: bool = False

    @property
    def final_authority_ok(self) -> bool:
        return self.capital_promotion_allowed and not self.blockers

    def as_target_fields(self) -> dict[str, object]:
        capital_allowed = self.final_authority_ok
        blockers = list(dict.fromkeys(self.blockers))
        return {
            "promotion_authority_schema_version": PROMOTION_AUTHORITY_SCHEMA_VERSION,
            "promotion_stage": self.stage.value,
            "source_collection_authorized": self.source_collection_authorized,
            "paper_probation_authorized": self.paper_probation_authorized,
            "bounded_live_paper_collection_authorized": (
                self.bounded_live_paper_collection_authorized
            ),
            "evidence_collection_ok": self.evidence_collection_ok,
            "capital_promotion_allowed": capital_allowed,
            "final_authority_ok": capital_allowed,
            "promotion_blockers": blockers,
            "final_promotion_blockers": blockers,
            "runtime_ledger_target_metadata_blockers": blockers,
            "promotion_allowed": capital_allowed,
            "final_promotion_allowed": capital_allowed,
            "final_promotion_authorized": capital_allowed,
        }


def _blockers(values: Sequence[str] | None) -> tuple[str, ...]:
    if values is None:
        return ()
    return tuple(str(value).strip() for value in values if str(value).strip())


def source_collection_authority(
    *,
    blockers: Sequence[str] | None,
    bounded_live_paper_collection_authorized: bool = True,
) -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.SOURCE_COLLECTION,
        capital_promotion_allowed=False,
        blockers=_blockers(blockers),
        source_collection_authorized=True,
        bounded_live_paper_collection_authorized=bounded_live_paper_collection_authorized,
        evidence_collection_ok=True,
    )


def paper_probation_authority(
    *,
    blockers: Sequence[str] | None,
    bounded_live_paper_collection_authorized: bool = True,
) -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.PAPER_PROBATION,
        capital_promotion_allowed=False,
        blockers=_blockers(blockers),
        paper_probation_authorized=True,
        bounded_live_paper_collection_authorized=bounded_live_paper_collection_authorized,
        evidence_collection_ok=True,
    )


def capital_blocked_authority(
    *,
    blockers: Sequence[str] | None,
) -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.CAPITAL_BLOCKED,
        capital_promotion_allowed=False,
        blockers=_blockers(blockers),
    )


def capital_allowed_authority() -> PromotionAuthority:
    return PromotionAuthority(
        stage=PromotionStage.CAPITAL_ALLOWED,
        capital_promotion_allowed=True,
        blockers=(),
    )


def target_capital_promotion_allowed(target: Mapping[str, Any]) -> bool:
    return target.get("capital_promotion_allowed") is True


def target_promotion_stage(target: Mapping[str, Any]) -> PromotionStage:
    raw = str(target.get("promotion_stage") or "").strip()
    try:
        return PromotionStage(raw)
    except ValueError:
        if target_capital_promotion_allowed(target):
            return PromotionStage.CAPITAL_ALLOWED
        if bool(target.get("source_collection_authorized")):
            return PromotionStage.SOURCE_COLLECTION
        if bool(target.get("paper_probation_authorized")):
            return PromotionStage.PAPER_PROBATION
        return PromotionStage.CAPITAL_BLOCKED
