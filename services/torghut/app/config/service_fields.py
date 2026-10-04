"""Core service and trading connectivity settings."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class CoreSettingsFields(BaseSettings):
    """Environment-backed settings."""

    process_role: Literal["api", "scheduler", "simulation"] = Field(
        default="api",
        alias="TORGHUT_PROCESS_ROLE",
        description=(
            "Exclusive runtime role for this process. API processes remain stateless; "
            "dedicated scheduler processes own live trading background loops, while "
            "the isolated simulation service may own its paper scheduler locally."
        ),
    )

    trading_scheduler_leadership_required: bool = Field(
        default=False,
        alias="TRADING_SCHEDULER_LEADERSHIP_REQUIRED",
        description="Require durable PostgreSQL leadership before scheduler work starts.",
    )

    trading_scheduler_leadership_lock_name: str = Field(
        default="torghut:trading-scheduler",
        min_length=1,
        max_length=128,
        alias="TRADING_SCHEDULER_LEADERSHIP_LOCK_NAME",
        description=(
            "Stable namespace hashed into the PostgreSQL scheduler advisory-lock ID. "
            "Independent trading runtimes must use distinct names."
        ),
    )

    trading_scheduler_leadership_check_seconds: float = Field(
        default=5.0,
        gt=0,
        alias="TRADING_SCHEDULER_LEADERSHIP_CHECK_SECONDS",
        description="Interval between scheduler leadership-session health checks.",
    )

    trading_scheduler_shutdown_drain_seconds: float = Field(
        default=45.0,
        gt=0,
        alias="TRADING_SCHEDULER_SHUTDOWN_DRAIN_SECONDS",
        description=(
            "Maximum graceful-shutdown time for in-flight broker work. A timeout "
            "terminates the process without releasing scheduler leadership."
        ),
    )

    trading_scheduler_success_max_age_seconds: float = Field(
        default=30.0,
        gt=0,
        alias="TRADING_SCHEDULER_SUCCESS_MAX_AGE_SECONDS",
        description=(
            "Maximum age of the scheduler's last fully successful trading cycle "
            "before readiness fails closed."
        ),
    )

    trading_scheduler_runtime_base_url: str = Field(
        default="http://torghut-scheduler.torghut.svc.cluster.local:8183",
        alias="TRADING_SCHEDULER_RUNTIME_BASE_URL",
        description="Internal base URL for scheduler-owned status and metrics surfaces.",
    )

    trading_scheduler_runtime_timeout_seconds: float = Field(
        default=2.0,
        gt=0,
        alias="TRADING_SCHEDULER_RUNTIME_TIMEOUT_SECONDS",
        description="Timeout for stateless API reads of scheduler-owned runtime surfaces.",
    )

    trading_broker_mutation_recovery_enabled: bool = Field(
        default=True,
        alias="TRADING_BROKER_MUTATION_RECOVERY_ENABLED",
        description=(
            "Run observation-only recovery for ambiguous broker submit receipts. "
            "Disabling it preserves unresolved claims and never enables resubmission."
        ),
    )

    trading_broker_mutation_http_timeout_seconds: float = Field(
        default=10.0,
        gt=0,
        le=15,
        alias="TRADING_BROKER_MUTATION_HTTP_TIMEOUT_SECONDS",
        description=(
            "Per-request deadline for broker mutation and strict recovery HTTP "
            "calls. The upper bound keeps the complete observation sequence inside "
            "the durable recovery lease."
        ),
    )

    app_env: Literal["dev", "stage", "prod"] = Field(
        default="dev", alias="APP_ENV", description="Deployment environment."
    )

    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"] = Field(
        default="INFO",
        alias="LOG_LEVEL",
        description="Root application log level.",
    )

    log_format: Literal["json", "text"] = Field(
        default="text",
        alias="LOG_FORMAT",
        description="Application log output format.",
    )

    log_access_log: bool = Field(
        default=True,
        alias="LOG_ACCESS_LOG",
        description="Emit Uvicorn access logs.",
    )

    db_dsn: str = Field(
        default="postgresql+psycopg://torghut:torghut@localhost:15438/torghut",
        alias="DB_DSN",
        validation_alias=AliasChoices("DB_DSN", "DB_URL", "DATABASE_URL"),
        description="PostgreSQL connection string.",
    )

    tigerbeetle_enabled: bool = Field(
        default=False,
        alias="TORGHUT_TIGERBEETLE_ENABLED",
        description="Enable TigerBeetle ledger integration surfaces.",
    )

    tigerbeetle_required: bool = Field(
        default=False,
        alias="TORGHUT_TIGERBEETLE_REQUIRED",
        description="Fail readiness when TigerBeetle protocol health fails.",
    )

    tigerbeetle_cluster_id: int = Field(
        default=2001,
        alias="TORGHUT_TIGERBEETLE_CLUSTER_ID",
        description="TigerBeetle cluster ID used for Torghut ledger writes.",
    )

    tigerbeetle_replica_addresses: str = Field(
        default="torghut-tigerbeetle.torghut.svc.cluster.local:3000",
        alias="TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES",
        description="Comma-separated TigerBeetle replica addresses.",
    )

    tigerbeetle_health_timeout_seconds: float = Field(
        default=2.0,
        alias="TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS",
        description="TigerBeetle protocol health timeout in seconds.",
    )

    tigerbeetle_rpc_timeout_seconds: float = Field(
        default=10.0,
        alias="TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS",
        description="Maximum time allowed for one synchronous TigerBeetle client RPC.",
    )

    tigerbeetle_journal_enabled: bool = Field(
        default=False,
        alias="TORGHUT_TIGERBEETLE_JOURNAL_ENABLED",
        description="Write Torghut order lifecycle events into TigerBeetle.",
    )

    tigerbeetle_reconcile_required: bool = Field(
        default=False,
        alias="TORGHUT_TIGERBEETLE_RECONCILE_REQUIRED",
        description="Fail readiness when TigerBeetle reconciliation has blockers.",
    )

    tigerbeetle_economic_parity_required: bool = Field(
        default=False,
        alias="TORGHUT_TIGERBEETLE_ECONOMIC_PARITY_REQUIRED",
        description=(
            "Require a fresh sealed broker-economic TigerBeetle parity result "
            "before new broker exposure; never changes readiness or reduction access."
        ),
    )

    tigerbeetle_reconcile_max_age_seconds: int = Field(
        default=3600,
        alias="TORGHUT_TIGERBEETLE_RECONCILE_MAX_AGE_SECONDS",
        description=(
            "Maximum age of the latest TigerBeetle reconciliation run before "
            "readiness marks ledger parity stale."
        ),
    )

    apca_api_key_id: Optional[str] = Field(default=None, alias="APCA_API_KEY_ID")

    apca_api_secret_key: Optional[str] = Field(
        default=None, alias="APCA_API_SECRET_KEY"
    )

    apca_api_base_url: Optional[str] = Field(default=None, alias="APCA_API_BASE_URL")

    apca_data_api_base_url: Optional[str] = Field(
        default=None, alias="APCA_DATA_API_BASE_URL"
    )

    trading_enabled: bool = Field(default=False, alias="TRADING_ENABLED")

    trading_mode: Literal["paper", "live"] = Field(
        default="paper", alias="TRADING_MODE"
    )

    trading_crypto_enabled: bool = Field(
        default=False,
        alias="TRADING_CRYPTO_ENABLED",
        description="Enable crypto strategy/universe execution paths in runtime decisions.",
    )

    trading_crypto_live_enabled: bool = Field(
        default=False,
        alias="TRADING_CRYPTO_LIVE_ENABLED",
        description="Enable live promotion for crypto execution paths.",
    )

    trading_feature_flags_enabled: bool = Field(
        default=False,
        alias="TRADING_FEATURE_FLAGS_ENABLED",
        description="Enable Flipt-backed overrides for selected Torghut runtime toggles.",
    )

    trading_feature_flags_url: Optional[str] = Field(
        default=None,
        alias="TRADING_FEATURE_FLAGS_URL",
        description="Feature-flags service URL (for example http://feature-flags.feature-flags.svc.cluster.local:8013).",
    )

    trading_feature_flags_timeout_ms: int = Field(
        default=500,
        alias="TRADING_FEATURE_FLAGS_TIMEOUT_MS",
        description="Timeout in milliseconds for feature-flag lookups.",
    )

    trading_feature_flags_namespace: str = Field(
        default="default",
        alias="TRADING_FEATURE_FLAGS_NAMESPACE",
        description="Flipt namespace key used for feature-flag evaluation.",
    )

    trading_feature_flags_entity_id: str = Field(
        default="torghut",
        alias="TRADING_FEATURE_FLAGS_ENTITY_ID",
        description="Entity id used for Flipt feature-flag evaluation context.",
    )

    trading_signal_source: Literal["clickhouse"] = Field(
        default="clickhouse", alias="TRADING_SIGNAL_SOURCE"
    )

    trading_signal_table: str = Field(
        default="torghut.ta_signals", alias="TRADING_SIGNAL_TABLE"
    )

    trading_signal_schema: Literal["auto", "envelope", "flat"] = Field(
        default="auto", alias="TRADING_SIGNAL_SCHEMA"
    )

    trading_signal_allowed_sources_raw: Optional[str] = Field(
        default=None,
        alias="TRADING_SIGNAL_ALLOWED_SOURCES",
        description="Comma-separated allowlist of signal envelope sources to ingest (for example ws,autonomy_gate_report).",
    )

    trading_signal_batch_size: int = Field(
        default=500, alias="TRADING_SIGNAL_BATCH_SIZE"
    )

    trading_session_context_warmup_signal_limit: int = Field(
        default=500,
        alias="TRADING_SESSION_CONTEXT_WARMUP_SIGNAL_LIMIT",
        description=(
            "Maximum open-session replay signals used to warm quote and decision context "
            "before the live trading cycle starts."
        ),
    )

    trading_signal_lookback_minutes: int = Field(
        default=15, alias="TRADING_SIGNAL_LOOKBACK_MINUTES"
    )

    trading_session_context_warmup_max_seconds: int = Field(
        default=300,
        alias="TRADING_SESSION_CONTEXT_WARMUP_MAX_SECONDS",
        description=(
            "Maximum lookback for scheduler session-context warmup. This bounds the "
            "startup replay so a full-session ClickHouse scan cannot block live polling."
        ),
    )

    trading_session_context_warmup_max_signals: int = Field(
        default=1000,
        alias="TRADING_SESSION_CONTEXT_WARMUP_MAX_SIGNALS",
        description="Maximum signal rows to replay during scheduler session-context warmup.",
    )

    trading_signal_empty_batch_advance_seconds: int = Field(
        default=60,
        alias="TRADING_SIGNAL_EMPTY_BATCH_ADVANCE_SECONDS",
        description="How far to move the cursor forward when a poll returns no new signals.",
    )

    trading_signal_no_signal_streak_alert_threshold: int = Field(
        default=2,
        alias="TRADING_SIGNAL_NO_SIGNAL_STREAK_ALERT_THRESHOLD",
        description="Consecutive no-signal batches before emitting a source continuity alert.",
    )

    trading_signal_stale_lag_alert_seconds: int = Field(
        default=300,
        alias="TRADING_SIGNAL_STALE_LAG_ALERT_SECONDS",
        description="Signal lag threshold (seconds) that triggers a source continuity alert.",
    )

    trading_signal_continuity_recovery_cycles: int = Field(
        default=2,
        alias="TRADING_SIGNAL_CONTINUITY_RECOVERY_CYCLES",
        description=(
            "How many healthy signal-bearing cycles are required before clearing a latched "
            "signal continuity alert."
        ),
    )

    trading_signal_bootstrap_grace_seconds: int = Field(
        default=180,
        alias="TRADING_SIGNAL_BOOTSTRAP_GRACE_SECONDS",
        description=(
            "Grace period after scheduler start or simulation run reset before "
            "no-signal continuity reasons become actionable."
        ),
    )

    trading_signal_staleness_alert_critical_reasons_raw: Optional[str] = Field(
        default="cursor_ahead_of_stream,universe_source_unavailable",
        alias="TRADING_SIGNAL_STALENESS_ALERT_CRITICAL_REASONS",
        description="Comma-separated no-signal/staleness reasons treated as critical continuity breaches.",
    )

    trading_signal_market_closed_expected_reasons_raw: Optional[str] = Field(
        default="no_signals_in_window,cursor_tail_stable,empty_batch_advanced",
        alias="TRADING_SIGNAL_MARKET_CLOSED_EXPECTED_REASONS",
        description=(
            "Comma-separated no-signal reasons treated as expected staleness while the market "
            "session is closed."
        ),
    )

    trading_price_table: str = Field(
        default="torghut.ta_microbars", alias="TRADING_PRICE_TABLE"
    )

    trading_price_lookback_minutes: int = Field(
        default=5, alias="TRADING_PRICE_LOOKBACK_MINUTES"
    )

    trading_executable_quote_lookback_seconds: int = Field(
        default=60,
        alias="TRADING_EXECUTABLE_QUOTE_LOOKBACK_SECONDS",
        description="Maximum age for a last-good executable quote used to backfill bid/ask before quote-quality checks.",
    )

    trading_executable_quote_forward_seconds: int = Field(
        default=0,
        alias="TRADING_EXECUTABLE_QUOTE_FORWARD_SECONDS",
        description=(
            "Runtime-only grace window for using an executable quote that arrives after "
            "a signal timestamp but before decision evaluation. Keep this disabled for "
            "replay and live-submit lanes."
        ),
    )

    trading_alpaca_quote_fallback_enabled: bool = Field(
        default=False,
        alias="TRADING_ALPACA_QUOTE_FALLBACK_ENABLED",
        description=(
            "Allow runtime executable quote backfill from Alpaca latest stock quotes "
            "when ClickHouse signal rows do not carry bid/ask. Keep disabled for "
            "live-submit lanes unless explicitly promoted."
        ),
    )

    trading_alpaca_quote_feed: str = Field(
        default="iex",
        alias="TRADING_ALPACA_QUOTE_FEED",
        description="Alpaca stock-data feed used for latest-quote executable backfill.",
    )

    trading_alpaca_quote_timeout_seconds: float = Field(
        default=2.0,
        alias="TRADING_ALPACA_QUOTE_TIMEOUT_SECONDS",
        description="HTTP timeout for Alpaca latest-quote executable backfill.",
    )

    trading_alpaca_quote_max_age_seconds: int = Field(
        default=20,
        alias="TRADING_ALPACA_QUOTE_MAX_AGE_SECONDS",
        description="Reject Alpaca fallback quotes older than this many seconds.",
    )

    trading_alpaca_quote_fallback_market_session_required: bool = Field(
        default=True,
        alias="TRADING_ALPACA_QUOTE_FALLBACK_MARKET_SESSION_REQUIRED",
        description=(
            "Suppress Alpaca latest-quote executable backfill outside the regular "
            "equity market session. This keeps proof lanes fail-closed and avoids "
            "provider churn when closed-market quotes are not executable."
        ),
    )

    trading_alpaca_quote_fallback_backoff_seconds: int = Field(
        default=60,
        alias="TRADING_ALPACA_QUOTE_FALLBACK_BACKOFF_SECONDS",
        description=(
            "Per-symbol cooldown after Alpaca latest-quote fallback is unavailable "
            "or rejected, so repeated scheduler probes do not hammer the provider."
        ),
    )

    trading_options_catalog_freshness_cache_seconds: int = Field(
        default=30,
        alias="TRADING_OPTIONS_CATALOG_FRESHNESS_CACHE_SECONDS",
        description=(
            "Short in-process cache TTL for options catalog freshness summaries. "
            "Caching unavailable summaries keeps status probes bounded while "
            "preserving fail-closed evidence semantics."
        ),
    )

    trading_options_catalog_freshness_exact_route_scope_enabled: bool = Field(
        default=False,
        alias="TRADING_OPTIONS_CATALOG_FRESHNESS_EXACT_ROUTE_SCOPE_ENABLED",
        description=(
            "Enable exact active-contract aggregation for route-scoped options catalog "
            "freshness. Defaults off so readiness probes use explicitly non-exact "
            "bounded reads instead of waiting for large catalog aggregates to time out."
        ),
    )

    trading_tca_status_lineage_sample_limit: int = Field(
        default=200,
        alias="TRADING_TCA_STATUS_LINEAGE_SAMPLE_LIMIT",
        description=(
            "Maximum execution audit rows sampled when trading status summarizes "
            "non-authoritative TCA cost lineage. Truncated samples remain fail-closed "
            "and never count as promotion authority."
        ),
    )

    trading_poll_ms: int = Field(default=5000, alias="TRADING_POLL_MS")

    trading_reconcile_ms: int = Field(
        default=15000,
        gt=0,
        alias="TRADING_RECONCILE_MS",
        description=(
            "Interval between reconciliation cycles. Must remain below the scheduler "
            "success freshness window so a healthy scheduler can stay ready."
        ),
    )

    trading_order_feed_enabled: bool = Field(
        default=False, alias="TRADING_ORDER_FEED_ENABLED"
    )

    trading_multi_account_enabled: bool = Field(
        default=False,
        alias="TRADING_MULTI_ACCOUNT_ENABLED",
        description="Enable multi-account lane supervision and account-scoped execution isolation.",
    )

    trading_order_feed_bootstrap_servers: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_BOOTSTRAP_SERVERS",
        description="Comma-separated Kafka bootstrap servers for trade update ingestion.",
    )

    trading_order_feed_security_protocol: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_SECURITY_PROTOCOL",
        description="Kafka security protocol override for order-feed ingestion.",
    )

    trading_order_feed_sasl_mechanism: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_SASL_MECHANISM",
        description="Kafka SASL mechanism for order-feed ingestion.",
    )

    trading_order_feed_sasl_username: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_SASL_USERNAME",
        description="Kafka SASL username for order-feed ingestion.",
    )

    trading_order_feed_sasl_password: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_SASL_PASSWORD",
        description="Kafka SASL password for order-feed ingestion.",
    )

    trading_order_feed_topic: str = Field(
        default="torghut.trade-updates.v1",
        alias="TRADING_ORDER_FEED_TOPIC",
        description="Canonical order update topic.",
    )

    trading_order_feed_topic_v2: Optional[str] = Field(
        default=None,
        alias="TRADING_ORDER_FEED_TOPIC_V2",
        description="Optional trade-updates.v2 topic with account_label envelope.",
    )

    trading_order_feed_group_id: str = Field(
        default="torghut-order-feed-v1",
        alias="TRADING_ORDER_FEED_GROUP_ID",
        description="Consumer group id for order-feed ingestion.",
    )

    trading_order_feed_assignment_mode: Literal["group", "manual"] = Field(
        default="group",
        alias="TRADING_ORDER_FEED_ASSIGNMENT_MODE",
        description=(
            "Kafka partition assignment mode for order-feed ingestion. Manual mode "
            "bypasses consumer-group rebalances and resumes from persisted DB offsets."
        ),
    )

    trading_order_feed_client_id: str = Field(
        default="torghut-order-feed",
        alias="TRADING_ORDER_FEED_CLIENT_ID",
        description="Kafka client id for order-feed ingestion.",
    )

    trading_order_feed_auto_offset_reset: Literal["latest", "earliest"] = Field(
        default="latest",
        alias="TRADING_ORDER_FEED_AUTO_OFFSET_RESET",
        description="Offset reset behavior when consumer group has no committed offsets.",
    )

    trading_order_feed_poll_ms: int = Field(
        default=250,
        alias="TRADING_ORDER_FEED_POLL_MS",
        description="Kafka poll timeout in milliseconds for order-feed ingestion.",
    )

    trading_order_feed_batch_size: int = Field(
        default=200,
        alias="TRADING_ORDER_FEED_BATCH_SIZE",
        description="Max messages processed per order-feed poll.",
    )

    trading_strategy_config_path: Optional[str] = Field(
        default=None,
        alias="TRADING_STRATEGY_CONFIG_PATH",
        description="Optional path to a strategy catalog file (YAML/JSON).",
    )

    trading_strategy_config_mode: Literal["merge", "sync"] = Field(
        default="merge",
        alias="TRADING_STRATEGY_CONFIG_MODE",
        description="Merge keeps existing strategies; sync disables missing strategies.",
    )

    trading_strategy_reload_seconds: int = Field(
        default=10,
        alias="TRADING_STRATEGY_RELOAD_SECONDS",
        description="Seconds between strategy catalog reload checks.",
    )

    trading_hypothesis_registry_path: Optional[str] = Field(
        default="config/trading/hypotheses",
        alias="TRADING_HYPOTHESIS_REGISTRY_PATH",
        description="Path to the source-controlled hypothesis manifest directory or file.",
    )

    trading_strategy_runtime_mode: Literal["scheduler_v3"] = Field(
        default="scheduler_v3",
        alias="TRADING_STRATEGY_RUNTIME_MODE",
        description="Strategy runtime mode. The scheduler_v3 runtime is the only supported path.",
    )

    trading_strategy_runtime_circuit_errors: int = Field(
        default=3,
        alias="TRADING_STRATEGY_RUNTIME_CIRCUIT_ERRORS",
        description="Consecutive strategy plugin errors before temporary degradation.",
    )

    trading_strategy_runtime_circuit_cooldown_seconds: int = Field(
        default=300,
        alias="TRADING_STRATEGY_RUNTIME_CIRCUIT_COOLDOWN_SECONDS",
        description="Cooldown duration for degraded plugins in scheduler runtime mode.",
    )

    trading_feature_schema_version: str = Field(
        default="v3",
        alias="TRADING_FEATURE_SCHEMA_VERSION",
        description="Feature contract schema version for normalized strategy input.",
    )

    trading_feature_normalization_version: str = Field(
        default="v1",
        alias="TRADING_FEATURE_NORMALIZATION_VERSION",
        description="Feature normalization implementation version.",
    )

    trading_forecast_router_enabled: bool = Field(
        default=True,
        alias="TRADING_FORECAST_ROUTER_ENABLED",
        description="Enable deterministic forecast routing and uncertainty contract emission.",
    )

    trading_forecast_service_allowed_model_families_raw: Optional[str] = Field(
        default="chronos,moment,financial_tsfm",
        alias="TRADING_FORECAST_SERVICE_ALLOWED_MODEL_FAMILIES",
        description="Comma-separated model families allowed from the empirical forecast service.",
    )

    trading_forecast_router_policy_path: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_ROUTER_POLICY_PATH",
        description="Optional path to forecast router policy JSON.",
    )

    trading_forecast_registry_manifest_path: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_REGISTRY_MANIFEST_PATH",
        description="Path to the in-process forecast model registry manifest.",
    )

    trading_forecast_registry_manifest_url: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_REGISTRY_MANIFEST_URL",
        description="Optional HTTP URL for the forecast model registry manifest.",
    )

    trading_forecast_registry_refresh_seconds: int = Field(
        default=30,
        alias="TRADING_FORECAST_REGISTRY_REFRESH_SECONDS",
        description="Refresh cadence for in-process forecast registry manifest reloads.",
    )

    trading_forecast_calibration_stale_after_seconds: int = Field(
        default=604800,
        alias="TRADING_FORECAST_CALIBRATION_STALE_AFTER_SECONDS",
        description="Forecast calibration freshness budget used by in-process forecast readiness checks.",
    )

    trading_empirical_job_stale_after_seconds: int = Field(
        default=86400,
        alias="TRADING_EMPIRICAL_JOB_STALE_AFTER_SECONDS",
        description="Deprecated compatibility budget for historical empirical-job status payloads.",
    )

    trading_empirical_jobs_health_required: bool = Field(
        default=False,
        alias="TRADING_EMPIRICAL_JOBS_HEALTH_REQUIRED",
        description="Deprecated compatibility flag. Empirical jobs no longer block live Torghut gates.",
    )

    trading_forecast_router_refinement_enabled: bool = Field(
        default=True,
        alias="TRADING_FORECAST_ROUTER_REFINEMENT_ENABLED",
        description="Enable deterministic forecast refinement for eligible routes.",
    )

    trading_feature_quality_enabled: bool = Field(
        default=True,
        alias="TRADING_FEATURE_QUALITY_ENABLED",
        description="Fail closed on feature schema/freshness/data-quality violations.",
    )

    trading_feature_max_required_null_rate: float = Field(
        default=0.01,
        alias="TRADING_FEATURE_MAX_REQUIRED_NULL_RATE",
        description="Maximum allowed null-rate for required canonical v3 feature fields.",
    )

    trading_feature_max_staleness_ms: int = Field(
        default=300000,
        alias="TRADING_FEATURE_MAX_STALENESS_MS",
        description="Maximum allowed p95 feature staleness in milliseconds per batch.",
    )

    trading_feature_max_duplicate_ratio: float = Field(
        default=0.02,
        alias="TRADING_FEATURE_MAX_DUPLICATE_RATIO",
        description="Maximum duplicate event ratio per ingest batch.",
    )

    trading_autonomy_enabled: bool = Field(
        default=False, alias="TRADING_AUTONOMY_ENABLED"
    )

    trading_autonomy_allow_live_promotion: bool = Field(
        default=False,
        alias="TRADING_AUTONOMY_ALLOW_LIVE_PROMOTION",
        description="Safety gate for autonomous promotion actions; live stays disabled by default.",
    )

    trading_autonomy_approval_token: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_APPROVAL_TOKEN",
        description="Optional approval token for live promotion when required by policy.",
    )

    trading_autonomy_gate_policy_path: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_GATE_POLICY_PATH",
        description="Optional path to v3 autonomous gate policy config JSON.",
    )

    trading_autonomy_interval_seconds: int = Field(
        default=300, alias="TRADING_AUTONOMY_INTERVAL_SECONDS"
    )

    trading_autonomy_signal_lookback_minutes: int = Field(
        default=15,
        alias="TRADING_AUTONOMY_SIGNAL_LOOKBACK_MINUTES",
        description="Lookback window for signals passed to autonomous lane runs.",
    )


__all__ = ["CoreSettingsFields"]
