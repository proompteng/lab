# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Whitepaper workflow ingestion, orchestration, and persistence helpers."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
from subprocess import CalledProcessError, run
from typing import Any, Mapping, cast
from urllib.parse import quote, urljoin, urlparse

import inngest
from sqlalchemy import case, delete, func, select, text
from sqlalchemy.orm import Session

from ...models import (
    VNextExperimentSpec,
    WhitepaperAnalysisRun,
    WhitepaperAnalysisStep,
    WhitepaperArtifact,
    WhitepaperClaim,
    WhitepaperClaimRelation,
    WhitepaperContradictionEvent,
    WhitepaperCodexAgentRun,
    WhitepaperContent,
    WhitepaperDesignPullRequest,
    WhitepaperDocument,
    WhitepaperDocumentVersion,
    WhitepaperEngineeringTrigger,
    WhitepaperExperimentSpec,
    WhitepaperRolloutTransition,
    WhitepaperStrategyTemplate,
    WhitepaperSynthesis,
    WhitepaperViabilityVerdict,
    coerce_json_payload,
)
from ...trading.discovery.whitepaper_candidate_compiler import (
    compile_claim_payloads_to_whitepaper_experiments,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_54 import *
from .part_02_cephs3client import *
from .part_03_whitepaperworkflowservicemethodspart1 import *
from .part_04_whitepaperworkflowservicemethodspart2 import *


class _WhitepaperWorkflowServiceMethodsPart3:
    def search_semantic(
        self,
        session: Session,
        *,
        query: str,
        limit: int,
        offset: int,
        status: str,
        scope: str,
        subject: str | None,
    ) -> dict[str, Any]:
        clean_query = query.strip()
        if not clean_query:
            raise ValueError("query_required")

        semantic_limit = min(max(limit * 4, limit), 250)
        lexical_limit = min(max(limit * 4, limit), 250)
        embedding_model, embedding_dimension, query_embedding = self._embed_texts(
            [clean_query]
        )
        vector_text = self._vector_to_text(query_embedding[0])

        scope_filter = None if scope == "all" else scope
        status_filter = status.strip() if status.strip() else "completed"
        subject_filter = subject.strip() if subject else None
        lexical_query = clean_query

        semantic_rows = (
            session.execute(
                text(
                    """
                SELECT
                  sc.id::text AS chunk_id,
                  r.run_id AS run_id,
                  r.status AS run_status,
                  r.created_at AS run_created_at,
                  r.completed_at AS run_completed_at,
                  d.document_key AS document_key,
                  d.title AS document_title,
                  d.source_identifier AS source_identifier,
                  sc.source_scope AS source_scope,
                  sc.section_key AS section_key,
                  sc.chunk_index AS chunk_index,
                  sc.content AS content,
                  (se.embedding <=> CAST(:query_vector AS vector)) AS semantic_distance
                FROM whitepaper_semantic_embeddings se
                JOIN whitepaper_semantic_chunks sc ON sc.id = se.semantic_chunk_id
                JOIN whitepaper_analysis_runs r ON r.id = sc.analysis_run_id
                JOIN whitepaper_documents d ON d.id = r.document_id
                WHERE se.model = :embedding_model
                  AND se.dimension = :embedding_dimension
                  AND (CAST(:status_filter AS text) IS NULL OR r.status = CAST(:status_filter AS text))
                  AND (CAST(:scope_filter AS text) IS NULL OR sc.source_scope = CAST(:scope_filter AS text))
                  AND (CAST(:subject_filter AS text) IS NULL OR (d.metadata_json ->> 'subject') = CAST(:subject_filter AS text))
                ORDER BY se.embedding <=> CAST(:query_vector AS vector) ASC
                LIMIT :semantic_limit
                """
                ),
                {
                    "query_vector": vector_text,
                    "embedding_model": embedding_model,
                    "embedding_dimension": embedding_dimension,
                    "status_filter": status_filter,
                    "scope_filter": scope_filter,
                    "subject_filter": subject_filter,
                    "semantic_limit": semantic_limit,
                },
            )
            .mappings()
            .all()
        )

        lexical_rows = (
            session.execute(
                text(
                    """
                SELECT
                  sc.id::text AS chunk_id,
                  r.run_id AS run_id,
                  r.status AS run_status,
                  r.created_at AS run_created_at,
                  r.completed_at AS run_completed_at,
                  d.document_key AS document_key,
                  d.title AS document_title,
                  d.source_identifier AS source_identifier,
                  sc.source_scope AS source_scope,
                  sc.section_key AS section_key,
                  sc.chunk_index AS chunk_index,
                  sc.content AS content,
                  ts_rank_cd(
                    sc.text_tsvector,
                    websearch_to_tsquery('simple', :lexical_query)
                  ) AS lexical_score
                FROM whitepaper_semantic_chunks sc
                JOIN whitepaper_analysis_runs r ON r.id = sc.analysis_run_id
                JOIN whitepaper_documents d ON d.id = r.document_id
                WHERE (CAST(:status_filter AS text) IS NULL OR r.status = CAST(:status_filter AS text))
                  AND (CAST(:scope_filter AS text) IS NULL OR sc.source_scope = CAST(:scope_filter AS text))
                  AND (CAST(:subject_filter AS text) IS NULL OR (d.metadata_json ->> 'subject') = CAST(:subject_filter AS text))
                  AND sc.text_tsvector @@ websearch_to_tsquery('simple', :lexical_query)
                ORDER BY lexical_score DESC
                LIMIT :lexical_limit
                """
                ),
                {
                    "lexical_query": lexical_query,
                    "status_filter": status_filter,
                    "scope_filter": scope_filter,
                    "subject_filter": subject_filter,
                    "lexical_limit": lexical_limit,
                },
            )
            .mappings()
            .all()
        )

        semantic_rank: dict[str, int] = {}
        lexical_rank: dict[str, int] = {}
        merged: dict[str, dict[str, Any]] = {}

        for idx, row in enumerate(semantic_rows, start=1):
            chunk_id = str(row["chunk_id"])
            semantic_rank[chunk_id] = idx
            merged[chunk_id] = {
                **dict(row),
                "semantic_distance": float(row["semantic_distance"])
                if row["semantic_distance"] is not None
                else None,
                "lexical_score": None,
            }

        for idx, row in enumerate(lexical_rows, start=1):
            chunk_id = str(row["chunk_id"])
            lexical_rank[chunk_id] = idx
            entry = merged.get(chunk_id)
            lexical_score = (
                float(row["lexical_score"])
                if row["lexical_score"] is not None
                else None
            )
            if entry is None:
                merged[chunk_id] = {
                    **dict(row),
                    "semantic_distance": None,
                    "lexical_score": lexical_score,
                }
            else:
                entry["lexical_score"] = lexical_score

        best_semantic_distance = min(
            [
                d
                for d in [
                    cast(float | None, row.get("semantic_distance"))
                    for row in merged.values()
                ]
                if d is not None
            ],
            default=None,
        )
        semantic_ceiling = None
        if best_semantic_distance is not None:
            semantic_ceiling = min(
                _MAX_SEMANTIC_RELEVANT_DISTANCE,
                best_semantic_distance + _SEMANTIC_RELATIVE_DISTANCE_WINDOW,
            )

        ranked: list[dict[str, Any]] = []
        for chunk_id, row in merged.items():
            sem_rank = semantic_rank.get(chunk_id)
            lex_rank = lexical_rank.get(chunk_id)
            hybrid_score = 0.0
            if sem_rank is not None:
                hybrid_score += 1.0 / (60.0 + sem_rank)
            if lex_rank is not None:
                hybrid_score += 1.0 / (60.0 + lex_rank)
            semantic_distance = cast(float | None, row.get("semantic_distance"))
            lexical_score = cast(float | None, row.get("lexical_score"))
            if semantic_distance is not None and semantic_ceiling is not None:
                if semantic_distance > semantic_ceiling and lexical_score is None:
                    continue
            row["hybrid_score"] = hybrid_score
            ranked.append(row)

        ranked.sort(
            key=lambda item: (
                -self._coerce_float(item.get("hybrid_score"), default=0.0),
                self._coerce_float(item.get("semantic_distance"), default=999.0),
                -self._coerce_float(item.get("lexical_score"), default=0.0),
            )
        )
        total = len(ranked)
        paged = ranked[offset : offset + limit]
        items = [
            {
                "run_id": str(item["run_id"]),
                "run_status": str(item["run_status"]),
                "run_created_at": item["run_created_at"],
                "run_completed_at": item["run_completed_at"],
                "document": {
                    "document_key": item["document_key"],
                    "title": item["document_title"],
                    "source_identifier": item["source_identifier"],
                },
                "chunk": {
                    "source_scope": item["source_scope"],
                    "section_key": item["section_key"],
                    "chunk_index": int(item["chunk_index"]),
                    "snippet": self._build_search_snippet(
                        str(item["content"]), clean_query
                    ),
                },
                "semantic_distance": item.get("semantic_distance"),
                "lexical_score": item.get("lexical_score"),
                "hybrid_score": item.get("hybrid_score"),
            }
            for item in paged
        ]

        return {
            "items": items,
            "total": total,
            "limit": limit,
            "offset": offset,
            "query": clean_query,
            "scope": scope,
            "status": status_filter,
            "subject": subject_filter,
        }

    @staticmethod
    def _coerce_string_list(value: Any) -> list[str]:
        if isinstance(value, list):
            result: list[str] = []
            for item in value:
                text = str(item).strip() if item is not None else ""
                if text:
                    result.append(text)
            return result
        if isinstance(value, str):
            text = value.strip()
            return [text] if text else []
        return []

    @staticmethod
    def _coerce_float(value: Any, *, default: float) -> float:
        if value is None:
            return default
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return default
            try:
                return float(text)
            except ValueError:
                return default
        return default

    def _coerce_tag_list(self, value: Any) -> list[str]:
        if isinstance(value, list):
            return _sorted_unique(
                [
                    _normalize_identifier(str(item))
                    for item in value
                    if item is not None and str(item).strip()
                ]
            )
        if isinstance(value, str):
            return parse_marker_tags(value)
        return []

    def _extract_pdf_text(self, pdf_bytes: bytes) -> dict[str, Any]:
        pdftotext_result = self._extract_pdf_text_with_pdftotext(pdf_bytes)
        if pdftotext_result is not None:
            return pdftotext_result

        pypdf_result = self._extract_pdf_text_with_pypdf(pdf_bytes)
        if pypdf_result is not None:
            return pypdf_result

        raise RuntimeError("pdf_text_extract_unavailable")

    def _extract_pdf_text_with_pdftotext(
        self, pdf_bytes: bytes
    ) -> dict[str, Any] | None:
        with tempfile.TemporaryDirectory(prefix="torghut-wp-") as temp_dir:
            pdf_path = os.path.join(temp_dir, "input.pdf")
            txt_path = os.path.join(temp_dir, "output.txt")
            with open(pdf_path, "wb") as handle:
                handle.write(pdf_bytes)

            try:
                run(
                    ["pdftotext", "-layout", "-enc", "UTF-8", pdf_path, txt_path],
                    check=True,
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError:
                return None
            except CalledProcessError as exc:
                raise RuntimeError(
                    f"pdftotext_failed:{exc.stderr.strip()[:200]}"
                ) from exc

            full_text = ""
            if os.path.exists(txt_path):
                with open(txt_path, "r", encoding="utf-8", errors="replace") as handle:
                    full_text = handle.read()

            page_count: int | None = None
            try:
                pdfinfo = run(
                    ["pdfinfo", pdf_path],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                for raw_line in pdfinfo.stdout.splitlines():
                    line = raw_line.strip()
                    if not line.lower().startswith("pages:"):
                        continue
                    _, raw_value = line.split(":", 1)
                    page_count = int(raw_value.strip())
                    break
            except (FileNotFoundError, CalledProcessError, ValueError):
                page_count = None

            return {
                "full_text": full_text,
                "metadata": {
                    "extract_method": "pdftotext",
                    "page_count": page_count,
                },
            }

    @staticmethod
    def _extract_pdf_text_with_pypdf(pdf_bytes: bytes) -> dict[str, Any] | None:
        try:
            from pypdf import PdfReader  # type: ignore[import-not-found]
        except Exception:
            return None

        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            pages: list[str] = []
            for page in reader.pages:
                page_text = page.extract_text() or ""
                pages.append(page_text)
        except Exception as exc:  # pragma: no cover - parser internals vary by input
            raise RuntimeError(
                f"pypdf_extract_failed:{type(exc).__name__}:{exc}"
            ) from exc

        return {
            "full_text": "\n\n".join(pages),
            "metadata": {
                "extract_method": "pypdf",
                "page_count": len(pages),
            },
        }

    def _upsert_whitepaper_content(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        full_text: str,
        extraction_meta: Mapping[str, Any] | None,
    ) -> None:
        version = run.document_version
        if version is None:
            raise RuntimeError("whitepaper_version_missing")

        normalized_text = full_text.strip()
        full_text_sha256 = hashlib.sha256(normalized_text.encode("utf-8")).hexdigest()
        token_count = len(normalized_text.split()) if normalized_text else 0
        page_count = self._optional_int((extraction_meta or {}).get("page_count"))

        content = session.execute(
            select(WhitepaperContent).where(
                WhitepaperContent.document_version_id == version.id
            )
        ).scalar_one_or_none()
        if content is None:
            content = WhitepaperContent(
                document_version_id=version.id,
                text_source="pdf_extract",
                full_text=normalized_text,
                full_text_sha256=full_text_sha256,
                section_index_json=None,
                chunk_manifest_json=None,
                extraction_warnings_json=None,
            )
            session.add(content)
        else:
            content.text_source = "pdf_extract"
            content.full_text = normalized_text
            content.full_text_sha256 = full_text_sha256
            session.add(content)

        version.parse_status = "parsed" if normalized_text else "stored"
        version.parse_error = None
        version.page_count = page_count
        version.char_count = len(normalized_text)
        version.token_count = token_count
        version.processed_at = datetime.now(timezone.utc)
        version.extraction_metadata_json = coerce_json_payload(
            cast(dict[str, Any], extraction_meta or {})
        )
        session.add(version)

    def _build_chunks(
        self, text_content: str, *, source_scope: str
    ) -> list[dict[str, Any]]:
        normalized = text_content.strip()
        if not normalized:
            return []

        chunk_size = max(_int_env("WHITEPAPER_CHUNK_SIZE_CHARS", 2400), 400)
        overlap = max(_int_env("WHITEPAPER_CHUNK_OVERLAP_CHARS", 300), 0)
        if overlap >= chunk_size:
            overlap = max(0, chunk_size // 5)
        stride = max(chunk_size - overlap, 1)

        chunks: list[dict[str, Any]] = []
        chunk_index = 0
        cursor = 0
        total_length = len(normalized)
        while cursor < total_length:
            end = min(total_length, cursor + chunk_size)
            chunk_text = normalized[cursor:end].strip()
            if chunk_text:
                chunks.append(
                    {
                        "source_scope": source_scope,
                        "section_key": None,
                        "chunk_index": chunk_index,
                        "content": chunk_text,
                        "token_count": len(chunk_text.split()),
                        "metadata_json": {
                            "start_char": cursor,
                            "end_char": end,
                            "chunk_size_chars": len(chunk_text),
                        },
                    }
                )
                chunk_index += 1
            if end >= total_length:
                break
            cursor += stride

        return chunks

    def _persist_semantic_chunks_and_embeddings(
        self,
        session: Session,
        *,
        run: WhitepaperAnalysisRun,
        source_scope: str,
        chunks: list[dict[str, Any]],
    ) -> dict[str, Any]:
        normalized_scope = source_scope.strip().lower()
        if normalized_scope not in {"full_text", "synthesis"}:
            raise ValueError("invalid_source_scope")
        if run.document_version is None:
            raise RuntimeError("whitepaper_version_missing")

        if not chunks:
            session.execute(
                text(
                    """
                    DELETE FROM whitepaper_semantic_chunks
                    WHERE analysis_run_id = :analysis_run_id
                      AND source_scope = :source_scope
                    """
                ),
                {
                    "analysis_run_id": run.id,
                    "source_scope": normalized_scope,
                },
            )
            return {
                "run_id": run.run_id,
                "source_scope": normalized_scope,
                "indexed_chunks": 0,
                "model": None,
                "dimension": None,
            }

        for index, chunk in enumerate(chunks):
            chunk["chunk_index"] = index

        embeddings_model, embedding_dimension, embeddings = self._embed_texts(
            [str(chunk.get("content") or "") for chunk in chunks]
        )

        indexed_chunks = 0
        for chunk, embedding in zip(chunks, embeddings, strict=True):
            content = str(chunk.get("content") or "").strip()
            if not content:
                continue
            section_key = self._optional_text(chunk.get("section_key"))
            token_count = self._optional_int(chunk.get("token_count"))
            metadata_json = self._optional_json(chunk.get("metadata_json"))
            chunk_index = int(chunk.get("chunk_index") or 0)
            content_sha256 = hashlib.sha256(content.encode("utf-8")).hexdigest()
            vector_text = self._vector_to_text(embedding)

            chunk_row = (
                session.execute(
                    text(
                        """
                    INSERT INTO whitepaper_semantic_chunks (
                      id,
                      analysis_run_id,
                      document_version_id,
                      source_scope,
                      section_key,
                      chunk_index,
                      content,
                      content_sha256,
                      token_count,
                      metadata_json,
                      text_tsvector,
                      created_at,
                      updated_at
                    )
                    VALUES (
                      :id,
                      :analysis_run_id,
                      :document_version_id,
                      :source_scope,
                      :section_key,
                      :chunk_index,
                      :content,
                      :content_sha256,
                      :token_count,
                      CAST(:metadata_json AS JSONB),
                      to_tsvector('simple', :content),
                      now(),
                      now()
                    )
                    ON CONFLICT (analysis_run_id, source_scope, chunk_index)
                    DO UPDATE SET
                      section_key = EXCLUDED.section_key,
                      content = EXCLUDED.content,
                      content_sha256 = EXCLUDED.content_sha256,
                      token_count = EXCLUDED.token_count,
                      metadata_json = EXCLUDED.metadata_json,
                      text_tsvector = EXCLUDED.text_tsvector,
                      updated_at = now()
                    RETURNING id::text
                    """
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "analysis_run_id": run.id,
                        "document_version_id": run.document_version_id,
                        "source_scope": normalized_scope,
                        "section_key": section_key,
                        "chunk_index": chunk_index,
                        "content": content,
                        "content_sha256": content_sha256,
                        "token_count": token_count,
                        "metadata_json": json.dumps(metadata_json or {}),
                    },
                )
                .mappings()
                .first()
            )
            if chunk_row is None:
                continue

            semantic_chunk_id = str(chunk_row["id"])
            session.execute(
                text(
                    """
                    INSERT INTO whitepaper_semantic_embeddings (
                      id,
                      semantic_chunk_id,
                      model,
                      dimension,
                      embedding,
                      created_at
                    )
                    VALUES (
                      :id,
                      CAST(:semantic_chunk_id AS uuid),
                      :model,
                      :dimension,
                      CAST(:embedding AS vector),
                      now()
                    )
                    ON CONFLICT (semantic_chunk_id, model, dimension)
                    DO UPDATE SET
                      embedding = EXCLUDED.embedding,
                      created_at = now()
                    """
                ),
                {
                    "id": str(uuid.uuid4()),
                    "semantic_chunk_id": semantic_chunk_id,
                    "model": embeddings_model,
                    "dimension": embedding_dimension,
                    "embedding": vector_text,
                },
            )
            indexed_chunks += 1

        session.execute(
            text(
                """
                DELETE FROM whitepaper_semantic_chunks
                WHERE analysis_run_id = :analysis_run_id
                  AND source_scope = :source_scope
                  AND chunk_index >= :chunk_count
                """
            ),
            {
                "analysis_run_id": run.id,
                "source_scope": normalized_scope,
                "chunk_count": len(chunks),
            },
        )

        index_step = WhitepaperAnalysisStep(
            analysis_run_id=run.id,
            step_name=f"semantic_index_{normalized_scope}",
            step_order=30 if normalized_scope == "full_text" else 60,
            attempt=self._next_step_attempt(
                session,
                analysis_run_id=run.id,
                step_name=f"semantic_index_{normalized_scope}",
            ),
            status="completed",
            executor="torghut",
            started_at=datetime.now(timezone.utc),
            completed_at=datetime.now(timezone.utc),
            output_json={
                "source_scope": normalized_scope,
                "indexed_chunks": indexed_chunks,
                "model": embeddings_model,
                "dimension": embedding_dimension,
            },
        )
        session.add(index_step)

        return {
            "run_id": run.run_id,
            "source_scope": normalized_scope,
            "indexed_chunks": indexed_chunks,
            "model": embeddings_model,
            "dimension": embedding_dimension,
        }


__all__ = [name for name in globals() if not name.startswith("__")]
