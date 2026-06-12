from __future__ import annotations

# ruff: noqa: F401
import gzip
import json
import re
import uuid
from contextlib import ExitStack
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from typing import Any
from unittest import TestCase
from unittest.mock import call, patch

import yaml
from scripts import historical_simulation_verification, start_historical_simulation
from scripts.start_historical_simulation import (
    ArgocdAutomationConfig,
    ClickHouseRuntimeConfig,
    KafkaRuntimeConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    _analysis_run_name,
    _build_clickhouse_runtime_config,
    _build_fill_price_error_budget_payload,
    _build_argocd_automation_config,
    _build_autonomy_lane_config,
    _build_kafka_runtime_config,
    _build_plan_report,
    _build_postgres_runtime_config,
    _build_resources,
    _build_rollouts_analysis_config,
    _build_simulation_completion_trace,
    _compress_dump_file,
    _count_lines,
    _configure_torghut_service_for_simulation,
    _doc29_simulation_gate_ids,
    _discover_applicationset_entry,
    _find_vector_extension_blocking_revision,
    _dump_topics,
    _dump_sha256_for_replay,
    _clickhouse_query_configs,
    _clickhouse_jdbc_url_for_database,
    _ensure_simulation_schema_subjects,
    _ensure_topics,
    _file_sha256,
    _http_clickhouse_query,
    _merge_env_entries,
    _materialize_deterministic_dump,
    _monitor_run_completion,
    _normalize_run_token,
    _open_dump_reader,
    _offset_for_time_lookup,
    _pacing_delay_seconds,
    _prepare_argocd_for_run,
    _producer_for_replay,
    _redact_dsn_credentials,
    _restore_ta_configuration,
    _restore_argocd_after_run,
    _restore_torghut_env,
    _replay_dump,
    _resolve_warm_lane_runtime_postgres_config,
    _run_full_lifecycle,
    _run_rollouts_analysis,
    _load_schema_registry_schema_literal,
    _simulation_schema_registry_subject_specs,
    _simulation_evidence_lineage,
    _set_argocd_application_sync_policy,
    _set_argocd_automation_mode,
    _runtime_verify,
    _run_migrations,
    _wait_for_torghut_service_revision_ready,
    _torghut_env_overrides_from_manifest,
    _validate_dump_coverage,
    _validate_window_policy,
    _verify_isolation_guards,
)


__all__ = [name for name in globals() if not name.startswith("__")]
