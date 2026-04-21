#!/usr/bin/env python3
"""Compile whitepaper claim rows into hypothesis cards."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from sqlalchemy import select

from app.db import SessionLocal
from app.models import WhitepaperAnalysisRun
from app.whitepapers.claim_compiler import (
    RECENT_WHITEPAPER_SEEDS,
    WhitepaperResearchSource,
    compile_sources_to_hypothesis_cards,
)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compile whitepaper research sources into hypothesis cards."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("hypothesis-cards.jsonl"),
        help="JSONL output for compiled hypothesis cards.",
    )
    parser.add_argument("--paper-run-id", action="append", default=[])
    parser.add_argument("--seed-recent-whitepapers", action="store_true")
    parser.add_argument(
        "--sources-output",
        type=Path,
        default=None,
        help="Optional JSONL output for normalized whitepaper claim sources.",
    )
    return parser.parse_args()


def _mapping(value: Any) -> dict[str, Any]:
    return (
        {str(key): item for key, item in cast(Mapping[Any, Any], value).items()}
        if isinstance(value, Mapping)
        else {}
    )


def _load_sources_from_db(
    paper_run_ids: Sequence[str],
) -> list[WhitepaperResearchSource]:
    run_id_set = {item.strip() for item in paper_run_ids if item.strip()}
    if not run_id_set:
        return []
    with SessionLocal() as session:
        rows = list(
            session.execute(
                select(WhitepaperAnalysisRun).where(
                    WhitepaperAnalysisRun.run_id.in_(run_id_set),
                    WhitepaperAnalysisRun.status == "completed",
                )
            ).scalars()
        )
        sources: list[WhitepaperResearchSource] = []
        for row in rows:
            claims = [
                {
                    "claim_id": claim.claim_id,
                    "claim_type": claim.claim_type,
                    "claim_text": claim.claim_text,
                    "asset_scope": claim.asset_scope,
                    "horizon_scope": claim.horizon_scope,
                    "data_requirements": claim.data_requirements_json,
                    "expected_direction": claim.expected_direction,
                    "required_activity_conditions": claim.required_activity_conditions_json,
                    "liquidity_constraints": claim.liquidity_constraints_json,
                    "validation_notes": claim.validation_notes,
                    "confidence": str(claim.confidence)
                    if claim.confidence is not None
                    else None,
                    "metadata": claim.metadata_json,
                }
                for claim in row.claims
            ]
            relations = [
                {
                    "relation_id": relation.relation_id,
                    "relation_type": relation.relation_type,
                    "source_claim_id": relation.source_claim_id,
                    "target_claim_id": relation.target_claim_id,
                    "target_run_id": relation.target_run_id,
                    "rationale": relation.rationale,
                    "confidence": str(relation.confidence)
                    if relation.confidence is not None
                    else None,
                    "metadata": relation.metadata_json,
                }
                for relation in row.claim_relations
            ]
            document_metadata = _mapping(row.document.metadata_json)
            sources.append(
                WhitepaperResearchSource(
                    run_id=row.run_id,
                    title=row.document.title or row.run_id,
                    source_url=str(document_metadata.get("source_url") or ""),
                    published_at=str(row.document.published_at or ""),
                    claims=tuple(claims),
                    claim_relations=tuple(relations),
                )
            )
        return sources


def _write_jsonl(path: Path, rows: Sequence[Mapping[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(row, sort_keys=True) for row in rows)
        + ("\n" if rows else ""),
        encoding="utf-8",
    )


def main() -> int:
    args = _parse_args()
    sources: list[WhitepaperResearchSource] = []
    if args.seed_recent_whitepapers:
        sources.extend(RECENT_WHITEPAPER_SEEDS)
    sources.extend(_load_sources_from_db(args.paper_run_id))
    cards = compile_sources_to_hypothesis_cards(sources)
    _write_jsonl(args.output, [card.to_payload() for card in cards])
    if args.sources_output is not None:
        _write_jsonl(
            args.sources_output,
            [source.to_payload() for source in sources],
        )
    print(
        json.dumps(
            {
                "status": "ok",
                "source_count": len(sources),
                "claim_count": sum(len(source.claims) for source in sources),
                "claim_relation_count": sum(
                    len(source.claim_relations) for source in sources
                ),
                "count": len(cards),
                "output": str(args.output),
                "sources_output": str(args.sources_output)
                if args.sources_output is not None
                else None,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
