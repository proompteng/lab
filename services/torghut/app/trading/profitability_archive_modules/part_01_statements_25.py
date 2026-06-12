# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Archive bundle and proof helpers for historical profitability validation."""

from __future__ import annotations

import hashlib
import json
import math
import random
import shutil
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from statistics import NormalDist
from typing import Any, Mapping, Sequence, cast

import psycopg
import yaml
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import VNextDatasetSnapshot
from ..evidence_contracts import ArtifactProvenance

# ruff: noqa: F401,F403,F405,F811,F821


MARKET_DAY_INVENTORY_SCHEMA_VERSION = "torghut.market-day-inventory.v1"

EXECUTION_DAY_INVENTORY_SCHEMA_VERSION = "torghut.execution-day-inventory.v1"

REPLAY_DAY_MANIFEST_SCHEMA_VERSION = "torghut.replay-day-manifest.v1"

DATA_SUFFICIENCY_SCHEMA_VERSION = "torghut.data-sufficiency.v1"

TRIAL_LEDGER_SCHEMA_VERSION = "torghut.trial-ledger.v1"

STATISTICAL_VALIDITY_SCHEMA_VERSION = "torghut.statistical-validity.v1"

PROFITABILITY_CERTIFICATE_SCHEMA_VERSION = "torghut.profitability-certificate.v1"

SUFFICIENCY_STATUS_INSUFFICIENT_HISTORY = "insufficient_history"

SUFFICIENCY_STATUS_RESEARCH_ONLY = "research_only"

SUFFICIENCY_STATUS_HISTORICAL_READY = "historical_ready"

SUFFICIENCY_STATUS_PAPER_READY = "paper_ready"

CERTIFICATE_STATUS_INSUFFICIENT_HISTORY = "insufficient_history"

CERTIFICATE_STATUS_RESEARCH_ONLY = "research_only"

CERTIFICATE_STATUS_HISTORICAL_PROVEN = "historical_proven"

CERTIFICATE_STATUS_PAPER_PROVEN = "paper_proven"

CERTIFICATE_STATUS_LIVE_CAPPED = "live_capped"

CERTIFICATE_STATUS_LIVE_FULL = "live_full"

ARCHIVE_STATUS_ARCHIVED = "archived"

ARCHIVE_STATUS_PARTIAL = "partial"

ARCHIVE_STATUS_INSUFFICIENT = "insufficient_history"

_UTC = timezone.utc

_NORMAL_DIST = NormalDist()

_REALITY_CHECK_BOOTSTRAP_REPLICATES = 500

_REALITY_CHECK_MIN_SAMPLE_DAYS = 20

_DSR_MIN_SAMPLE_DAYS = 5

_COPYABLE_ARTIFACTS: tuple[str, ...] = (
    "run-manifest.json",
    "replay-report.json",
    "runtime-verify.json",
    "signal-activity.json",
    "decision-activity.json",
    "execution-activity.json",
    "activity-debug.json",
    "strategy-proof.json",
    "performance.json",
    "run-summary.json",
    "completion-trace.json",
    "report/simulation-report.json",
    "report/simulation-report.md",
    "report/trade-pnl.csv",
    "report/execution-latency.csv",
    "report/llm-review-summary.csv",
)


@dataclass(frozen=True)
class ArchiveWalkForwardFold:
    name: str
    train_days: list[str]
    validation_days: list[str]
    test_days: list[str]
    embargo_days: list[str]

    def to_payload(self) -> dict[str, object]:
        return {
            "name": self.name,
            "train_days": list(self.train_days),
            "validation_days": list(self.validation_days),
            "test_days": list(self.test_days),
            "embargo_days": list(self.embargo_days),
        }


@dataclass(frozen=True)
class ArchivedTradingDayBundle:
    trading_day: str
    candidate_id: str
    run_id: str
    archived_run_dir: Path
    original_run_dir: Path
    market_day_inventory: dict[str, Any]
    execution_day_inventory: dict[str, Any]
    replay_day_manifest: dict[str, Any]

    @property
    def net_pnl_estimated(self) -> Decimal:
        return _as_decimal(self.execution_day_inventory.get("net_pnl_estimated"))

    @property
    def estimated_cost_total(self) -> Decimal:
        return _as_decimal(self.execution_day_inventory.get("estimated_cost_total"))

    @property
    def replayable_market_day(self) -> bool:
        return bool(self.market_day_inventory.get("replayable_market_day", False))

    @property
    def execution_day_eligible(self) -> bool:
        return bool(self.execution_day_inventory.get("execution_day_eligible", False))


def _as_dict(value: object) -> dict[str, Any]:
    return dict(cast(Mapping[str, Any], value)) if isinstance(value, Mapping) else {}


def _as_list(value: object) -> list[Any]:
    return list(cast(Sequence[Any], value)) if isinstance(value, list) else []


def _as_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: object) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        text = value.strip()
        if text:
            try:
                return int(text)
            except ValueError:
                return 0
    return 0


def _as_float(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if text:
            try:
                return float(text)
            except ValueError:
                return None
    return None


def _as_decimal(value: object) -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal("0")


def _json_default(value: object) -> str:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=_UTC).isoformat()
        return value.astimezone(_UTC).isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, Path):
        return str(value)
    return str(value)


def _stable_hash(payload: object) -> str:
    encoded = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        default=_json_default,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=_json_default),
        encoding="utf-8",
    )


def _load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise RuntimeError(f"json_mapping_required:{path}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _load_manifest(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if path.suffix.lower() in {".yaml", ".yml"}:
        payload = yaml.safe_load(raw)
    else:
        payload = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise RuntimeError(f"manifest_mapping_required:{path}")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _simulation_report_path(run_dir: Path) -> Path:
    return run_dir / "report" / "simulation-report.json"


def _manifest_trading_day(
    manifest: Mapping[str, Any], simulation_report: Mapping[str, Any]
) -> str:
    window = _as_dict(manifest.get("window"))
    trading_day = _as_text(window.get("trading_day"))
    if trading_day:
        return trading_day
    coverage = _as_dict(simulation_report.get("coverage"))
    window_start = _as_text(coverage.get("window_start"))
    if window_start is None:
        raise RuntimeError("trading_day_missing")
    return window_start.split("T", 1)[0]


def _candidate_id(manifest: Mapping[str, Any], run_manifest: Mapping[str, Any]) -> str:
    lineage = _as_dict(run_manifest.get("evidence_lineage"))
    candidate_id = _as_text(lineage.get("candidate_id")) or _as_text(
        manifest.get("candidate_id")
    )
    if candidate_id is None:
        raise RuntimeError("candidate_id_missing")
    return candidate_id


def _source_topics_for_manifest(manifest: Mapping[str, Any]) -> list[str]:
    from scripts.simulation_lane_contracts import simulation_lane_contract_for_manifest

    contract = simulation_lane_contract_for_manifest(manifest)
    return [contract.source_topic_by_role[role] for role in contract.replay_roles]


def _source_roles_for_manifest(manifest: Mapping[str, Any]) -> list[str]:
    from scripts.simulation_lane_contracts import simulation_lane_contract_for_manifest

    contract = simulation_lane_contract_for_manifest(manifest)
    return list(contract.replay_roles)


def _artifacts_for_copy(run_dir: Path) -> list[Path]:
    paths: dict[Path, Path] = {}
    for relative in _COPYABLE_ARTIFACTS:
        candidate = run_dir / relative
        if candidate.exists() and candidate.is_file():
            paths[candidate] = candidate
    for candidate in sorted(run_dir.glob("source-dump*")):
        if candidate.is_file():
            paths[candidate] = candidate
    return list(paths.values())


def copy_archive_artifacts(
    *,
    run_dir: Path,
    archive_run_dir: Path,
    manifest_path: Path,
) -> dict[str, dict[str, str]]:
    copied: dict[str, dict[str, str]] = {}
    archive_run_dir.mkdir(parents=True, exist_ok=True)

    copied_manifest_path = (
        archive_run_dir / f"source-manifest{manifest_path.suffix or '.json'}"
    )
    shutil.copy2(manifest_path, copied_manifest_path)
    copied["source_manifest"] = {
        "path": str(copied_manifest_path),
        "sha256": hashlib.sha256(copied_manifest_path.read_bytes()).hexdigest(),
    }

    for source_path in _artifacts_for_copy(run_dir):
        relative_path = source_path.relative_to(run_dir)
        destination = archive_run_dir / relative_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, destination)
        copied[str(relative_path)] = {
            "path": str(destination),
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
        }

    simulation_report_key = "report/simulation-report.json"
    simulation_report_entry = copied.get(simulation_report_key)
    if simulation_report_entry is not None:
        simulation_report_path = Path(simulation_report_entry["path"])
        simulation_report = _load_json(simulation_report_path)
        run_metadata = _as_dict(simulation_report.get("run_metadata"))
        run_metadata["manifest_path"] = str(copied_manifest_path)
        simulation_report["run_metadata"] = run_metadata
        _write_json(simulation_report_path, simulation_report)
        copied[simulation_report_key]["sha256"] = hashlib.sha256(
            simulation_report_path.read_bytes()
        ).hexdigest()

    return copied


def collect_simulation_postgres_counts(simulation_dsn: str) -> dict[str, int]:
    dsn = simulation_dsn.strip()
    if not dsn:
        return {}

    query = """
        SELECT
          CASE WHEN to_regclass('public.trade_decisions') IS NULL THEN 0 ELSE (SELECT count(*) FROM trade_decisions) END AS trade_decisions,
          CASE WHEN to_regclass('public.executions') IS NULL THEN 0 ELSE (SELECT count(*) FROM executions) END AS executions,
          CASE WHEN to_regclass('public.position_snapshots') IS NULL THEN 0 ELSE (SELECT count(*) FROM position_snapshots) END AS position_snapshots,
          CASE WHEN to_regclass('public.execution_order_events') IS NULL THEN 0 ELSE (SELECT count(*) FROM execution_order_events) END AS execution_order_events,
          CASE WHEN to_regclass('public.execution_tca_metrics') IS NULL THEN 0 ELSE (SELECT count(*) FROM execution_tca_metrics) END AS execution_tca_metrics
    """
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cursor:
            cursor.execute(query)
            row = cursor.fetchone()
    if row is None:
        return {}
    return {
        "trade_decisions": _as_int(row[0]),
        "executions": _as_int(row[1]),
        "position_snapshots": _as_int(row[2]),
        "execution_order_events": _as_int(row[3]),
        "execution_tca_metrics": _as_int(row[4]),
    }


def build_market_day_inventory(
    *,
    manifest: Mapping[str, Any],
    run_manifest: Mapping[str, Any],
    replay_report: Mapping[str, Any],
    simulation_report: Mapping[str, Any],
    artifact_refs: Mapping[str, Mapping[str, str]],
    topic_retention_ms_by_topic: Mapping[str, int] | None = None,
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    trading_day = _manifest_trading_day(manifest, simulation_report)
    source_topics = _source_topics_for_manifest(manifest)
    source_roles = _source_roles_for_manifest(manifest)
    records_by_topic = _as_dict(
        _as_dict(run_manifest.get("dump")).get("records_by_topic")
    )
    coverage = _as_dict(simulation_report.get("coverage"))
    dump_coverage = _as_dict(run_manifest.get("dump_coverage"))
    coverage_ratio = (
        _as_float(dump_coverage.get("coverage_ratio"))
        or _as_float(coverage.get("window_coverage_ratio_from_dump"))
        or 0.0
    )
    required_topics: list[str] = []
    for role in source_roles:
        if role == "status":
            continue
        from scripts.simulation_lane_contracts import (
            simulation_lane_contract_for_manifest,
        )

        contract = simulation_lane_contract_for_manifest(manifest)
        required_topics.append(contract.source_topic_by_role[role])
    missing_topics = [
        topic for topic in required_topics if _as_int(records_by_topic.get(topic)) <= 0
    ]
    symbols = sorted(
        {
            str(item)
            for item in _as_list(
                _as_dict(simulation_report.get("stability"))
                .get("clickhouse", {})
                .get("symbols")
            )
            if str(item).strip()
        }
    )
    if not symbols:
        stability_clickhouse = _as_dict(
            _as_dict(simulation_report.get("stability")).get("clickhouse")
        )
        raw_symbols = stability_clickhouse.get("symbols")
        if isinstance(raw_symbols, list):
            normalized_symbols = [
                str(item)
                for item in cast(list[object], raw_symbols)
                if str(item).strip()
            ]
            symbols = sorted(set(normalized_symbols))
    market_day_inventory: dict[str, Any] = {
        "schema_version": MARKET_DAY_INVENTORY_SCHEMA_VERSION,
        "trading_day": trading_day,
        "window": dict(_as_dict(manifest.get("window"))),
        "lane": _as_text(manifest.get("lane")) or "equity",
        "source_topics": source_topics,
        "source_topic_retention_ms_by_topic": {
            topic: int(value)
            for topic, value in (topic_retention_ms_by_topic or {}).items()
            if str(topic).strip()
        },
        "source_offsets": {},
        "source_records_by_topic": {
            str(topic): _as_int(value) for topic, value in records_by_topic.items()
        },
        "symbols": symbols,
        "clickhouse_coverage": {
            "window_coverage_ratio_from_dump": coverage.get(
                "window_coverage_ratio_from_dump"
            ),
            "decision_signal_min_ts": coverage.get("decision_signal_min_ts"),
            "decision_signal_max_ts": coverage.get("decision_signal_max_ts"),
            "dump_signal_min_ts": coverage.get("dump_signal_min_ts"),
            "dump_signal_max_ts": coverage.get("dump_signal_max_ts"),
        },
        "clickhouse_day_exports": {
            key: value["path"]
            for key, value in artifact_refs.items()
            if key.startswith("report/")
        },
        "replayable_market_day": (
            _as_int(_as_dict(run_manifest.get("dump")).get("records")) > 0
            and coverage_ratio
            >= (
                _as_float(
                    _as_dict(run_manifest.get("window_policy")).get(
                        "strict_coverage_ratio"
                    )
                )
                or 0.95
            )
            and not missing_topics
        ),
        "missing_topics": missing_topics,
        "missing_partitions": [],
        "missing_symbols": [],
        "reconstruction_source_provenance": ArtifactProvenance.HISTORICAL_MARKET_REPLAY.value,
        "observed_at": (observed_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
    }
    return market_day_inventory


def build_execution_day_inventory(
    *,
    manifest: Mapping[str, Any],
    simulation_report: Mapping[str, Any],
    artifact_refs: Mapping[str, Mapping[str, str]],
    postgres_counts: Mapping[str, int] | None = None,
    empirical_artifact_refs: Sequence[str] | None = None,
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    funnel = _as_dict(simulation_report.get("funnel"))
    execution_quality = _as_dict(simulation_report.get("execution_quality"))
    slippage = _as_dict(execution_quality.get("slippage_bps"))
    pnl = _as_dict(simulation_report.get("pnl"))
    counts = dict(postgres_counts or {})
    trade_decisions = counts.get(
        "trade_decisions", _as_int(funnel.get("trade_decisions"))
    )
    executions = counts.get("executions", _as_int(funnel.get("executions")))
    position_snapshots = counts.get("position_snapshots", 0)
    execution_order_events = counts.get(
        "execution_order_events",
        _as_int(
            funnel.get("execution_order_events_total")
            or funnel.get("execution_order_events")
        ),
    )
    execution_tca_metrics = counts.get(
        "execution_tca_metrics",
        _as_int(funnel.get("execution_tca_metrics")),
    )
    missing_surfaces: list[str] = []
    if trade_decisions <= 0:
        missing_surfaces.append("trade_decisions")
    if executions <= 0:
        missing_surfaces.append("executions")
    if position_snapshots <= 0:
        missing_surfaces.append("position_snapshots")
    if execution_order_events <= 0:
        missing_surfaces.append("execution_order_events")
    if execution_tca_metrics <= 0:
        missing_surfaces.append("execution_tca_metrics")
    if not counts:
        missing_surfaces.append("simulation_postgres_snapshot_missing")

    return {
        "schema_version": EXECUTION_DAY_INVENTORY_SCHEMA_VERSION,
        "trading_day": _manifest_trading_day(manifest, simulation_report),
        "candidate_scope": {
            "candidate_id": _as_text(manifest.get("candidate_id")),
            "baseline_candidate_id": _as_text(manifest.get("baseline_candidate_id")),
            "strategy_spec_ref": _as_text(manifest.get("strategy_spec_ref")),
            "model_refs": [
                str(item)
                for item in _as_list(manifest.get("model_refs"))
                if str(item).strip()
            ],
        },
        "trade_decisions_present": trade_decisions > 0,
        "executions_present": executions > 0,
        "execution_order_events_present": execution_order_events > 0,
        "position_snapshots_present": position_snapshots > 0,
        "execution_tca_metrics_present": execution_tca_metrics > 0,
        "postgres_day_exports": {
            "counts": {
                "trade_decisions": trade_decisions,
                "executions": executions,
                "position_snapshots": position_snapshots,
                "execution_order_events": execution_order_events,
                "execution_tca_metrics": execution_tca_metrics,
            },
            "report_paths": {
                key: value["path"]
                for key, value in artifact_refs.items()
                if key
                in {
                    "run-summary.json",
                    "report/simulation-report.json",
                    "report/trade-pnl.csv",
                }
            },
        },
        "empirical_artifact_refs": [
            str(item) for item in (empirical_artifact_refs or []) if str(item).strip()
        ],
        "rejections_by_reason": {},
        "broker_failures_by_reason": {
            str(key): _as_int(value)
            for key, value in _as_dict(
                execution_quality.get("fallback_reason_counts")
            ).items()
        },
        "decision_status_counts": {
            str(key): _as_int(value)
            for key, value in _as_dict(funnel.get("decision_status_counts")).items()
        },
        "net_pnl_estimated": format(_as_decimal(pnl.get("net_pnl_estimated")), "f"),
        "estimated_cost_total": format(
            _as_decimal(pnl.get("estimated_cost_total")), "f"
        ),
        "execution_notional_total": format(
            _as_decimal(pnl.get("execution_notional_total")), "f"
        ),
        "avg_abs_slippage_bps": slippage.get("avg_abs"),
        "p95_abs_slippage_bps": slippage.get("p95_abs"),
        "execution_day_eligible": not missing_surfaces,
        "missing_execution_surfaces": missing_surfaces,
        "observed_at": (observed_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
    }


def build_replay_day_manifest(
    *,
    manifest: Mapping[str, Any],
    run_manifest: Mapping[str, Any],
    replay_report: Mapping[str, Any],
    archive_dir: Path,
    original_run_dir: Path,
    artifact_refs: Mapping[str, Mapping[str, str]],
    market_day_inventory: Mapping[str, Any],
    execution_day_inventory: Mapping[str, Any],
    observed_at: datetime | None = None,
) -> dict[str, Any]:
    evidence_lineage = _as_dict(run_manifest.get("evidence_lineage"))
    bundle_inputs = {
        "artifact_refs": artifact_refs,
        "market_day_inventory": market_day_inventory,
        "execution_day_inventory": execution_day_inventory,
        "run_manifest_dump_sha256": _as_text(
            _as_dict(run_manifest.get("dump")).get("sha256")
        ),
        "replay_report_dump_sha256": _as_text(replay_report.get("dump_sha256")),
    }
    archive_status = ARCHIVE_STATUS_ARCHIVED
    if not bool(market_day_inventory.get("replayable_market_day", False)):
        archive_status = ARCHIVE_STATUS_PARTIAL
    if not bool(execution_day_inventory.get("execution_day_eligible", False)):
        archive_status = (
            ARCHIVE_STATUS_PARTIAL
            if archive_status == ARCHIVE_STATUS_ARCHIVED
            else archive_status
        )

    return {
        "schema_version": REPLAY_DAY_MANIFEST_SCHEMA_VERSION,
        "run_id": _as_text(run_manifest.get("run_id")) or original_run_dir.name,
        "dataset_id": _as_text(manifest.get("dataset_id"))
        or _as_text(run_manifest.get("dataset_id"))
        or original_run_dir.name,
        "dataset_snapshot_ref": _as_text(manifest.get("dataset_snapshot_ref")),
        "candidate_id": _as_text(evidence_lineage.get("candidate_id"))
        or _as_text(manifest.get("candidate_id")),
        "baseline_candidate_id": _as_text(evidence_lineage.get("baseline_candidate_id"))
        or _as_text(manifest.get("baseline_candidate_id")),
        "trading_day": _manifest_trading_day(manifest, market_day_inventory),
        "window": dict(_as_dict(manifest.get("window"))),
        "source_dump_ref": (
            _as_text(
                _as_dict(artifact_refs.get("source-dump.jsonl.zst.manifest.json")).get(
                    "path"
                )
            )
            or _as_text(
                _as_dict(artifact_refs.get("source-dump.jsonl.gz.manifest.json")).get(
                    "path"
                )
            )
            or _as_text(
                _as_dict(artifact_refs.get("source-dump.ndjson.manifest.json")).get(
                    "path"
                )
            )
        ),
        "source_dump_sha256": (
            _as_text(replay_report.get("dump_sha256"))
            or _as_text(_as_dict(run_manifest.get("dump")).get("sha256"))
        ),
        "run_manifest_ref": _as_text(
            _as_dict(artifact_refs.get("run-manifest.json")).get("path")
        ),
        "analysis_report_ref": _as_text(
            _as_dict(artifact_refs.get("report/simulation-report.json")).get("path")
        ),
        "simulation_database": _as_text(
            _as_dict(manifest.get("clickhouse")).get("simulation_database")
        ),
        "runtime_version_refs": [
            str(item)
            for item in _as_list(evidence_lineage.get("runtime_version_refs"))
            if str(item).strip()
        ],
        "model_refs": [
            str(item)
            for item in _as_list(evidence_lineage.get("model_refs"))
            if str(item).strip()
        ],
        "strategy_spec_ref": _as_text(evidence_lineage.get("strategy_spec_ref"))
        or _as_text(manifest.get("strategy_spec_ref")),
        "artifact_bundle_sha256": _stable_hash(bundle_inputs),
        "archive_status": archive_status,
        "original_run_dir": str(original_run_dir),
        "archived_run_dir": str(archive_dir),
        "artifact_refs": {key: value["path"] for key, value in artifact_refs.items()},
        "observed_at": (observed_at or datetime.now(_UTC)).astimezone(_UTC).isoformat(),
    }


def upsert_dataset_snapshot(
    session: Session,
    *,
    run_id: str,
    candidate_id: str | None,
    dataset_id: str,
    dataset_from: datetime | None,
    dataset_to: datetime | None,
    artifact_ref: str,
    payload_json: Mapping[str, Any],
) -> VNextDatasetSnapshot:
    existing = session.execute(
        select(VNextDatasetSnapshot).where(
            VNextDatasetSnapshot.run_id == run_id,
            VNextDatasetSnapshot.dataset_id == dataset_id,
        )
    ).scalar_one_or_none()
    snapshot = existing or VNextDatasetSnapshot(
        run_id=run_id,
        candidate_id=candidate_id,
        dataset_id=dataset_id,
        source=ArtifactProvenance.HISTORICAL_MARKET_REPLAY.value,
    )
    snapshot.candidate_id = candidate_id
    snapshot.dataset_version = run_id
    snapshot.dataset_from = dataset_from
    snapshot.dataset_to = dataset_to
    snapshot.artifact_ref = artifact_ref
    snapshot.payload_json = dict(payload_json)
    if existing is None:
        session.add(snapshot)
    session.flush()
    return snapshot


def _resolve_manifest_path(run_dir: Path, manifest_path: Path) -> Path:
    if manifest_path.is_absolute() and manifest_path.exists():
        return manifest_path
    for candidate in (run_dir / manifest_path, Path.cwd() / manifest_path):
        if candidate.exists():
            return candidate
    return manifest_path


__all__ = [name for name in globals() if not name.startswith("__")]
