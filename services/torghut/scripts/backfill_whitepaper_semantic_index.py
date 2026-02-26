#!/usr/bin/env python3
"""Backfill semantic chunks/embeddings for existing whitepaper runs."""

from __future__ import annotations

import argparse
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.models import WhitepaperAnalysisRun
from app.whitepapers.workflow import WhitepaperWorkflowService


def _parse_statuses(raw: str) -> list[str]:
    values = [item.strip() for item in raw.split(",")]
    return [item for item in values if item]


def _list_candidate_run_ids(
    session: Session,
    *,
    statuses: list[str],
    limit: int,
) -> list[str]:
    status_params = {f"status_{index}": value for index, value in enumerate(statuses)}
    placeholders = ", ".join(f":status_{index}" for index in range(len(statuses)))
    rows = session.execute(
        text(
            f"""
            SELECT r.run_id
            FROM whitepaper_analysis_runs r
            WHERE r.status IN ({placeholders})
              AND NOT EXISTS (
                SELECT 1
                FROM whitepaper_semantic_chunks sc
                WHERE sc.analysis_run_id = r.id
              )
            ORDER BY r.created_at ASC
            LIMIT :limit
            """
        ),
        {**status_params, "limit": limit},
    ).all()
    return [str(row[0]) for row in rows]


def _load_or_extract_full_text(
    workflow: WhitepaperWorkflowService,
    session: Session,
    *,
    run: WhitepaperAnalysisRun,
) -> str:
    version = run.document_version
    if version is None:
        return ""
    if version.content is not None and version.content.full_text:
        return str(version.content.full_text)

    context = dict(run.orchestration_context_json or {})
    attachment_url = str(context.get("attachment_url") or "").strip()
    if not attachment_url:
        return ""

    pdf_bytes = workflow._download_pdf(attachment_url)
    extracted = workflow._extract_pdf_text(pdf_bytes)
    full_text = str(extracted.get("full_text") or "")
    if full_text.strip():
        workflow._upsert_whitepaper_content(
            session,
            run=run,
            full_text=full_text,
            extraction_meta=dict(extracted.get("metadata") or {}),
        )
    return full_text


def _process_run(
    *,
    run_id: str,
    dry_run: bool,
) -> dict[str, Any]:
    workflow = WhitepaperWorkflowService()
    with SessionLocal() as session:
        run_row = session.execute(
            select(WhitepaperAnalysisRun).where(WhitepaperAnalysisRun.run_id == run_id)
        ).scalar_one_or_none()
        if run_row is None:
            return {"run_id": run_id, "status": "missing"}

        full_text = _load_or_extract_full_text(workflow, session, run=run_row)
        full_text_chunk_count = len(workflow._build_chunks(full_text, source_scope="full_text")) if full_text.strip() else 0

        synthesis_chunk_count = 0
        if run_row.synthesis is not None:
            candidate_sections: list[str] = []
            synthesis = run_row.synthesis
            for value in [
                synthesis.executive_summary,
                synthesis.problem_statement,
                synthesis.methodology_summary,
                synthesis.implementation_plan_md,
            ]:
                if value and value.strip():
                    candidate_sections.append(value.strip())
            for value in workflow._coerce_string_list(synthesis.key_findings_json):
                candidate_sections.append(value)
            for value in workflow._coerce_string_list(synthesis.novelty_claims_json):
                candidate_sections.append(value)
            synthesis_chunk_count = sum(len(workflow._build_chunks(section, source_scope="synthesis")) for section in candidate_sections)

        if dry_run:
            session.rollback()
            return {
                "run_id": run_id,
                "status": "dry_run",
                "full_text_chunks": full_text_chunk_count,
                "synthesis_chunks": synthesis_chunk_count,
            }

        indexed_full_text = {"indexed_chunks": 0}
        if full_text.strip():
            indexed_full_text = workflow.index_full_text_semantic_content(
                session,
                run_id=run_id,
                full_text=full_text,
            )

        indexed_synthesis = {"indexed_chunks": 0}
        if run_row.synthesis is not None:
            indexed_synthesis = workflow.index_synthesis_semantic_content(
                session,
                run_id=run_id,
            )

        session.commit()
        return {
            "run_id": run_id,
            "status": "indexed",
            "full_text_chunks": int(indexed_full_text.get("indexed_chunks") or 0),
            "synthesis_chunks": int(indexed_synthesis.get("indexed_chunks") or 0),
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill semantic chunks/embeddings for whitepaper runs.")
    parser.add_argument(
        "--statuses",
        type=str,
        default="completed,agentrun_dispatched",
        help="Comma-separated run statuses to include when listing candidates.",
    )
    parser.add_argument(
        "--run-id",
        action="append",
        default=[],
        help="Specific run id(s) to process. Can be passed multiple times.",
    )
    parser.add_argument("--limit", type=int, default=200, help="Max candidate runs to process.")
    parser.add_argument("--concurrency", type=int, default=2, help="Worker concurrency.")
    parser.add_argument("--dry-run", action="store_true", help="Preview candidates and chunk counts without writing.")
    args = parser.parse_args()

    statuses = _parse_statuses(args.statuses)
    if not statuses:
        raise SystemExit("at least one status is required")

    selected_run_ids = [str(item).strip() for item in args.run_id if str(item).strip()]
    if selected_run_ids:
        run_ids = selected_run_ids
    else:
        with SessionLocal() as session:
            run_ids = _list_candidate_run_ids(
                session,
                statuses=statuses,
                limit=max(1, min(int(args.limit), 5000)),
            )

    started_at = datetime.now(timezone.utc)
    if not run_ids:
        report = {
            "mode": "dry_run" if args.dry_run else "apply",
            "started_at": started_at.isoformat(),
            "statuses": statuses,
            "candidates": 0,
            "results": [],
        }
        print(json.dumps(report, indent=2))
        return 0

    results: list[dict[str, Any]] = []
    max_workers = max(1, min(int(args.concurrency), 16))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = [
            executor.submit(
                _process_run,
                run_id=run_id,
                dry_run=bool(args.dry_run),
            )
            for run_id in run_ids
        ]
        for future in as_completed(futures):
            try:
                results.append(future.result())
            except Exception as exc:
                results.append({"status": "failed", "error": str(exc)})

    ended_at = datetime.now(timezone.utc)
    report = {
        "mode": "dry_run" if args.dry_run else "apply",
        "started_at": started_at.isoformat(),
        "ended_at": ended_at.isoformat(),
        "statuses": statuses,
        "candidates": len(run_ids),
        "processed": len(results),
        "succeeded": len([item for item in results if item.get("status") in {"indexed", "dry_run"}]),
        "failed": len([item for item in results if item.get("status") == "failed"]),
        "results": results,
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
