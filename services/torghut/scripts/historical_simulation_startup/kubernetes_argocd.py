#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence, cast

import psycopg
import yaml
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
    POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS,
    SIMULATION_RUNTIME_LOCK_NAME,
    SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_JQ,
    TRANSIENT_POSTGRES_RETRY_ATTEMPTS,
    TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS,
)
from .runtime_config import (
    ArgocdAutomationConfig,
    SimulationResources,
    _as_mapping,
    _as_text,
    _safe_int,
)
from .resource_planning import (
    _is_transient_postgres_error,
    _run_command,
)


def _is_vector_extension_create_permission_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(
        marker in message
        for marker in POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS
    )


def _postgres_extension_exists(cursor: psycopg.Cursor, extension: str) -> bool:
    cursor.execute(
        "SELECT 1 FROM pg_extension WHERE extname = %s LIMIT 1", (extension,)
    )
    return cursor.fetchone() is not None


def _run_with_transient_postgres_retry(
    *,
    label: str,
    operation: Callable[[], Any],
    attempts: int = TRANSIENT_POSTGRES_RETRY_ATTEMPTS,
    sleep_seconds: float = TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS,
) -> Any:
    if attempts <= 0:
        raise RuntimeError(f"{label}: attempts must be > 0")
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except (
            Exception
        ) as exc:  # pragma: no cover - exercised by integration/runtime failures
            if not _is_transient_postgres_error(exc):
                raise
            last_error = exc
            if attempt >= attempts:
                break
            time.sleep(sleep_seconds * attempt)
    if last_error is None:
        raise RuntimeError(
            f"{label}: transient retry failed without captured exception"
        )
    raise RuntimeError(
        f"{label}: exhausted transient retries: {last_error}"
    ) from last_error


def _kubectl_json(namespace: str, args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(["kubectl", "-n", namespace, *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError("kubectl did not return a mapping payload")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _kubectl_json_global(args: Sequence[str]) -> dict[str, Any]:
    result = _run_command(["kubectl", *args])
    payload = json.loads(result.stdout)
    if not isinstance(payload, Mapping):
        raise RuntimeError("kubectl did not return a mapping payload")
    return {str(key): value for key, value in cast(Mapping[str, Any], payload).items()}


def _kubectl_apply(namespace: str, payload: Mapping[str, Any]) -> None:
    _run_command(
        ["kubectl", "-n", namespace, "apply", "-f", "-"],
        input_text=yaml.safe_dump(dict(payload), sort_keys=False),
    )


def _kubectl_delete(namespace: str, kind: str, name: str) -> None:
    _run_command(
        [
            "kubectl",
            "-n",
            namespace,
            "delete",
            kind,
            name,
            "--ignore-not-found=true",
        ]
    )


def _kubectl_delete_if_exists(namespace: str, kind: str, name: str) -> None:
    _run_command(
        [
            "kubectl",
            "-n",
            namespace,
            "delete",
            kind,
            name,
            "--ignore-not-found=true",
            "--wait=false",
        ]
    )


def _kubectl_patch(
    namespace: str, kind: str, name: str, patch: Mapping[str, Any]
) -> None:
    _run_command(
        [
            "kubectl",
            "-n",
            namespace,
            "patch",
            kind,
            name,
            "--type",
            "merge",
            "-p",
            json.dumps(dict(patch), separators=(",", ":")),
        ]
    )


def _kubectl_patch_json(
    namespace: str,
    kind: str,
    name: str,
    patch_ops: Sequence[Mapping[str, Any]],
) -> None:
    _run_command(
        [
            "kubectl",
            "-n",
            namespace,
            "patch",
            kind,
            name,
            "--type",
            "-p",
            json.dumps(list(patch_ops), separators=(",", ":")),
        ]
    )


def _json_pointer_escape(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _json_pointer_unescape(value: str) -> str:
    return value.replace("~1", "/").replace("~0", "~")


def _discover_applicationset_entry(
    node: Any,
    *,
    app_name: str,
    path: str = "",
) -> tuple[str, dict[str, Any]] | None:
    if isinstance(node, Mapping):
        elements = node.get("elements")
        if isinstance(elements, list):
            elements_path = f"{path}/{_json_pointer_escape('elements')}"
            for idx, entry in enumerate(elements):
                if not isinstance(entry, Mapping):
                    continue
                name = _as_text(entry.get("name"))
                if name == app_name:
                    pointer = f"{elements_path}/{idx}"
                    return pointer, _clone_json_mapping(entry) or {}
        for key, value in node.items():
            child_path = f"{path}/{_json_pointer_escape(str(key))}"
            found = _discover_applicationset_entry(
                value, app_name=app_name, path=child_path
            )
            if found is not None:
                return found
        return None
    if isinstance(node, list):
        for idx, value in enumerate(node):
            child_path = f"{path}/{idx}"
            found = _discover_applicationset_entry(
                value, app_name=app_name, path=child_path
            )
            if found is not None:
                return found
    return None


def _read_argocd_applicationset_entry(
    *,
    config: ArgocdAutomationConfig,
) -> dict[str, Any]:
    payload = _kubectl_json_global(
        [
            "-n",
            config.applicationset_namespace,
            "get",
            "applicationset",
            config.applicationset_name,
            "-o",
        ]
    )
    discovered = _discover_applicationset_entry(payload, app_name=config.app_name)
    if discovered is None:
        raise RuntimeError(
            "argocd_applicationset_entry_not_found "
            f"applicationset={config.applicationset_name} app={config.app_name}"
        )
    pointer, entry = discovered
    automation = _as_text(entry.get("automation"))
    if automation is None:
        raise RuntimeError(
            "argocd_automation_path_not_found "
            f"applicationset={config.applicationset_name} app={config.app_name}"
        )
    return {
        "pointer": pointer,
        "entry": entry,
        "automation_pointer": f"{pointer}/{_json_pointer_escape('automation')}",
        "mode": _normalized_automation_mode(automation),
        "ignore_differences": _clone_json_list(
            cast(Sequence[Any] | None, entry.get("ignoreDifferences"))
            if isinstance(entry.get("ignoreDifferences"), list)
            else None
        ),
    }


def _json_pointer_get(payload: Any, pointer: str) -> Any:
    if pointer == "":
        return payload
    current = payload
    for token in pointer.lstrip("/").split("/"):
        part = _json_pointer_unescape(token)
        if isinstance(current, list):
            index = _safe_int(part, default=-1)
            if index < 0 or index >= len(current):
                raise RuntimeError(f"invalid_json_pointer:{pointer}")
            current = current[index]
            continue
        if isinstance(current, Mapping):
            if part not in current:
                raise RuntimeError(f"invalid_json_pointer:{pointer}")
            current = current[part]
            continue
        raise RuntimeError(f"invalid_json_pointer:{pointer}")
    return current


def _normalized_automation_mode(value: str | None) -> str:
    normalized = (value or "").strip().lower()
    if normalized not in {"manual", "auto"}:
        raise RuntimeError(f"unsupported_automation_mode:{value}")
    return normalized


def _clone_json_mapping(value: Mapping[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    return cast(dict[str, Any], json.loads(json.dumps(dict(value))))


def _clone_json_list(value: Sequence[Any] | None) -> list[Any] | None:
    if value is None:
        return None
    return cast(list[Any], json.loads(json.dumps(list(value))))


def _simulation_lock_payload(
    *,
    resources: SimulationResources,
    state_path: Path,
) -> dict[str, str]:
    return {
        "run_id": resources.run_id,
        "run_token": resources.run_token,
        "dataset_id": resources.dataset_id,
        "state_path": str(state_path),
        "acquired_at": datetime.now(timezone.utc).isoformat(),
    }


def _read_simulation_runtime_lock(namespace: str) -> dict[str, str] | None:
    try:
        payload = _kubectl_json(
            namespace, ["get", "configmap", SIMULATION_RUNTIME_LOCK_NAME, "-o", "json"]
        )
    except RuntimeError as exc:
        if "notfound" in str(exc).lower():
            return None
        raise
    data = _as_mapping(payload.get("data"))
    return {str(key): str(value) for key, value in data.items()}


def _acquire_simulation_runtime_lock(
    *,
    resources: SimulationResources,
    state_path: Path,
) -> dict[str, str]:
    payload = _simulation_lock_payload(resources=resources, state_path=state_path)
    try:
        _run_command(
            [
                "kubectl",
                "-n",
                resources.namespace,
                "create",
                "configmap",
                SIMULATION_RUNTIME_LOCK_NAME,
                *(f"--from-literal={key}={value}" for key, value in payload.items()),
            ]
        )
        return {
            "status": "acquired",
            **payload,
        }
    except RuntimeError as exc:
        if "already exists" not in str(exc).lower():
            raise
    existing = _read_simulation_runtime_lock(resources.namespace)
    if existing is None:
        raise RuntimeError("simulation_runtime_lock_missing_after_conflict")
    if existing.get("run_id") == resources.run_id:
        return {
            "status": "reused",
            **existing,
        }
    raise RuntimeError(
        "simulation_runtime_lock_held:"
        f"{existing.get('run_id') or 'unknown'}:"
        f"{existing.get('dataset_id') or 'unknown'}"
    )


def _release_simulation_runtime_lock(
    *,
    resources: SimulationResources,
) -> dict[str, str]:
    existing = _read_simulation_runtime_lock(resources.namespace)
    if existing is None:
        return {"status": "missing"}
    if existing.get("run_id") != resources.run_id:
        return {
            "status": "not_owner",
            **existing,
        }
    _kubectl_delete(resources.namespace, "configmap", SIMULATION_RUNTIME_LOCK_NAME)
    return {
        "status": "released",
        **existing,
    }


def _read_argocd_automation_mode(
    *,
    config: ArgocdAutomationConfig,
) -> dict[str, Any]:
    entry_state = _read_argocd_applicationset_entry(config=config)
    return {
        "pointer": entry_state["automation_pointer"],
        "mode": entry_state["mode"],
    }


def _set_argocd_automation_mode(
    *,
    config: ArgocdAutomationConfig,
    desired_mode: str,
) -> dict[str, Any]:
    normalized_desired = _normalized_automation_mode(desired_mode)
    state = _read_argocd_applicationset_entry(config=config)
    pointer = str(state["automation_pointer"])
    current_mode = _normalized_automation_mode(_as_text(state.get("mode")))
    changed = current_mode != normalized_desired
    if changed:
        _kubectl_patch_json(
            config.applicationset_namespace,
            "applicationset",
            config.applicationset_name,
            [
                {
                    "op": "replace",
                    "path": pointer,
                    "value": normalized_desired,
                }
            ],
        )

    started = datetime.now(timezone.utc)
    deadline = started + timedelta(seconds=config.verify_timeout_seconds)
    verified_mode = current_mode
    while True:
        verified_state = _read_argocd_applicationset_entry(config=config)
        pointer_observed = str(verified_state["automation_pointer"])
        if pointer_observed != pointer:
            raise RuntimeError(
                "argocd_automation_pointer_changed "
                f"expected={pointer} observed={pointer_observed}"
            )
        verified_mode = _normalized_automation_mode(
            _as_text(verified_state.get("mode"))
        )
        if verified_mode == normalized_desired:
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                "argocd_automation_verify_timeout "
                f"desired={normalized_desired} observed={verified_mode}"
            )
        time.sleep(2)

    return {
        "pointer": pointer,
        "previous_mode": current_mode,
        "desired_mode": normalized_desired,
        "current_mode": verified_mode,
        "changed": changed,
    }


def _argocd_application_mode_from_sync_policy(
    sync_policy: Mapping[str, Any] | None,
) -> str:
    if sync_policy is None:
        return "manual"
    automated = _as_mapping(sync_policy.get("automated"))
    if not automated:
        return "manual"
    enabled = automated.get("enabled")
    return "auto" if bool(enabled) else "manual"


def _read_named_argocd_application_sync_policy(
    *,
    namespace: str,
    app_name: str,
) -> dict[str, Any]:
    payload = _kubectl_json_global(
        [
            "-n",
            namespace,
            "get",
            "application",
            app_name,
            "-o",
        ]
    )
    spec = _as_mapping(payload.get("spec"))
    sync_policy_raw = spec.get("syncPolicy")
    sync_policy = _clone_json_mapping(
        _as_mapping(sync_policy_raw) if isinstance(sync_policy_raw, Mapping) else None
    )
    ignore_differences_raw = spec.get("ignoreDifferences")
    ignore_differences = _clone_json_list(
        cast(Sequence[Any] | None, ignore_differences_raw)
        if isinstance(ignore_differences_raw, list)
        else None
    )
    automation_mode = _argocd_application_mode_from_sync_policy(sync_policy)
    return {
        "sync_policy": sync_policy,
        "ignore_differences": ignore_differences,
        "automation_mode": automation_mode,
    }


def _read_argocd_application_sync_policy(
    *,
    config: ArgocdAutomationConfig,
) -> dict[str, Any]:
    return _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=config.app_name,
    )


def _manual_argocd_application_sync_policy(
    current_sync_policy: Mapping[str, Any] | None,
) -> dict[str, Any]:
    manual_policy = _clone_json_mapping(current_sync_policy) or {}
    if _argocd_application_mode_from_sync_policy(manual_policy) == "manual":
        return manual_policy
    # Argo normalizes manual Applications by removing automated/retry keys
    # instead of persisting an explicit automated.enabled=false shape.
    manual_policy.pop("automated", None)
    manual_policy.pop("retry", None)
    return manual_policy


def _set_argocd_application_sync_policy(
    *,
    config: ArgocdAutomationConfig,
    app_name: str | None = None,
    desired_sync_policy: Mapping[str, Any] | None,
) -> dict[str, Any]:
    desired_policy = _clone_json_mapping(desired_sync_policy)
    target_app_name = app_name or config.app_name
    state = _read_named_argocd_application_sync_policy(
        namespace=config.applicationset_namespace,
        app_name=target_app_name,
    )
    current_policy = _clone_json_mapping(
        cast(Mapping[str, Any] | None, state.get("sync_policy"))
    )
    changed = current_policy != desired_policy
    if changed:
        if desired_policy is None:
            _kubectl_patch_json(
                config.applicationset_namespace,
                "application",
                target_app_name,
                [{"op": "remove", "path": "/spec/syncPolicy"}],
            )
        else:
            _kubectl_patch(
                config.applicationset_namespace,
                "application",
                target_app_name,
                {"spec": {"syncPolicy": desired_policy}},
            )

    deadline = datetime.now(timezone.utc) + timedelta(
        seconds=config.verify_timeout_seconds
    )
    verified_policy = current_policy
    while True:
        verified_state = _read_named_argocd_application_sync_policy(
            namespace=config.applicationset_namespace,
            app_name=target_app_name,
        )
        verified_policy = _clone_json_mapping(
            cast(Mapping[str, Any] | None, verified_state.get("sync_policy"))
        )
        if verified_policy == desired_policy:
            break
        if datetime.now(timezone.utc) >= deadline:
            raise RuntimeError(
                "argocd_application_sync_policy_verify_timeout "
                f"desired={json.dumps(desired_policy, sort_keys=True)} "
                f"observed={json.dumps(verified_policy, sort_keys=True)}"
            )
        time.sleep(2)

    return {
        "previous_sync_policy": current_policy,
        "current_sync_policy": verified_policy,
        "changed": changed,
    }


def _normalized_argocd_ignore_difference_rule(
    rule: Mapping[str, Any],
) -> dict[str, Any]:
    normalized_rule = _clone_json_mapping(rule) or {}
    for key in ("group", "name", "namespace"):
        value = _as_text(normalized_rule.get(key))
        if value:
            normalized_rule[key] = value
        else:
            normalized_rule.pop(key, None)
    for key in ("jsonPointers", "jqPathExpressions", "managedFieldsManagers"):
        values = normalized_rule.get(key)
        if not isinstance(values, list):
            continue
        normalized_rule[key] = sorted(
            _as_text(item) or "" for item in values if _as_text(item)
        )
    return normalized_rule


def _normalized_argocd_ignore_differences(
    ignore_differences: Sequence[Mapping[str, Any]] | None,
) -> list[dict[str, Any]]:
    if not ignore_differences:
        return []
    normalized_rules = [
        _normalized_argocd_ignore_difference_rule(rule) for rule in ignore_differences
    ]
    normalized_rules.sort(
        key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":"))
    )
    return normalized_rules


def _simulation_runtime_argocd_ignore_differences(
    *,
    resources: SimulationResources,
) -> list[dict[str, Any]]:
    return [
        {
            "group": "serving.knative.dev",
            "kind": "Service",
            "namespace": resources.namespace,
            "name": resources.torghut_service,
            "jqPathExpressions": [SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_JQ],
        },
        {
            "group": "flink.apache.org",
            "kind": "FlinkDeployment",
            "namespace": resources.namespace,
            "name": resources.ta_deployment,
            "jsonPointers": [
                "/spec/job/state",
                "/spec/job/upgradeMode",
                "/spec/restartNonce",
            ],
        },
    ]


def _merge_argocd_application_ignore_differences(
    *,
    current_ignore_differences: Sequence[Mapping[str, Any]] | None,
    resources: SimulationResources,
) -> list[dict[str, Any]]:
    merged_rules = _normalized_argocd_ignore_differences(current_ignore_differences)
    existing_keys = {
        json.dumps(rule, sort_keys=True, separators=(",", ":")) for rule in merged_rules
    }
    for rule in _simulation_runtime_argocd_ignore_differences(resources=resources):
        normalized_rule = _normalized_argocd_ignore_difference_rule(rule)
        normalized_key = json.dumps(
            normalized_rule, sort_keys=True, separators=(",", ":")
        )
        if normalized_key in existing_keys:
            continue
        merged_rules.append(normalized_rule)
        existing_keys.add(normalized_key)
    merged_rules.sort(
        key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":"))
    )
    return merged_rules


def _argocd_ignore_differences_cover_runtime_mutations(
    *,
    current_ignore_differences: Sequence[Mapping[str, Any]] | None,
    resources: SimulationResources,
) -> bool:
    return _argocd_ignore_differences_cover_required_rules(
        current_ignore_differences=current_ignore_differences,
        required_ignore_differences=_simulation_runtime_argocd_ignore_differences(
            resources=resources
        ),
    )


def _argocd_ignore_differences_cover_required_rules(
    *,
    current_ignore_differences: Sequence[Mapping[str, Any]] | None,
    required_ignore_differences: Sequence[Mapping[str, Any]] | None,
) -> bool:
    current_rules = {
        json.dumps(rule, sort_keys=True, separators=(",", ":"))
        for rule in _normalized_argocd_ignore_differences(current_ignore_differences)
    }
    required_rules = {
        json.dumps(rule, sort_keys=True, separators=(",", ":"))
        for rule in _normalized_argocd_ignore_differences(required_ignore_differences)
    }
    return required_rules.issubset(current_rules)


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
    "_acquire_simulation_runtime_lock",
    "_argocd_application_mode_from_sync_policy",
    "_argocd_ignore_differences_cover_required_rules",
    "_argocd_ignore_differences_cover_runtime_mutations",
    "_clone_json_list",
    "_clone_json_mapping",
    "_discover_applicationset_entry",
    "_is_vector_extension_create_permission_error",
    "_json_pointer_escape",
    "_json_pointer_get",
    "_json_pointer_unescape",
    "_kubectl_apply",
    "_kubectl_delete",
    "_kubectl_delete_if_exists",
    "_kubectl_json",
    "_kubectl_json_global",
    "_kubectl_patch",
    "_kubectl_patch_json",
    "_manual_argocd_application_sync_policy",
    "_merge_argocd_application_ignore_differences",
    "_normalized_argocd_ignore_difference_rule",
    "_normalized_argocd_ignore_differences",
    "_normalized_automation_mode",
    "_postgres_extension_exists",
    "_read_argocd_application_sync_policy",
    "_read_argocd_applicationset_entry",
    "_read_argocd_automation_mode",
    "_read_named_argocd_application_sync_policy",
    "_read_simulation_runtime_lock",
    "_release_simulation_runtime_lock",
    "_run_with_transient_postgres_retry",
    "_set_argocd_application_sync_policy",
    "_set_argocd_automation_mode",
    "_simulation_lock_payload",
    "_simulation_runtime_argocd_ignore_differences",
)
