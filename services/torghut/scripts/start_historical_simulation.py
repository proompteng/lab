from __future__ import annotations

from scripts.start_historical_simulation_modules import (  # noqa: F401
    APPLY_CONFIRMATION_PHRASE,
    Any,
    COMPONENT_ARTIFACTS,
    COMPONENT_REPLAY,
    COMPONENT_TA,
    COMPONENT_TORGHUT,
    Callable,
    CephS3Client,
    DEFAULT_ARGOCD_APPSET_NAME,
    DEFAULT_ARGOCD_APP_NAME,
    DEFAULT_ARGOCD_NAMESPACE,
    DEFAULT_ARGOCD_ROOT_APP_NAME,
    DEFAULT_ARGOCD_RUN_MODE,
    DEFAULT_COVERAGE_STRICT_RATIO,
    DEFAULT_NAMESPACE,
    DEFAULT_OUTPUT_ROOT,
    DEFAULT_ROLLOUTS_ACTIVITY_TEMPLATE,
    DEFAULT_ROLLOUTS_ARTIFACT_TEMPLATE,
    DEFAULT_ROLLOUTS_NAMESPACE,
    DEFAULT_ROLLOUTS_RUNTIME_TEMPLATE,
    DEFAULT_ROLLOUTS_TEARDOWN_TEMPLATE,
    DEFAULT_ROLLOUTS_VERIFY_POLL_SECONDS,
    DEFAULT_ROLLOUTS_VERIFY_TIMEOUT_SECONDS,
    DEFAULT_RUN_MONITOR_CURSOR_GRACE_SECONDS,
    DEFAULT_RUN_MONITOR_MIN_DECISIONS,
    DEFAULT_RUN_MONITOR_MIN_EXECUTIONS,
    DEFAULT_RUN_MONITOR_MIN_ORDER_EVENTS,
    DEFAULT_RUN_MONITOR_MIN_TCA,
    DEFAULT_RUN_MONITOR_POLL_SECONDS,
    DEFAULT_RUN_MONITOR_TIMEOUT_SECONDS,
    DEFAULT_SIMULATION_CACHE_BUCKET,
    DEFAULT_SIMULATION_CACHE_CEPH_TIMEOUT_SECONDS,
    DEFAULT_SIMULATION_CACHE_ENDPOINT,
    DEFAULT_SIMULATION_CACHE_PREFIX,
    DEFAULT_SIMULATION_DUMP_FORMAT,
    DEFAULT_SIMULATION_DUMP_SORT_MEMORY_LIMIT,
    DEFAULT_SIMULATION_REPLAY_PROFILE,
    DEFAULT_SIM_TA_CONFIGMAP,
    DEFAULT_SIM_TA_DEPLOYMENT,
    DEFAULT_SIM_TORGHUT_SERVICE,
    DEFAULT_TA_CONFIGMAP,
    DEFAULT_TA_DEPLOYMENT,
    DEFAULT_TORGHUT_SERVICE,
    DEFAULT_WARM_LANE_SIMULATION_DATABASE,
    DOC29_SIMULATION_FULL_DAY_GATE,
    DOC29_SIMULATION_SMOKE_GATE,
    Decimal,
    EMBEDDED_SCHEMA_REGISTRY_SCHEMA_BY_SUFFIX,
    EQUITY_SIMULATION_LANE,
    HTTPConnection,
    HTTPSConnection,
    KAFKA_API_VERSION,
    KAFKA_HOST_SUFFIX_FALLBACKS,
    KafkaRuntimeConfig,
    LEGACY_SIMULATION_STRATEGY_TOKENS,
    Mapping,
    NON_TRANSIENT_POSTGRES_ERROR_PATTERNS,
    POSTGRES_VECTOR_EXTENSION_PERMISSION_ERROR_MARKERS,
    PRODUCTION_TOPIC_BY_ROLE,
    Path,
    REPLAY_PROFILE_DEFAULTS,
    SCHEMA_REGISTRY_CONTENT_TYPE,
    SIMULATION_CACHE_KEY_SCHEMA_VERSION,
    SIMULATION_CACHE_UPLOAD_BYTES_PER_SECOND_FLOOR,
    SIMULATION_CACHE_UPLOAD_MIN_TIMEOUT_SECONDS,
    SIMULATION_CACHE_UPLOAD_RETRY_ATTEMPTS,
    SIMULATION_CACHE_UPLOAD_RETRY_SLEEP_SECONDS,
    SIMULATION_CACHE_UPLOAD_TIMEOUT_MAX_SECONDS,
    SIMULATION_CACHE_UPLOAD_TIMEOUT_SLACK_SECONDS,
    SIMULATION_CLICKHOUSE_SCHEMA_SOURCE_DATABASE,
    SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_ATTEMPTS,
    SIMULATION_CLICKHOUSE_TABLE_VISIBILITY_SLEEP_SECONDS,
    SIMULATION_FEATURE_STALENESS_MARGIN_MS,
    SIMULATION_FEATURE_STALENESS_MIN_MS,
    SIMULATION_POSTGRES_REQUIRED_METADATA_TABLES,
    SIMULATION_POSTGRES_RUNTIME_RESET_TABLES,
    SIMULATION_PROGRESS_COMPONENTS,
    SIMULATION_RUNTIME_LOCK_NAME,
    SIMULATION_TOPIC_BY_ROLE,
    SIMULATION_TORGHUT_ENV_OVERRIDE_ALLOWLIST,
    SIMULATION_TORGHUT_PATCH_ENV_KEYS,
    SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_JQ,
    SIMULATION_TORGHUT_RUNTIME_ENV_IGNORE_KEYS,
    SUPPORTED_SIMULATION_DUMP_FORMATS,
    Sequence,
    SessionLocal,
    TA_TOPIC_KEY_BY_ROLE,
    TORGHUT_ENV_KEYS,
    TRACE_STATUS_BLOCKED,
    TRACE_STATUS_SATISFIED,
    TRANSIENT_POSTGRES_ERROR_PATTERNS,
    TRANSIENT_POSTGRES_RETRY_ATTEMPTS,
    TRANSIENT_POSTGRES_RETRY_SLEEP_SECONDS,
    US_EQUITIES_REGULAR_MINUTES,
    US_EQUITIES_REGULAR_PROFILE,
    US_EQUITIES_REGULAR_TIMEZONE,
    VECTOR_EXTENSION_NAME,
    ZoneInfo,
    _ORIGINAL_GETADDRINFO,
    _cluster_service_host_candidates,
    _getaddrinfo_with_kafka_fallback,
    _kafka_host_candidates,
    annotations,
    argparse,
    asdict,
    base64,
    build_completion_trace,
    build_fill_price_error_budget_report_v1,
    cast,
    contextmanager,
    create_engine,
    dataclass,
    date,
    datetime,
    gzip,
    hashlib,
    importlib,
    json,
    os,
    persist_completion_trace,
    psycopg,
    quote,
    quote_plus,
    re,
    replace,
    run_autonomous_lane,
    sessionmaker,
    shlex,
    shutil,
    simulation_clickhouse_table_names,
    simulation_lane_contract,
    simulation_lane_contract_for_manifest,
    simulation_schema_registry_subject_roles,
    simulation_verification,
    socket,
    sql,
    subprocess,
    sys,
    time,
    timedelta,
    timezone,
    unquote_plus,
    urlsplit,
    uuid,
    yaml,
    ArgocdAutomationConfig,
    AutonomyLaneConfig,
    ClickHouseRuntimeConfig,
    PostgresRuntimeConfig,
    RolloutsAnalysisConfig,
    SimulationResources,
    _as_mapping,
    _as_string_list,
    _as_text,
    _build_clickhouse_runtime_config,
    _build_kafka_runtime_config,
    _contains_legacy_strategy_reference,
    _database_name_from_dsn,
    _derive_simulation_dsn,
    _ensure_dsn_password,
    _experimental_allow_legacy_strategy,
    _load_manifest,
    _normalize_kubernetes_name_token,
    _normalize_run_token,
    _parse_args,
    _parse_optional_rfc3339_timestamp,
    _parse_rfc3339_timestamp,
    _redact_dsn_credentials,
    _replace_database_in_dsn,
    _replace_password_in_dsn,
    _resolve_manifest_relative_path,
    _resolve_window_bounds,
    _safe_float,
    _safe_int,
    _simulation_evidence_lineage,
    _truthy,
    _username_from_dsn,
    _validate_dump_coverage,
    _validate_simulation_strategy_policy,
    _validate_us_equities_regular_profile,
    _validate_window_policy,
    _window_min_coverage_minutes,
    _build_argocd_automation_config,
    _build_autonomy_lane_config,
    _build_postgres_runtime_config,
    _build_resources,
    _build_rollouts_analysis_config,
    _canonicalize_warm_lane_manifest,
    _default_simulation_postgres_db,
    _ensure_lz4_codec_available,
    _ensure_supported_binary,
    _find_vector_extension_blocking_revision,
    _is_transient_postgres_error,
    _merge_topics,
    _normalize_migrations_command,
    _replace_alembic_upgrade_target,
    _resolve_command_args,
    _run_alembic_upgrade,
    _run_command,
    _run_simulation_autonomy_lane,
    _ta_auto_offset_reset_key,
    _ta_clickhouse_url_key,
    _ta_group_id_key,
    _ta_topic_key_by_role,
    _warm_lane_enabled,
    _acquire_simulation_runtime_lock,
    _argocd_application_mode_from_sync_policy,
    _argocd_ignore_differences_cover_required_rules,
    _argocd_ignore_differences_cover_runtime_mutations,
    _clone_json_list,
    _clone_json_mapping,
    _discover_applicationset_entry,
    _is_vector_extension_create_permission_error,
    _json_pointer_escape,
    _json_pointer_get,
    _json_pointer_unescape,
    _kubectl_apply,
    _kubectl_delete,
    _kubectl_delete_if_exists,
    _kubectl_json,
    _kubectl_json_global,
    _kubectl_patch,
    _kubectl_patch_json,
    _manual_argocd_application_sync_policy,
    _merge_argocd_application_ignore_differences,
    _normalized_argocd_ignore_difference_rule,
    _normalized_argocd_ignore_differences,
    _normalized_automation_mode,
    _postgres_extension_exists,
    _read_argocd_application_sync_policy,
    _read_argocd_applicationset_entry,
    _read_argocd_automation_mode,
    _read_named_argocd_application_sync_policy,
    _read_simulation_runtime_lock,
    _release_simulation_runtime_lock,
    _run_with_transient_postgres_retry,
    _simulation_lock_payload,
    _simulation_runtime_argocd_ignore_differences,
    _artifact_path,
    _cache_artifact_lineage_matches,
    _cache_lineage_payload,
    _derived_simulation_cache_key,
    _derived_simulation_cache_paths,
    _dump_artifact_manifest_path,
    _dump_sort_key,
    _dump_sort_output_path,
    _dump_sort_stage_path,
    _dump_suffix,
    _expand_env_value_refs,
    _kservice_container_with_env,
    _kservice_env,
    _materialize_deterministic_dump,
    _merge_env_entries,
    _performance_config,
    _read_configmap_key_ref,
    _read_secret_key_ref,
    _recommended_simulation_feature_staleness_ms,
    _resolve_kservice_env_values,
    _run_state_path,
    _simulation_account_label,
    _stable_json_for_hash,
    _stable_string_list,
    _state_paths,
    _ta_restore_policy,
    _torghut_env_overrides_from_manifest,
    _wait_for_argocd_application_mode,
    _cache_metadata,
    _ensure_directory,
    _is_transient_simulation_cache_upload_error,
    _load_json,
    _log_script_event,
    _resolve_ta_restore_configuration,
    _restore_cached_dump_if_available,
    _s3_bucket_key,
    _save_json,
    _simulation_cache_client_from_env,
    _simulation_cache_upload_attempts,
    _simulation_cache_upload_timeout_seconds,
    _ta_restore_paths,
    _update_run_state,
    _upsert_simulation_progress_row,
    _utc_from_millis,
    _write_dump_marker,
    _write_dump_marker_from_manifest,
    _build_plan_report,
    _clickhouse_database_precreated,
    _dump_marker_path,
    _file_sha256,
    _http_request,
    _load_optional_json,
    _parse_dump_timestamp_bounds,
    _postgres_database_precreated,
    _reusable_dump_report,
    _rewrite_clickhouse_table_ddl_for_simulation,
    _scan_dump_timestamp_bounds,
    _show_create_clickhouse_table,
    _capture_cluster_state,
    _clickhouse_jdbc_url_for_database,
    _remove_appledouble_sidecars,
    _restart_ta_deployment,
    _restore_ta_configuration_required,
    _runtime_sessionmaker,
    _supersede_stale_simulation_progress_rows,
    _ta_runtime_reconfigure_required,
    _torghut_service_reconfigure_required,
    _upsert_simulation_runtime_context,
    _b64_to_bytes,
    _bytes_to_b64,
    _condition_status,
    _consumer_for_dump,
    _deployment_replica_health,
    _fink_runtime_health,
    _headers_to_json,
    _json_to_headers,
    _kafka_admin_client,
    _kafka_available_broker_count,
    _load_schema_registry_schema_literal,
    _offset_for_time_lookup,
    _producer_for_replay,
    _resolve_schema_registry_schema_path,
    _restore_torghut_env_required,
    _source_topic_partition_counts,
    _compress_dump_file,
    _count_lines,
    _dump_format_for_path,
    _dump_sha256_for_replay,
    _open_dump_reader,
    _pacing_delay_seconds,
    _producer_flush_with_retry,
    _verify_isolation_guards,
    _analysis_run_args,
    _analysis_run_name,
    _build_fill_price_error_budget_payload,
    _decimal_or_zero,
    _doc29_simulation_gate_ids,
    _has_decimal_value,
    _render_analysis_run_spec,
    _torghut_service_revision_ready,
    _wait_for_analysis_run,
    _wait_for_runtime_verify,
    _build_gate_input,
    _build_performance_report,
    _build_run_summary,
    _build_simulation_completion_trace,
    _build_strategy_proof_artifact,
    _completion_trace_coverage_ratio,
    _existing_artifact_refs,
    _render_report,
    _monitor_snapshot,
    _signal_snapshot,
)

from scripts.start_historical_simulation_modules import (
    argocd_rollouts as _argocd_rollouts_module,
    cli as _cli_module,
    kafka_runtime as _kafka_runtime_module,
    kubernetes_argocd as _kubernetes_argocd_module,
    lifecycle as _lifecycle_module,
    proof_artifacts as _proof_artifacts_module,
    replay_execution as _replay_execution_module,
    resource_planning as _resource_planning_module,
    runtime_migrations as _runtime_migrations_module,
    service_environment as _service_environment_module,
    state_and_cache as _state_and_cache_module,
    storage_and_database as _storage_and_database_module,
    topic_dumping as _topic_dumping_module,
)

_ORIGINAL_APPLY = _replay_execution_module._apply
_ORIGINAL_CLICKHOUSE_QUERY_CONFIGS = (
    _storage_and_database_module._clickhouse_query_configs
)
_ORIGINAL_ASSERT_REQUIRED_SIMULATION_METADATA_TABLES = (
    _runtime_migrations_module._assert_required_simulation_metadata_tables
)
_ORIGINAL_CONFIGURE_TA_FOR_SIMULATION = (
    _runtime_migrations_module._configure_ta_for_simulation
)
_ORIGINAL_CONFIGURE_TORGHUT_SERVICE_FOR_SIMULATION = (
    _runtime_migrations_module._configure_torghut_service_for_simulation
)
_ORIGINAL_DESIRED_TA_SIMULATION_CONFIG = (
    _runtime_migrations_module._desired_ta_simulation_config
)
_ORIGINAL_DUMP_TOPICS = _topic_dumping_module._dump_topics
_ORIGINAL_ENSURE_ARGOCD_MANUAL_BEFORE_RUNTIME_MUTATION = (
    _argocd_rollouts_module._ensure_argocd_manual_before_runtime_mutation
)
_ORIGINAL_ENSURE_CLICKHOUSE_DATABASE = (
    _storage_and_database_module._ensure_clickhouse_database
)
_ORIGINAL_ENSURE_CLICKHOUSE_RUNTIME_TABLES = (
    _storage_and_database_module._ensure_clickhouse_runtime_tables
)
_ORIGINAL_ENSURE_POSTGRES_DATABASE = (
    _storage_and_database_module._ensure_postgres_database
)
_ORIGINAL_ENSURE_POSTGRES_RUNTIME_PERMISSIONS = (
    _storage_and_database_module._ensure_postgres_runtime_permissions
)
_ORIGINAL_ENSURE_SIMULATION_SCHEMA_SUBJECTS = (
    _kafka_runtime_module._ensure_simulation_schema_subjects
)
_ORIGINAL_ENSURE_TOPICS = _kafka_runtime_module._ensure_topics
_ORIGINAL_HTTP_CLICKHOUSE_QUERY = _storage_and_database_module._http_clickhouse_query
_ORIGINAL_MAIN = _cli_module.main
_ORIGINAL_MONITOR_RUN_COMPLETION = _lifecycle_module._monitor_run_completion
_ORIGINAL_PREPARE_ARGOCD_FOR_RUN = _argocd_rollouts_module._prepare_argocd_for_run
_ORIGINAL_REPLAY_DUMP = _replay_execution_module._replay_dump
_ORIGINAL_REPORT_SIMULATION = _argocd_rollouts_module._report_simulation
_ORIGINAL_RESOLVE_WARM_LANE_RUNTIME_POSTGRES_CONFIG = (
    _service_environment_module._resolve_warm_lane_runtime_postgres_config
)
_ORIGINAL_RESTORE_ARGOCD_AFTER_RUN = _argocd_rollouts_module._restore_argocd_after_run
_ORIGINAL_RESTORE_TA_CONFIGURATION = (
    _runtime_migrations_module._restore_ta_configuration
)
_ORIGINAL_RESTORE_TORGHUT_ENV = _runtime_migrations_module._restore_torghut_env
_ORIGINAL_RESET_POSTGRES_RUNTIME_STATE = (
    _runtime_migrations_module._reset_postgres_runtime_state
)
_ORIGINAL_RUN_FULL_LIFECYCLE = _lifecycle_module._run_full_lifecycle
_ORIGINAL_RUN_MIGRATIONS = _runtime_migrations_module._run_migrations
_ORIGINAL_RUN_ROLLOUTS_ANALYSIS = _argocd_rollouts_module._run_rollouts_analysis
_ORIGINAL_RUNTIME_VERIFY = _kafka_runtime_module._runtime_verify
_ORIGINAL_SEED_SIMULATION_TRADE_CURSOR = (
    _runtime_migrations_module._seed_simulation_trade_cursor
)
_ORIGINAL_SET_ARGOCD_APPLICATION_IGNORE_DIFFERENCES = (
    _service_environment_module._set_argocd_application_ignore_differences
)
_ORIGINAL_SET_ARGOCD_APPLICATION_SYNC_POLICY = (
    _kubernetes_argocd_module._set_argocd_application_sync_policy
)
_ORIGINAL_SET_ARGOCD_AUTOMATION_MODE = (
    _kubernetes_argocd_module._set_argocd_automation_mode
)
_ORIGINAL_SIMULATION_SCHEMA_REGISTRY_SUBJECT_SPECS = (
    _kafka_runtime_module._simulation_schema_registry_subject_specs
)
_ORIGINAL_TEARDOWN = _replay_execution_module._teardown
_ORIGINAL_TORGHUT_SERVICE_ENV_FOR_SIMULATION = (
    _runtime_migrations_module._torghut_service_env_for_simulation
)
_ORIGINAL_UPLOAD_DUMP_TO_CACHE = _state_and_cache_module._upload_dump_to_cache
_ORIGINAL_WAIT_FOR_CLICKHOUSE_DATABASE = (
    _storage_and_database_module._wait_for_clickhouse_database
)
_ORIGINAL_WAIT_FOR_CLICKHOUSE_TABLE = (
    _storage_and_database_module._wait_for_clickhouse_table
)
_ORIGINAL_WAIT_FOR_TORGHUT_SERVICE_REVISION_READY = (
    _argocd_rollouts_module._wait_for_torghut_service_revision_ready
)


def _bind(module: Any, **attrs: Any) -> None:
    for name, value in attrs.items():
        setattr(module, name, value)


def _sync_patch_targets() -> None:
    _bind(
        _cli_module,
        _apply=_apply,
        _report_simulation=_report_simulation,
        _run_full_lifecycle=_run_full_lifecycle,
        _teardown=_teardown,
    )
    _bind(
        _lifecycle_module,
        _apply=_apply,
        _build_strategy_proof_artifact=_build_strategy_proof_artifact,
        _ensure_supported_binary=_ensure_supported_binary,
        _monitor_run_completion=_monitor_run_completion,
        _prepare_argocd_for_run=_prepare_argocd_for_run,
        _read_argocd_application_sync_policy=_read_argocd_application_sync_policy,
        _read_argocd_automation_mode=_read_argocd_automation_mode,
        _read_named_argocd_application_sync_policy=_read_named_argocd_application_sync_policy,
        _replay_dump=_replay_dump,
        _report_simulation=_report_simulation,
        _restore_argocd_after_run=_restore_argocd_after_run,
        _run_rollouts_analysis=_run_rollouts_analysis,
        _runtime_verify=_runtime_verify,
        _save_json=_save_json,
        _teardown=_teardown,
        _update_run_state=_update_run_state,
        _upsert_simulation_progress_row=_upsert_simulation_progress_row,
        _wait_for_torghut_service_revision_ready=_wait_for_torghut_service_revision_ready,
        SessionLocal=SessionLocal,
        persist_completion_trace=persist_completion_trace,
    )
    _bind(
        _replay_execution_module,
        _acquire_simulation_runtime_lock=_acquire_simulation_runtime_lock,
        _capture_cluster_state=_capture_cluster_state,
        _configure_ta_for_simulation=_configure_ta_for_simulation,
        _configure_torghut_service_for_simulation=_configure_torghut_service_for_simulation,
        _dump_topics=_dump_topics,
        _ensure_argocd_manual_before_runtime_mutation=_ensure_argocd_manual_before_runtime_mutation,
        _ensure_clickhouse_database=_ensure_clickhouse_database,
        _ensure_clickhouse_runtime_tables=_ensure_clickhouse_runtime_tables,
        _ensure_directory=_ensure_directory,
        _ensure_lz4_codec_available=_ensure_lz4_codec_available,
        _ensure_postgres_database=_ensure_postgres_database,
        _ensure_postgres_runtime_permissions=_ensure_postgres_runtime_permissions,
        _ensure_simulation_schema_subjects=_ensure_simulation_schema_subjects,
        _ensure_supported_binary=_ensure_supported_binary,
        _ensure_topics=_ensure_topics,
        _read_simulation_runtime_lock=_read_simulation_runtime_lock,
        _producer_for_replay=_producer_for_replay,
        _release_simulation_runtime_lock=_release_simulation_runtime_lock,
        _reset_postgres_runtime_state=_reset_postgres_runtime_state,
        _restart_ta_deployment=_restart_ta_deployment,
        _restore_ta_configuration=_restore_ta_configuration,
        _restore_torghut_env=_restore_torghut_env,
        _run_migrations=_run_migrations,
        _save_json=_save_json,
        _seed_simulation_trade_cursor=_seed_simulation_trade_cursor,
        _ta_runtime_reconfigure_required=_ta_runtime_reconfigure_required,
        _torghut_service_reconfigure_required=_torghut_service_reconfigure_required,
        _upsert_simulation_progress_row=_upsert_simulation_progress_row,
        _upsert_simulation_runtime_context=_upsert_simulation_runtime_context,
        _validate_dump_coverage=_validate_dump_coverage,
    )
    _bind(
        _topic_dumping_module,
        _consumer_for_dump=_consumer_for_dump,
        _materialize_deterministic_dump=_materialize_deterministic_dump,
        _reusable_dump_report=_reusable_dump_report,
        _restore_cached_dump_if_available=_restore_cached_dump_if_available,
        _save_json=_save_json,
        _simulation_cache_client_from_env=_simulation_cache_client_from_env,
        time=time,
        _upload_dump_to_cache=_upload_dump_to_cache,
        _upsert_simulation_progress_row=_upsert_simulation_progress_row,
    )
    _bind(
        _kafka_runtime_module,
        _http_request=_http_request,
        _kafka_admin_client=_kafka_admin_client,
        _kubectl_json=_kubectl_json,
        _producer_for_replay=_producer_for_replay,
        _read_configmap_key_ref=_read_configmap_key_ref,
        _read_secret_key_ref=_read_secret_key_ref,
        __file__=__file__,
    )
    _bind(
        _runtime_migrations_module,
        _assert_required_simulation_metadata_tables=_assert_required_simulation_metadata_tables,
        _cache_metadata=_cache_metadata,
        _desired_ta_simulation_config=_desired_ta_simulation_config,
        _is_vector_extension_create_permission_error=_is_vector_extension_create_permission_error,
        _kubectl_json=_kubectl_json,
        _kubectl_patch=_kubectl_patch,
        _remove_appledouble_sidecars=_remove_appledouble_sidecars,
        _run_command=_run_command,
        _run_alembic_upgrade=_run_alembic_upgrade,
        _run_with_transient_postgres_retry=_run_with_transient_postgres_retry,
        _torghut_service_env_for_simulation=_torghut_service_env_for_simulation,
        psycopg=psycopg,
        shutil=shutil,
    )
    _bind(
        _argocd_rollouts_module,
        _kubectl_apply=_kubectl_apply,
        _kubectl_delete_if_exists=_kubectl_delete_if_exists,
        _kubectl_json=_kubectl_json,
        _run_command=_run_command,
        _run_with_transient_postgres_retry=_run_with_transient_postgres_retry,
        _read_argocd_application_sync_policy=_read_argocd_application_sync_policy,
        _read_argocd_applicationset_entry=_read_argocd_applicationset_entry,
        _read_argocd_automation_mode=_read_argocd_automation_mode,
        _read_named_argocd_application_sync_policy=_read_named_argocd_application_sync_policy,
        _runtime_verify=_runtime_verify,
        _save_json=_save_json,
        _set_argocd_application_ignore_differences=_set_argocd_application_ignore_differences,
        _set_argocd_application_sync_policy=_set_argocd_application_sync_policy,
        _set_argocd_automation_mode=_set_argocd_automation_mode,
        _prepare_argocd_for_run=_prepare_argocd_for_run,
        _wait_for_argocd_application_mode=_wait_for_argocd_application_mode,
        _wait_for_torghut_service_revision_ready=_wait_for_torghut_service_revision_ready,
    )
    _bind(
        _proof_artifacts_module,
        _run_with_transient_postgres_retry=_run_with_transient_postgres_retry,
        _save_json=_save_json,
        build_completion_trace=build_completion_trace,
        build_fill_price_error_budget_report_v1=build_fill_price_error_budget_report_v1,
    )
    _bind(
        _storage_and_database_module,
        _http_request=_http_request,
        _http_clickhouse_query=_http_clickhouse_query,
        _kubectl_json=_kubectl_json,
        _postgres_extension_exists=_postgres_extension_exists,
        _run_with_transient_postgres_retry=_run_with_transient_postgres_retry,
        _save_json=_save_json,
        HTTPConnection=simulation_verification.HTTPConnection,
        HTTPSConnection=simulation_verification.HTTPSConnection,
        psycopg=psycopg,
    )
    _bind(
        _service_environment_module,
        _kubectl_json=_kubectl_json,
        _kubectl_patch=_kubectl_patch,
        _kubectl_patch_json=_kubectl_patch_json,
        _read_argocd_applicationset_entry=_read_argocd_applicationset_entry,
        _read_named_argocd_application_sync_policy=_read_named_argocd_application_sync_policy,
    )
    _bind(
        _kubernetes_argocd_module,
        _kubectl_json=_kubectl_json,
        _kubectl_json_global=_kubectl_json_global,
        _kubectl_patch=_kubectl_patch,
        _kubectl_patch_json=_kubectl_patch_json,
        _run_command=_run_command,
        time=time,
    )
    _bind(
        _resource_planning_module,
        _run_command=_run_command,
        run_autonomous_lane=run_autonomous_lane,
    )
    _bind(
        _state_and_cache_module,
        _simulation_cache_client_from_env=_simulation_cache_client_from_env,
        CephS3Client=CephS3Client,
        time=time,
    )


def _delegate(target: Callable[..., Any]) -> Callable[..., Any]:
    def _call(*args: Any, **kwargs: Any) -> Any:
        _sync_patch_targets()
        return target(*args, **kwargs)

    return _call


_apply = _delegate(_ORIGINAL_APPLY)
_assert_required_simulation_metadata_tables = _delegate(
    _ORIGINAL_ASSERT_REQUIRED_SIMULATION_METADATA_TABLES
)
_clickhouse_query_configs = _delegate(_ORIGINAL_CLICKHOUSE_QUERY_CONFIGS)
_configure_ta_for_simulation = _delegate(_ORIGINAL_CONFIGURE_TA_FOR_SIMULATION)
_configure_torghut_service_for_simulation = _delegate(
    _ORIGINAL_CONFIGURE_TORGHUT_SERVICE_FOR_SIMULATION
)
_desired_ta_simulation_config = _delegate(_ORIGINAL_DESIRED_TA_SIMULATION_CONFIG)
_dump_topics = _delegate(_ORIGINAL_DUMP_TOPICS)
_ensure_argocd_manual_before_runtime_mutation = _delegate(
    _ORIGINAL_ENSURE_ARGOCD_MANUAL_BEFORE_RUNTIME_MUTATION
)
_ensure_clickhouse_database = _delegate(_ORIGINAL_ENSURE_CLICKHOUSE_DATABASE)
_ensure_clickhouse_runtime_tables = _delegate(
    _ORIGINAL_ENSURE_CLICKHOUSE_RUNTIME_TABLES
)
_ensure_postgres_database = _delegate(_ORIGINAL_ENSURE_POSTGRES_DATABASE)
_ensure_postgres_runtime_permissions = _delegate(
    _ORIGINAL_ENSURE_POSTGRES_RUNTIME_PERMISSIONS
)
_ensure_simulation_schema_subjects = _delegate(
    _ORIGINAL_ENSURE_SIMULATION_SCHEMA_SUBJECTS
)
_ensure_topics = _delegate(_ORIGINAL_ENSURE_TOPICS)
_http_clickhouse_query = _delegate(_ORIGINAL_HTTP_CLICKHOUSE_QUERY)
main = _delegate(_ORIGINAL_MAIN)
_monitor_run_completion = _delegate(_ORIGINAL_MONITOR_RUN_COMPLETION)
_prepare_argocd_for_run = _delegate(_ORIGINAL_PREPARE_ARGOCD_FOR_RUN)
_replay_dump = _delegate(_ORIGINAL_REPLAY_DUMP)
_report_simulation = _delegate(_ORIGINAL_REPORT_SIMULATION)
_resolve_warm_lane_runtime_postgres_config = _delegate(
    _ORIGINAL_RESOLVE_WARM_LANE_RUNTIME_POSTGRES_CONFIG
)
_reset_postgres_runtime_state = _delegate(_ORIGINAL_RESET_POSTGRES_RUNTIME_STATE)
_restore_argocd_after_run = _delegate(_ORIGINAL_RESTORE_ARGOCD_AFTER_RUN)
_restore_ta_configuration = _delegate(_ORIGINAL_RESTORE_TA_CONFIGURATION)
_restore_torghut_env = _delegate(_ORIGINAL_RESTORE_TORGHUT_ENV)
_run_full_lifecycle = _delegate(_ORIGINAL_RUN_FULL_LIFECYCLE)
_run_migrations = _delegate(_ORIGINAL_RUN_MIGRATIONS)
_run_rollouts_analysis = _delegate(_ORIGINAL_RUN_ROLLOUTS_ANALYSIS)
_runtime_verify = _delegate(_ORIGINAL_RUNTIME_VERIFY)
_seed_simulation_trade_cursor = _delegate(_ORIGINAL_SEED_SIMULATION_TRADE_CURSOR)
_set_argocd_application_ignore_differences = _delegate(
    _ORIGINAL_SET_ARGOCD_APPLICATION_IGNORE_DIFFERENCES
)
_set_argocd_application_sync_policy = _delegate(
    _ORIGINAL_SET_ARGOCD_APPLICATION_SYNC_POLICY
)
_set_argocd_automation_mode = _delegate(_ORIGINAL_SET_ARGOCD_AUTOMATION_MODE)
_simulation_schema_registry_subject_specs = _delegate(
    _ORIGINAL_SIMULATION_SCHEMA_REGISTRY_SUBJECT_SPECS
)
_teardown = _delegate(_ORIGINAL_TEARDOWN)
_torghut_service_env_for_simulation = _delegate(
    _ORIGINAL_TORGHUT_SERVICE_ENV_FOR_SIMULATION
)
_upload_dump_to_cache = _delegate(_ORIGINAL_UPLOAD_DUMP_TO_CACHE)
_wait_for_clickhouse_database = _delegate(_ORIGINAL_WAIT_FOR_CLICKHOUSE_DATABASE)
_wait_for_clickhouse_table = _delegate(_ORIGINAL_WAIT_FOR_CLICKHOUSE_TABLE)
_wait_for_torghut_service_revision_ready = _delegate(
    _ORIGINAL_WAIT_FOR_TORGHUT_SERVICE_REVISION_READY
)


if __name__ == "__main__":
    raise SystemExit(main())
