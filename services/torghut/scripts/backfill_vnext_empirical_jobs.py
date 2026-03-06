#!/usr/bin/env python3
"""Backfill empirical job rows from historical promotion evidence bundles."""

from __future__ import annotations

import argparse
import json
from typing import Any, Mapping

from sqlalchemy import select

from app.db import SessionLocal
from app.models import ResearchCandidate, ResearchPromotion
from app.trading.empirical_jobs import upsert_empirical_job_run


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Backfill vNext empirical job rows from legacy promotion evidence.",
    )
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _as_dict(value: Any) -> dict[str, Any]:
    return {str(key): item for key, item in value.items()} if isinstance(value, Mapping) else {}


def _as_job(
    *,
    session: Any,
    candidate_id: str,
    run_id: str,
    job_type: str,
    artifact_refs: list[str],
    payload: Mapping[str, object],
    authority_payload: Mapping[str, object],
) -> None:
    authority = "empirical" if bool(authority_payload.get("authoritative")) else "blocked"
    upsert_empirical_job_run(
        session=session,
        run_id=run_id,
        candidate_id=candidate_id,
        job_name=job_type.replace("_", " "),
        job_type=job_type,
        job_run_id=f"legacy:{candidate_id}:{job_type}",
        status="legacy_backfill",
        authority=authority,
        promotion_authority_eligible=bool(authority_payload.get("authoritative")),
        dataset_snapshot_ref=None,
        artifact_refs=artifact_refs,
        payload=dict(payload),
    )


def main() -> int:
    args = _parse_args()
    inserted = 0
    with SessionLocal() as session:
        promotions = session.execute(
            select(ResearchPromotion).order_by(ResearchPromotion.created_at.desc()).limit(max(args.limit, 1))
        ).scalars()
        for promotion in promotions:
            candidate_id = str(promotion.candidate_id or "").strip()
            if not candidate_id:
                continue
            candidate = session.execute(
                select(ResearchCandidate).where(ResearchCandidate.candidate_id == candidate_id)
            ).scalar_one_or_none()
            run_id = str(candidate.run_id if candidate is not None else "").strip() or f"legacy-{candidate_id}"
            evidence_bundle = _as_dict(promotion.evidence_bundle)
            promotion_authority = _as_dict(evidence_bundle.get("promotion_evidence_authority"))
            promotion_evidence = _as_dict(evidence_bundle.get("promotion_evidence"))

            benchmark = _as_dict(promotion_evidence.get("benchmark_parity"))
            if benchmark:
                _as_job(
                    session=session,
                    candidate_id=candidate_id,
                    run_id=run_id,
                    job_type="benchmark_parity",
                    artifact_refs=[str(benchmark.get("artifact_ref") or "").strip()],
                    payload=benchmark,
                    authority_payload=_as_dict(promotion_authority.get("benchmark_parity")),
                )
                inserted += 1

            foundation = _as_dict(promotion_evidence.get("foundation_router_parity"))
            if foundation:
                _as_job(
                    session=session,
                    candidate_id=candidate_id,
                    run_id=run_id,
                    job_type="foundation_router_parity",
                    artifact_refs=[str(foundation.get("artifact_ref") or "").strip()],
                    payload=foundation,
                    authority_payload=_as_dict(promotion_authority.get("foundation_router_parity")),
                )
                inserted += 1

            janus = _as_dict(promotion_evidence.get("janus_q"))
            if janus:
                artifact_refs = []
                event_car = _as_dict(janus.get("event_car"))
                hgrm_reward = _as_dict(janus.get("hgrm_reward"))
                event_ref = str(event_car.get("artifact_ref") or "").strip()
                reward_ref = str(hgrm_reward.get("artifact_ref") or "").strip()
                if event_ref:
                    artifact_refs.append(event_ref)
                if reward_ref:
                    artifact_refs.append(reward_ref)
                if artifact_refs:
                    _as_job(
                        session=session,
                        candidate_id=candidate_id,
                        run_id=run_id,
                        job_type="janus_event_car",
                        artifact_refs=artifact_refs,
                        payload=event_car or janus,
                        authority_payload=_as_dict(promotion_authority.get("janus_q")),
                    )
                    _as_job(
                        session=session,
                        candidate_id=candidate_id,
                        run_id=run_id,
                        job_type="janus_hgrm_reward",
                        artifact_refs=artifact_refs,
                        payload=hgrm_reward or janus,
                        authority_payload=_as_dict(promotion_authority.get("janus_q")),
                    )
                    inserted += 2
        session.commit()
    payload = {"status": "ok", "inserted_or_updated": inserted}
    print(json.dumps(payload, separators=(",", ":")) if args.json else json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
