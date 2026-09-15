#!/usr/bin/env python3
"""Single-entrypoint historical simulation workflow for Torghut."""

from __future__ import annotations

from pathlib import Path

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

from .simulation_context import APPLY_CONFIRMATION_PHRASE
from .runtime_config import (
    _as_mapping,
    _as_text,
    _build_clickhouse_runtime_config,
    _build_kafka_runtime_config,
    _load_manifest,
    _parse_args,
    _redact_dsn_credentials,
)
from .resource_planning import (
    _build_argocd_automation_config,
    _build_autonomy_lane_config,
    _build_postgres_runtime_config,
    _build_resources,
    _build_rollouts_analysis_config,
    _canonicalize_warm_lane_manifest,
    _default_simulation_postgres_db,
    _run_simulation_autonomy_lane,
)
from .service_environment import _resolve_warm_lane_runtime_postgres_config
from .state_and_cache import _log_script_event
from .storage_and_database import _build_plan_report
from .replay_execution import (
    _apply,
    _teardown,
)
from .argocd_rollouts import _report_simulation
from .lifecycle import (
    _render_report,
    _run_full_lifecycle,
)

_monitor_snapshot = simulation_verification._monitor_snapshot

_runtime_verify = simulation_verification._runtime_verify

_signal_snapshot = simulation_verification._signal_snapshot

_validate_dump_coverage = simulation_verification._validate_dump_coverage

_validate_window_policy = simulation_verification._validate_window_policy

_verify_isolation_guards = simulation_verification._verify_isolation_guards


def main() -> None:
    args = _parse_args()
    manifest_path = Path(args.dataset_manifest)
    _log_script_event(
        "starting_simulation",
        mode=args.mode,
        run_id=args.run_id,
        dataset_manifest=str(manifest_path),
        json_output=bool(args.json),
        confirm_phrase_provided=bool(args.confirm),
    )
    manifest = _load_manifest(manifest_path)
    window = _as_mapping(manifest.get("window"))
    _log_script_event(
        "manifest_loaded",
        dataset_id=_as_text(manifest.get("dataset_id")) or "missing",
        trading_day=_as_text(window.get("trading_day")),
        start=_as_text(window.get("start")),
        end=_as_text(window.get("end")),
        min_coverage_minutes=_as_text(window.get("min_coverage_minutes")),
        strict_coverage_ratio=window.get("strict_coverage_ratio"),
    )
    resources = _build_resources(args.run_id, manifest)
    manifest = _canonicalize_warm_lane_manifest(manifest, resources=resources)
    _log_script_event(
        "resources_built",
        run_token=resources.run_token,
        dataset_id=resources.dataset_id,
        output_root=str(resources.output_root),
        namespace=resources.namespace,
        ta_configmap=resources.ta_configmap,
        ta_deployment=resources.ta_deployment,
    )
    kafka_config = _build_kafka_runtime_config(manifest)
    _log_script_event(
        "kafka_config_ready",
        bootstrap_servers=kafka_config.bootstrap_servers,
        runtime_bootstrap_servers=kafka_config.runtime_bootstrap,
        security_protocol=kafka_config.security_protocol,
        runtime_security_protocol=kafka_config.runtime_security,
        sasl_mechanism=kafka_config.sasl_mechanism,
        runtime_sasl_mechanism=kafka_config.runtime_sasl,
        runtime_username_present=bool(kafka_config.runtime_username),
        runtime_password_present=bool(kafka_config.runtime_password),
    )
    clickhouse_config = _build_clickhouse_runtime_config(manifest)
    _log_script_event(
        "clickhouse_config_ready",
        http_url=clickhouse_config.http_url,
        username=clickhouse_config.username or "none",
        password_present=bool(clickhouse_config.password),
    )
    argocd_config = _build_argocd_automation_config(manifest)
    _log_script_event(
        "argocd_config_ready",
        manage_automation=argocd_config.manage_automation,
        applicationset_name=argocd_config.applicationset_name,
        app_name=argocd_config.app_name,
        desired_mode_during_run=argocd_config.desired_mode_during_run,
    )
    rollouts_config = _build_rollouts_analysis_config(manifest)
    _log_script_event(
        "rollouts_config_ready",
        enabled=rollouts_config.enabled,
        namespace=rollouts_config.namespace,
        runtime_template=rollouts_config.runtime_template,
        activity_template=rollouts_config.activity_template,
        teardown_template=rollouts_config.teardown_template,
    )
    autonomy_config = _build_autonomy_lane_config(
        manifest,
        manifest_path=manifest_path,
        resources=resources,
    )
    _log_script_event(
        "autonomy_config_ready",
        enabled=autonomy_config.enabled,
        signals_path=str(autonomy_config.signals_path)
        if autonomy_config.signals_path is not None
        else None,
        strategy_config_path=(
            str(autonomy_config.strategy_config_path)
            if autonomy_config.strategy_config_path is not None
            else None
        ),
        gate_policy_path=str(autonomy_config.gate_policy_path)
        if autonomy_config.gate_policy_path is not None
        else None,
        output_dir=str(autonomy_config.output_dir)
        if autonomy_config.output_dir is not None
        else None,
        promotion_target=autonomy_config.promotion_target,
    )
    postgres_config = _build_postgres_runtime_config(
        manifest,
        simulation_db=_default_simulation_postgres_db(resources),
    )
    if resources.warm_lane_enabled:
        postgres_config = _resolve_warm_lane_runtime_postgres_config(
            resources=resources,
            postgres_config=postgres_config,
        )
    _log_script_event(
        "postgres_config_ready",
        admin_dsn=_redact_dsn_credentials(postgres_config.admin_dsn),
        simulation_dsn=_redact_dsn_credentials(postgres_config.simulation_dsn),
        runtime_simulation_dsn=_redact_dsn_credentials(
            postgres_config.torghut_runtime_dsn
        ),
        simulation_db=postgres_config.simulation_db,
        migration_command=postgres_config.migrations_command,
    )

    plan_report = _build_plan_report(
        resources=resources,
        kafka_config=kafka_config,
        clickhouse_config=clickhouse_config,
        postgres_config=postgres_config,
        argocd_config=argocd_config,
        manifest=manifest,
    )

    if args.mode == "plan":
        _log_script_event("plan_mode_start")
        _render_report(plan_report, json_only=args.json)
        return

    if args.mode == "apply":
        _log_script_event("apply_mode_start")
        if args.confirm != APPLY_CONFIRMATION_PHRASE:
            raise SystemExit(
                f"--confirm must equal {APPLY_CONFIRMATION_PHRASE!r} when mode=apply"
            )
        report = _apply(
            resources=resources,
            manifest=manifest,
            kafka_config=kafka_config,
            clickhouse_config=clickhouse_config,
            postgres_config=postgres_config,
            argocd_config=argocd_config,
            force_dump=bool(args.force_dump),
            force_replay=bool(args.force_replay),
        )
        _render_report(report, json_only=args.json)
        return

    if args.mode == "report":
        _log_script_event("report_mode_start")
        report = _report_simulation(
            resources=resources,
            manifest_path=manifest_path,
            postgres_config=postgres_config,
            clickhouse_config=clickhouse_config,
        )
        autonomy_report = _run_simulation_autonomy_lane(
            resources=resources,
            autonomy_config=autonomy_config,
        )
        if autonomy_report is not None:
            report = dict(report)
            report["autonomy"] = autonomy_report
        if not args.skip_teardown:
            teardown_report = _teardown(
                resources=resources,
                allow_missing_state=True,
            )
            report = dict(report)
            report["teardown"] = teardown_report
        _render_report(report, json_only=args.json)
        return

    if args.mode == "run":
        _log_script_event("run_mode_start")
        if args.confirm != APPLY_CONFIRMATION_PHRASE:
            raise SystemExit(
                f"--confirm must equal {APPLY_CONFIRMATION_PHRASE!r} when mode=run"
            )
        report = _run_full_lifecycle(
            resources=resources,
            manifest=manifest,
            manifest_path=manifest_path,
            autonomy_config=autonomy_config,
            kafka_config=kafka_config,
            clickhouse_config=clickhouse_config,
            postgres_config=postgres_config,
            argocd_config=argocd_config,
            rollouts_config=rollouts_config,
            force_dump=bool(args.force_dump),
            force_replay=bool(args.force_replay),
            skip_teardown=bool(args.skip_teardown),
            report_only=bool(args.report_only),
        )
        _render_report(report, json_only=args.json)
        return

    report = _teardown(
        resources=resources,
        allow_missing_state=bool(args.allow_missing_state),
    )
    _render_report(report, json_only=args.json)


if __name__ == "__main__":
    main()


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
    "main",
    "persist_completion_trace",
    "run_autonomous_lane",
    "simulation_clickhouse_table_names",
    "simulation_lane_contract",
    "simulation_lane_contract_for_manifest",
    "simulation_schema_registry_subject_roles",
    "simulation_verification",
    "_monitor_snapshot",
    "_runtime_verify",
    "_signal_snapshot",
    "_validate_dump_coverage",
    "_validate_window_policy",
    "_verify_isolation_guards",
)
