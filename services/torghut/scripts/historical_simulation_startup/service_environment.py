#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence, cast

from app.db import SessionLocal
from app.trading.autonomy.lane import run_autonomous_lane
from app.trading.completion import (
    DOC29_SIMULATION_FULL_DAY_GATE,
    DOC29_SIMULATION_SMOKE_GATE,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_SATISFIED,
    build_completion_trace,
    persist_completion_trace,
)
from app.trading.evaluation import build_fill_price_error_budget_report_v1
from app.trading.simulation_progress import (
    COMPONENT_ARTIFACTS,
    COMPONENT_REPLAY,
    SIMULATION_PROGRESS_COMPONENTS,
    COMPONENT_TA,
    COMPONENT_TORGHUT,
)
from app.whitepapers.workflow import CephS3Client
from scripts import (
    historical_simulation_runtime_verification as simulation_verification,
)
from scripts.simulation_lane_contracts import (
    EQUITY_SIMULATION_LANE,
    simulation_clickhouse_table_names,
    simulation_lane_contract,
    simulation_lane_contract_for_manifest,
    simulation_schema_registry_subject_roles,
)

from .simulation_context import (
    DEFAULT_SIMULATION_CACHE_BUCKET,
    DEFAULT_SIMULATION_CACHE_PREFIX,
    DEFAULT_SIMULATION_DUMP_FORMAT,
    DEFAULT_SIMULATION_DUMP_SORT_MEMORY_LIMIT,
    DEFAULT_SIMULATION_REPLAY_PROFILE,
    REPLAY_PROFILE_DEFAULTS,
    SIMULATION_CACHE_KEY_SCHEMA_VERSION,
    SIMULATION_FEATURE_STALENESS_MARGIN_MS,
    SIMULATION_FEATURE_STALENESS_MIN_MS,
    SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST,
    SUPPORTED_SIMULATION_DUMP_FORMATS,
)
from .runtime_config import (
    ArgocdAutomationConfig,
    PostgresRuntimeConfig,
    SimulationResources,
    _as_mapping,
    _as_string_list,
    _as_text,
    _parse_rfc3339_timestamp,
    _replace_database_in_dsn,
)
from .kubernetes_argocd import (
    _argocd_ignore_differences_cover_required_rules,
    _json_pointer_escape,
    _kubectl_json,
    _kubectl_patch_json,
    _normalized_argocd_ignore_differences,
    _normalized_automation_mode,
    _read_argocd_applicationset_entry,
    _read_named_argocd_application_sync_policy,
)


def _set_argocd_application_ignore_differences(
    *,
    config: ArgocdAutomationConfig,
    app_name: str | None = None,
    required_ignore_differences: Sequence[Mapping[str, Any]] | None = None,
    desired_ignore_differences: Sequence[Mapping[str, Any]] | None,
) -> dict[str, Any]:
    normalized_desired = _normalized_argocd_ignore_differences(
        desired_ignore_differences
    )
    normalized_required = _normalized_argocd_ignore_differences(
        required_ignore_differences
    )
    target_app_name = app_name or config.app_name
    if target_app_name != config.app_name:
        raise RuntimeError(f"unsupported_argocd_managed_application:{target_app_name}")
    state = _read_argocd_applicationset_entry(config=config)
    current_ignore_differences = _normalized_argocd_ignore_differences(
        cast(Sequence[Mapping[str, Any]] | None, state.get("ignore_differences"))
    )
    changed = current_ignore_differences != normalized_desired
    if changed:
        ignore_differences_pointer = (
            f"{state['pointer']}/{_json_pointer_escape('ignoreDifferences')}"
        )
        patch_op = "replace" if current_ignore_differences else "add"
        if normalized_desired:
            _kubectl_patch_json(
                config.applicationset_namespace,
                "applicationset",
                config.applicationset_name,
                [
                    {
                        "op": patch_op,
                        "path": ignore_differences_pointer,
                        "value": normalized_desired,
                    }
                ],
            )
        else:
            _kubectl_patch_json(
                config.applicationset_namespace,
                "applicationset",
                config.applicationset_name,
                [{"op": "remove", "path": ignore_differences_pointer}],
            )

    deadline = datetime.now(timezone.utc) + timedelta(
        seconds=config.verify_timeout_seconds
    )
    verified_ignore_differences = current_ignore_differences
    verified_application_ignore_differences = _normalized_argocd_ignore_differences(
        None
    )
    while True:
        verified_state = _read_argocd_applicationset_entry(config=config)
        verified_ignore_differences = _normalized_argocd_ignore_differences(
            cast(
                Sequence[Mapping[str, Any]] | None,
                verified_state.get("ignore_differences"),
            )
        )
        application_state = _read_named_argocd_application_sync_policy(
            namespace=config.applicationset_namespace,
            app_name=target_app_name,
        )
        verified_application_ignore_differences = _normalized_argocd_ignore_differences(
            cast(
                Sequence[Mapping[str, Any]] | None,
                application_state.get("ignore_differences"),
            )
        )
        if (
            verified_ignore_differences == normalized_desired
            and verified_application_ignore_differences == normalized_desired
        ):
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                "argocd_application_ignore_differences_verify_timeout "
                f"desired={json.dumps(normalized_desired, sort_keys=True)} "
                f"observed_applicationset={json.dumps(verified_ignore_differences, sort_keys=True)} "
                f"observed_application={json.dumps(verified_application_ignore_differences, sort_keys=True)}"
            )
        time.sleep(2)

    return {
        "app_name": target_app_name,
        "applicationset_pointer": _as_text(state.get("pointer")),
        "previous_ignore_differences": current_ignore_differences,
        "current_ignore_differences": verified_ignore_differences,
        "current_application_ignore_differences": verified_application_ignore_differences,
        "required_ignore_differences": normalized_required,
        "coverage_complete": (
            True
            if not normalized_required
            else _argocd_ignore_differences_cover_required_rules(
                current_ignore_differences=verified_application_ignore_differences,
                required_ignore_differences=normalized_required,
            )
        ),
        "changed": changed,
    }


def _wait_for_argocd_application_mode(
    *,
    config: ArgocdAutomationConfig,
    app_name: str,
    desired_mode: str,
) -> dict[str, Any]:
    normalized_desired = _normalized_automation_mode(desired_mode)
    state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=app_name,
    )
    current_mode = _normalized_automation_mode(_as_text(state.get("automation_mode")))
    deadline = datetime.now(timezone.utc) + timedelta(
        seconds=config.verify_timeout_seconds
    )
    verified_mode = current_mode
    while True:
        verified_state = _read_named_argocd_application_sync_policy(
            namespace=config.applicationset_namespace,
            app_name=app_name,
        )
        verified_mode = _normalized_automation_mode(
            _as_text(verified_state.get("automation_mode"))
        )
        if verified_mode == normalized_desired:
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                "argocd_application_mode_verify_timeout "
                f"app={app_name} desired={normalized_desired} observed={verified_mode}"
            )
        time.sleep(2)

    return {
        "app_name": app_name,
        "current_mode": verified_mode,
    }


def _kservice_env(service: Mapping[str, Any]) -> tuple[str, list[dict[str, Any]]]:
    spec = _as_mapping(service.get("spec"))
    template = _as_mapping(spec.get("template"))
    template_spec = _as_mapping(template.get("spec"))
    containers = template_spec.get("containers")
    if not isinstance(containers, list) or not containers:
        raise RuntimeError("kservice container spec missing")
    first = containers[0]
    if not isinstance(first, Mapping):
        raise RuntimeError("kservice container spec invalid")
    container = _as_mapping(first)
    container_name = _as_text(container.get("name")) or "user-container"
    env_raw = container.get("env")
    env: list[dict[str, Any]] = []
    if isinstance(env_raw, list):
        for item in env_raw:
            if isinstance(item, Mapping):
                env.append(_as_mapping(item))
    return container_name, env


def _kservice_container_with_env(
    service: Mapping[str, Any],
    env_entries: list[dict[str, Any]],
) -> dict[str, Any]:
    spec = _as_mapping(service.get("spec"))
    template = _as_mapping(spec.get("template"))
    template_spec = _as_mapping(template.get("spec"))
    containers = template_spec.get("containers")
    if not isinstance(containers, list) or not containers:
        raise RuntimeError("kservice container spec missing")
    first = containers[0]
    if not isinstance(first, Mapping):
        raise RuntimeError("kservice container spec invalid")
    container = _as_mapping(first)
    updated = dict(container)
    updated["env"] = list(env_entries)
    return updated


def _read_secret_key_ref(
    *,
    namespace: str,
    name: str,
    key: str,
) -> str:
    from .kafka_runtime import _b64_to_bytes

    secret = _kubectl_json(namespace, ["get", "secret", name, "-o", "json"])
    data = _as_mapping(secret.get("data"))
    encoded = _as_text(data.get(key))
    if encoded is None:
        raise RuntimeError(f"secret_key_missing:{namespace}:{name}:{key}")
    try:
        decoded = _b64_to_bytes(encoded)
        if decoded is None:
            raise RuntimeError("empty_secret_value")
        return decoded.decode("utf-8")
    except Exception as exc:  # pragma: no cover - defensive decode guard
        raise RuntimeError(
            f"secret_key_decode_failed:{namespace}:{name}:{key}"
        ) from exc


def _read_configmap_key_ref(
    *,
    namespace: str,
    name: str,
    key: str,
) -> str:
    configmap = _kubectl_json(namespace, ["get", "configmap", name, "-o", "json"])
    data = _as_mapping(configmap.get("data"))
    value = _as_text(data.get(key))
    if value is None:
        raise RuntimeError(f"configmap_key_missing:{namespace}:{name}:{key}")
    return value


def _expand_env_value_refs(value: str, resolved: Mapping[str, str]) -> str:
    def _sub(match: re.Match[str]) -> str:
        key = match.group(1)
        return resolved.get(key, match.group(0))

    return re.sub(r"\$\(([A-Za-z_][A-Za-z0-9_]*)\)", _sub, value)


def _resolve_kservice_env_values(
    *,
    namespace: str,
    env_entries: Sequence[Mapping[str, Any]],
) -> dict[str, str]:
    resolved: dict[str, str] = {}
    deferred: dict[str, str] = {}
    for entry in env_entries:
        name = _as_text(entry.get("name"))
        if not name:
            continue
        raw_value = entry.get("value")
        if raw_value is not None:
            deferred[name] = str(raw_value)
            continue
        value_from = _as_mapping(entry.get("valueFrom"))
        secret_key_ref = _as_mapping(value_from.get("secretKeyRef"))
        if secret_key_ref:
            secret_name = _as_text(secret_key_ref.get("name"))
            secret_key = _as_text(secret_key_ref.get("key"))
            if not secret_name or not secret_key:
                raise RuntimeError(f"kservice_env_secret_key_ref_invalid:{name}")
            resolved[name] = _read_secret_key_ref(
                namespace=namespace,
                name=secret_name,
                key=secret_key,
            )
            continue
        configmap_key_ref = _as_mapping(value_from.get("configMapKeyRef"))
        if configmap_key_ref:
            configmap_name = _as_text(configmap_key_ref.get("name"))
            configmap_key = _as_text(configmap_key_ref.get("key"))
            if not configmap_name or not configmap_key:
                raise RuntimeError(f"kservice_env_configmap_key_ref_invalid:{name}")
            resolved[name] = _read_configmap_key_ref(
                namespace=namespace,
                name=configmap_name,
                key=configmap_key,
            )
    if deferred:
        for _ in range(len(deferred) + len(resolved) + 1):
            changed = False
            for key, value in deferred.items():
                expanded = _expand_env_value_refs(value, resolved)
                if key not in resolved or resolved[key] != expanded:
                    resolved[key] = expanded
                    changed = True
            if not changed:
                break
    return resolved


def _resolve_warm_lane_runtime_postgres_config(
    *,
    resources: SimulationResources,
    postgres_config: PostgresRuntimeConfig,
) -> PostgresRuntimeConfig:
    if postgres_config.runtime_simulation_dsn:
        return postgres_config
    service = _kubectl_json(
        resources.namespace,
        ["get", "kservice", resources.torghut_service, "-o", "json"],
    )
    _, env_entries = _kservice_env(service)
    resolved_env = _resolve_kservice_env_values(
        namespace=resources.namespace,
        env_entries=env_entries,
    )
    current_runtime_dsn = _as_text(resolved_env.get("DB_DSN"))
    if not current_runtime_dsn:
        raise RuntimeError(
            f"warm_lane_runtime_dsn_unavailable:{resources.namespace}:{resources.torghut_service}"
        )
    runtime_dsn = _replace_database_in_dsn(
        current_runtime_dsn,
        database=postgres_config.simulation_db,
        label=f"{resources.torghut_service}.env.DB_DSN",
    )
    return replace(postgres_config, runtime_simulation_dsn=runtime_dsn)


def _merge_env_entries(
    env: list[dict[str, Any]],
    updates: Mapping[str, Any],
) -> list[dict[str, Any]]:
    merged = [dict(item) for item in env]
    index_by_name = {
        _as_text(item.get("name")): idx
        for idx, item in enumerate(merged)
        if _as_text(item.get("name"))
    }
    for key, raw_value in updates.items():
        if raw_value is None:
            existing_idx = index_by_name.get(key)
            if existing_idx is not None:
                merged.pop(existing_idx)
                index_by_name = {
                    _as_text(item.get("name")): idx
                    for idx, item in enumerate(merged)
                    if _as_text(item.get("name"))
                }
            continue
        if isinstance(raw_value, Mapping):
            entry = {"name": key, **_as_mapping(raw_value)}
        else:
            entry = {"name": key, "value": str(raw_value)}
        existing_idx = index_by_name.get(key)
        if existing_idx is None:
            merged.append(entry)
            index_by_name[key] = len(merged) - 1
        else:
            merged[existing_idx] = entry
    return merged


def _recommended_simulation_feature_staleness_ms(
    manifest: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> int | None:
    window = _as_mapping(manifest.get("window"))
    window_start_raw = _as_text(window.get("start"))
    if window_start_raw is None:
        return None

    try:
        window_start = _parse_rfc3339_timestamp(window_start_raw, label="window.start")
    except SystemExit:
        return None

    reference_now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_ms = max(0, int((reference_now - window_start).total_seconds() * 1000))
    return max(
        SIMULATION_FEATURE_STALENESS_MIN_MS,
        age_ms + SIMULATION_FEATURE_STALENESS_MARGIN_MS,
    )


def _torghut_env_overrides_from_manifest(
    manifest: Mapping[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, str]:
    overrides_raw = _as_mapping(manifest.get("torghut_env_overrides"))
    overrides: dict[str, str] = {}
    for key, raw_value in overrides_raw.items():
        env_key = str(key).strip()
        if env_key not in SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST:
            raise RuntimeError(
                f"disallowed_torghut_env_override:{env_key} "
                f"allowed={','.join(sorted(SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST))}"
            )
        value = _as_text(raw_value)
        if value is None:
            raise RuntimeError(f"invalid_torghut_env_override_value:{env_key}")
        overrides[env_key] = value

    if "TRADING_FEATURE_MAX_STALENESS_MS" not in overrides:
        recommended = _recommended_simulation_feature_staleness_ms(
            manifest,
            now=now,
        )
        if recommended is not None:
            overrides["TRADING_FEATURE_MAX_STALENESS_MS"] = str(recommended)
    return overrides


def _simulation_account_label(
    *,
    resources: SimulationResources,
    manifest: Mapping[str, Any],
    torghut_env_overrides: Mapping[str, Any] | None = None,
) -> str:
    if torghut_env_overrides is not None:
        override_value = _as_text(torghut_env_overrides.get("TRADING_ACCOUNT_LABEL"))
        if override_value:
            return override_value
    runtime = _as_mapping(manifest.get("runtime"))
    runtime_value = _as_text(runtime.get("account_label")) or _as_text(
        runtime.get("accountLabel")
    )
    if runtime_value:
        return runtime_value
    if resources.target_mode == "dedicated_service":
        return "TORGHUT_SIM"
    return "paper"


def _performance_config(manifest: Mapping[str, Any]) -> dict[str, Any]:
    performance = _as_mapping(manifest.get("performance"))
    replay_profile = (
        (
            _as_text(performance.get("replayProfile"))
            or _as_text(performance.get("replay_profile"))
            or ""
        )
        .strip()
        .lower()
    )
    if not replay_profile:
        window = _as_mapping(manifest.get("window"))
        if _as_text(window.get("start")) and _as_text(window.get("end")):
            monitor_settings = simulation_verification._monitor_settings(manifest)
            replay_profile = (
                _as_text(monitor_settings.get("profile"))
                or DEFAULT_SIMULATION_REPLAY_PROFILE
            )
        else:
            replay_profile = DEFAULT_SIMULATION_REPLAY_PROFILE
    if replay_profile not in REPLAY_PROFILE_DEFAULTS:
        raise RuntimeError(f"unsupported_replay_profile:{replay_profile}")

    dump_format = (
        (
            _as_text(performance.get("dumpFormat"))
            or _as_text(performance.get("dump_format"))
            or ""
        )
        .strip()
        .lower()
    )
    if not dump_format:
        if shutil.which("zstd"):
            dump_format = "jsonl.zst"
        elif shutil.which("pigz"):
            dump_format = "jsonl.gz"
        else:
            dump_format = "ndjson"
    if dump_format not in SUPPORTED_SIMULATION_DUMP_FORMATS:
        raise RuntimeError(
            "performance.dumpFormat must be one of: "
            + ",".join(sorted(SUPPORTED_SIMULATION_DUMP_FORMATS))
        )
    cache_policy = (
        (
            _as_text(manifest.get("cachePolicy"))
            or _as_text(performance.get("cachePolicy"))
            or _as_text(performance.get("cache_policy"))
            or "prefer_cache"
        )
        .strip()
        .lower()
    )
    if cache_policy not in {"prefer_cache", "require_cache", "refresh"}:
        raise RuntimeError(
            "cachePolicy must be one of: prefer_cache,require_cache,refresh"
        )
    return {
        "replay_profile": replay_profile,
        "dump_format": dump_format,
        "cache_policy": cache_policy,
    }


def _dump_suffix(dump_format: str) -> str:
    suffix = SUPPORTED_SIMULATION_DUMP_FORMATS.get(dump_format)
    if suffix is None:
        raise RuntimeError(f"unsupported_dump_format:{dump_format}")
    return suffix


def _stable_json_for_hash(payload: Mapping[str, Any]) -> str:
    return json.dumps(dict(payload), sort_keys=True, separators=(",", ":"))


def _stable_string_list(values: Any) -> list[str]:
    return sorted({item for item in _as_string_list(values) if item})


def _cache_lineage_payload(manifest: Mapping[str, Any]) -> dict[str, Any]:
    performance_cfg = _performance_config(manifest)
    return {
        "schema_version": SIMULATION_CACHE_KEY_SCHEMA_VERSION,
        "lane": _as_text(manifest.get("lane")) or "equity",
        "dataset_id": _as_text(manifest.get("dataset_id")),
        "dataset_snapshot_ref": _as_text(manifest.get("dataset_snapshot_ref"))
        or _as_text(manifest.get("dataset_id")),
        "window": _as_mapping(manifest.get("window")),
        "strategy_spec_ref": _as_text(manifest.get("strategy_spec_ref")),
        "candidate_id": _as_text(manifest.get("candidate_id")),
        "baseline_candidate_id": _as_text(manifest.get("baseline_candidate_id")),
        "model_refs": _stable_string_list(manifest.get("model_refs")),
        "runtime_version_refs": _stable_string_list(
            manifest.get("runtime_version_refs")
        ),
        "dump_format": _as_text(performance_cfg.get("dump_format"))
        or DEFAULT_SIMULATION_DUMP_FORMAT,
        "profile": _as_text(performance_cfg.get("replay_profile"))
        or DEFAULT_SIMULATION_REPLAY_PROFILE,
    }


def _derived_simulation_cache_key(manifest: Mapping[str, Any]) -> str:
    payload = _cache_lineage_payload(manifest)
    return hashlib.sha256(_stable_json_for_hash(payload).encode("utf-8")).hexdigest()


def _derived_simulation_cache_paths(cache_key: str, dump_format: str) -> dict[str, str]:
    normalized_prefix = DEFAULT_SIMULATION_CACHE_PREFIX.strip("/")
    object_key = "/".join(
        part
        for part in (
            normalized_prefix,
            cache_key.strip(),
            f"source-dump{_dump_suffix(dump_format)}",
        )
        if part
    )
    artifact_path = f"s3://{DEFAULT_SIMULATION_CACHE_BUCKET}/{object_key}"
    return {
        "cache_artifact_path": artifact_path,
        "cache_manifest_path": f"{artifact_path}.manifest.json",
    }


def _cache_artifact_lineage_matches(
    *,
    manifest: Mapping[str, Any],
    artifact_manifest: Mapping[str, Any],
) -> bool:
    artifact_lineage = _as_mapping(artifact_manifest.get("lineage"))
    if not artifact_lineage:
        return False
    return artifact_lineage == _cache_lineage_payload(manifest)


def _state_paths(
    resources: SimulationResources,
    manifest: Mapping[str, Any] | None = None,
) -> tuple[Path, Path, Path]:
    run_dir = resources.output_root / resources.run_token
    state_path = run_dir / "state.json"
    run_manifest_path = run_dir / "run-manifest.json"
    dump_format = DEFAULT_SIMULATION_DUMP_FORMAT
    if manifest is not None:
        dump_format = (
            _as_text(_performance_config(manifest).get("dump_format"))
            or DEFAULT_SIMULATION_DUMP_FORMAT
        )
    dump_path = run_dir / f"source-dump{_dump_suffix(dump_format)}"
    return state_path, run_manifest_path, dump_path


def _dump_artifact_manifest_path(dump_path: Path) -> Path:
    return dump_path.with_suffix(dump_path.suffix + ".manifest.json")


def _dump_sort_stage_path(dump_path: Path) -> Path:
    return dump_path.with_suffix(dump_path.suffix + ".sort-stage.tsv")


def _dump_sort_output_path(dump_path: Path) -> Path:
    return dump_path.with_suffix(dump_path.suffix + ".sort-output.tsv")


def _dump_sort_key(
    *,
    source_timestamp_ms: int,
    source_topic: str,
    source_partition: int,
    source_offset: int,
) -> str:
    return "\t".join(
        (
            f"{source_timestamp_ms:020d}",
            source_topic,
            f"{source_partition:010d}",
            f"{source_offset:020d}",
        )
    )


def _materialize_deterministic_dump(
    *,
    staged_path: Path,
    dump_path: Path,
) -> str:
    from .resource_planning import _ensure_supported_binary

    _ensure_supported_binary("sort")
    sorted_path = _dump_sort_output_path(dump_path)
    sort_memory_limit = (
        _as_text(os.getenv("TORGHUT_SIM_DUMP_SORT_MEMORY_LIMIT"))
        or DEFAULT_SIMULATION_DUMP_SORT_MEMORY_LIMIT
    )
    sort_command = [
        "sort",
        "-S",
        sort_memory_limit,
        "-T",
        str(staged_path.parent),
        "-t",
        "\t",
        "-k1,1n",
        "-k2,2",
        "-k3,3n",
        "-k4,4n",
        str(staged_path),
    ]
    try:
        with sorted_path.open("w", encoding="utf-8") as sorted_handle:
            subprocess.run(
                sort_command,
                check=True,
                text=True,
                stdout=sorted_handle,
                stderr=subprocess.PIPE,
                env={**os.environ, "LC_ALL": "C"},
            )
    except FileNotFoundError as exc:
        raise RuntimeError(f"command_missing: sort: {exc.filename}") from exc
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or "").strip() or str(exc)
        raise RuntimeError(f"command_failed: sort: {detail}") from exc

    hasher = hashlib.sha256()
    with (
        sorted_path.open("r", encoding="utf-8") as sorted_handle,
        dump_path.open("w", encoding="utf-8") as dump_handle,
    ):
        for row in sorted_handle:
            parts = row.split("\t", 4)
            if len(parts) != 5:
                raise RuntimeError("deterministic_dump_sort_row_invalid")
            line = parts[4]
            dump_handle.write(line)
            stripped = line.rstrip("\n")
            hasher.update(stripped.encode("utf-8"))
            hasher.update(b"\n")

    return hasher.hexdigest()


def _run_state_path(resources: SimulationResources) -> Path:
    run_dir = resources.output_root / resources.run_token
    return run_dir / "run-state.json"


def _artifact_path(resources: SimulationResources, filename: str) -> Path:
    run_dir = resources.output_root / resources.run_token
    return run_dir / filename


def _ta_restore_policy(manifest: Mapping[str, Any]) -> dict[str, Any]:
    ta_restore = _as_mapping(manifest.get("ta_restore"))
    replay_profile = (
        _as_text(_performance_config(manifest).get("replay_profile"))
        or DEFAULT_SIMULATION_REPLAY_PROFILE
    )
    explicit_mode = (_as_text(ta_restore.get("mode")) or "").strip().lower()
    mode = explicit_mode
    source = "explicit"
    if not mode:
        # Historical replay must be deterministic on a frozen dump; do not resume prior
        # TA operator state unless a future lineage-aware restore contract exists.
        mode = "stateless"
        source = f"profile_default:{replay_profile}"
    allowed_modes = {"required", "stateless_if_missing", "stateless"}
    if mode not in allowed_modes:
        raise RuntimeError(
            "ta_restore.mode must be one of: required,stateless_if_missing,stateless"
        )
    return {
        "mode": mode,
        "source": source,
        "replay_profile": replay_profile,
        "stateless_recovery_enabled": mode in {"stateless_if_missing", "stateless"},
    }


__all__ = (
    "COMPONENT_ARTIFACTS",
    "COMPONENT_REPLAY",
    "COMPONENT_TA",
    "COMPONENT_TORGHUT",
    "CephS3Client",
    "DOC29_SIMULATION_FULL_DAY_GATE",
    "DOC29_SIMULATION_SMOKE_GATE",
    "EQUITY_SIMULATION_LANE",
    "SIMULATION_PROGRESS_COMPONENTS",
    "SessionLocal",
    "TRACE_STATUS_BLOCKED",
    "TRACE_STATUS_SATISFIED",
    "build_completion_trace",
    "build_fill_price_error_budget_report_v1",
    "persist_completion_trace",
    "run_autonomous_lane",
    "simulation_clickhouse_table_names",
    "simulation_lane_contract",
    "simulation_lane_contract_for_manifest",
    "simulation_schema_registry_subject_roles",
    "simulation_verification",
    "_artifact_path",
    "_cache_artifact_lineage_matches",
    "_cache_lineage_payload",
    "_derived_simulation_cache_key",
    "_derived_simulation_cache_paths",
    "_dump_artifact_manifest_path",
    "_dump_sort_key",
    "_dump_sort_output_path",
    "_dump_sort_stage_path",
    "_dump_suffix",
    "_expand_env_value_refs",
    "_kservice_container_with_env",
    "_kservice_env",
    "_materialize_deterministic_dump",
    "_merge_env_entries",
    "_performance_config",
    "_read_configmap_key_ref",
    "_read_secret_key_ref",
    "_recommended_simulation_feature_staleness_ms",
    "_resolve_kservice_env_values",
    "_resolve_warm_lane_runtime_postgres_config",
    "_run_state_path",
    "_set_argocd_application_ignore_differences",
    "_simulation_account_label",
    "_stable_json_for_hash",
    "_stable_string_list",
    "_state_paths",
    "_ta_restore_policy",
    "_torghut_env_overrides_from_manifest",
    "_wait_for_argocd_application_mode",
)
