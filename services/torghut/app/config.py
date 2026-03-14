"""Application configuration for the torghut service."""

import json
import logging
import tempfile
import os
from functools import lru_cache
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
import string
from typing import Any, List, Literal, Optional, cast
from urllib.parse import urlsplit

from pydantic import AliasChoices, BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from .logging_config import configure_logging

configure_logging()

logger = logging.getLogger(__name__)

FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD: dict[str, str] = {
    "trading_enabled": "torghut_trading_enabled",
    "trading_crypto_enabled": "torghut_trading_crypto_enabled",
    "trading_crypto_live_enabled": "torghut_trading_crypto_live_enabled",
    "trading_order_feed_enabled": "torghut_trading_order_feed_enabled",
    "trading_multi_account_enabled": "torghut_trading_multi_account_enabled",
    "trading_strategy_scheduler_enabled": "torghut_trading_strategy_scheduler_enabled",
    "trading_feature_quality_enabled": "torghut_trading_feature_quality_enabled",
    "trading_autonomy_enabled": "torghut_trading_autonomy_enabled",
    "trading_autonomy_allow_live_promotion": "torghut_trading_autonomy_allow_live_promotion",
    "trading_evidence_continuity_enabled": "torghut_trading_evidence_continuity_enabled",
    "trading_universe_require_non_empty_jangar": "torghut_trading_universe_require_non_empty_jangar",
    "trading_universe_static_fallback_enabled": "torghut_trading_universe_static_fallback_enabled",
    "trading_readiness_dependency_cache_enabled": (
        "torghut_trading_readiness_dependency_cache_enabled"
    ),
    "trading_db_schema_graph_allow_divergence_roots": (
        "torghut_trading_db_schema_graph_allow_divergence_roots"
    ),
    "trading_execution_prefer_limit": "torghut_trading_execution_prefer_limit",
    "trading_allocator_enabled": "torghut_trading_allocator_enabled",
    "trading_forecast_router_enabled": "torghut_trading_forecast_router_enabled",
    "trading_forecast_router_refinement_enabled": "torghut_trading_forecast_router_refinement_enabled",
    "trading_drift_governance_enabled": "torghut_trading_drift_governance_enabled",
    "trading_drift_live_promotion_requires_evidence": "torghut_trading_drift_live_promotion_requires_evidence",
    "trading_drift_rollback_on_performance": "torghut_trading_drift_rollback_on_performance",
    "trading_execution_advisor_enabled": "torghut_trading_execution_advisor_enabled",
    "trading_execution_advisor_live_apply_enabled": "torghut_trading_execution_advisor_live_apply_enabled",
    "trading_simulation_enabled": "torghut_trading_simulation_enabled",
    "trading_allow_shorts": "torghut_trading_allow_shorts",
    "trading_fractional_equities_enabled": "torghut_trading_fractional_equities_enabled",
    "trading_kill_switch_enabled": "torghut_trading_kill_switch_enabled",
    "trading_emergency_stop_enabled": "torghut_trading_emergency_stop_enabled",
    "trading_market_context_required": "torghut_trading_market_context_required",
    "trading_market_context_allow_degraded_last_good": (
        "torghut_trading_market_context_allow_degraded_last_good"
    ),
    "llm_enabled": "torghut_llm_enabled",
    "llm_fail_open_live_approved": "torghut_llm_fail_open_live_approved",
    "llm_adjustment_allowed": "torghut_llm_adjustment_allowed",
    "llm_shadow_mode": "torghut_llm_shadow_mode",
    "llm_committee_enabled": "torghut_llm_committee_enabled",
    "llm_adjustment_approved": "torghut_llm_adjustment_approved",
    "posthog_enabled": "torghut_posthog_enabled",
}

_LLM_COMMITTEE_ROLES = {
    "researcher",
    "risk_critic",
    "execution_critic",
    "policy_judge",
}


class TradingAccountLane(BaseModel):
    """Runtime trading-account lane configuration."""

    label: str
    mode: Literal["paper", "live"] = "paper"
    api_key: Optional[str] = None
    secret_key: Optional[str] = None
    base_url: Optional[str] = None
    enabled: bool = True


@lru_cache(maxsize=1)
def _dspy_bootstrap_artifact_hash() -> str | None:
    try:
        from .trading.llm.dspy_programs.runtime import DSPyReviewRuntime
    except Exception:
        return None
    try:
        return DSPyReviewRuntime.bootstrap_artifact_hash()
    except Exception:
        return None


def _http_connection_for_url(
    url: str, *, timeout_seconds: float
) -> tuple[HTTPConnection | HTTPSConnection, str]:
    parsed = urlsplit(url)
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"}:
        raise ValueError(f"unsupported_url_scheme:{scheme or 'missing'}")
    if not parsed.hostname:
        raise ValueError("missing_url_host")
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    connection_class = HTTPSConnection if scheme == "https" else HTTPConnection
    return connection_class(parsed.hostname, parsed.port, timeout=timeout_seconds), path


class _HttpRequest:
    def __init__(
        self,
        *,
        full_url: str,
        method: str,
        data: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        self.full_url = full_url
        self.method = method
        self.data = data
        self._headers = dict(headers or {})

    def header_items(self) -> list[tuple[str, str]]:
        return list(self._headers.items())

    @property
    def headers(self) -> dict[str, str]:
        return dict(self._headers)


class _HttpResponseHandle:
    def __init__(
        self, connection: HTTPConnection | HTTPSConnection, response: Any
    ) -> None:
        self._connection = connection
        self._response = response
        self.status = int(getattr(response, "status", 200))

    def read(self) -> bytes:
        return cast(bytes, self._response.read())

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "_HttpResponseHandle":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self.close()
        return False


def urlopen(request: _HttpRequest, timeout: float) -> _HttpResponseHandle:
    connection, request_path = _http_connection_for_url(
        request.full_url,
        timeout_seconds=max(timeout, 0.001),
    )
    try:
        connection.request(
            request.method, request_path, body=request.data, headers=request.headers
        )
        response = connection.getresponse()
    except Exception:
        connection.close()
        raise
    return _HttpResponseHandle(connection, response)


def _resolve_boolean_feature_flag(
    *,
    endpoint: str,
    namespace_key: str,
    entity_id: str,
    flag_key: str,
    default_value: bool,
    timeout_ms: int,
) -> tuple[bool, bool]:
    payload = json.dumps(
        {
            "namespaceKey": namespace_key,
            "flagKey": flag_key,
            "entityId": entity_id,
            "context": {},
        }
    ).encode("utf-8")
    request_url = f"{endpoint.rstrip('/')}/evaluate/v1/boolean"
    timeout_seconds = max(timeout_ms, 1) / 1000.0
    request = _HttpRequest(
        full_url=request_url,
        method="POST",
        data=payload,
        headers={
            "accept": "application/json",
            "content-type": "application/json",
        },
    )
    try:
        with urlopen(request, timeout_seconds) as response:
            status = int(getattr(response, "status", 200))
            if status < 200 or status >= 300:
                logger.warning(
                    "Feature flag resolve HTTP failure for key=%s status=%s; using default.",
                    flag_key,
                    status,
                )
                return default_value, False
            raw_body = json.loads(response.read().decode("utf-8"))
            if not isinstance(raw_body, dict):
                logger.warning(
                    "Feature flag resolve invalid response for key=%s; using default.",
                    flag_key,
                )
                return default_value, False
            body = cast(dict[str, object], raw_body)
            enabled = body.get("enabled")
            if not isinstance(enabled, bool):
                logger.warning(
                    "Feature flag resolve missing boolean `enabled` for key=%s; using default.",
                    flag_key,
                )
                return default_value, False
            return enabled, True
    except ValueError:
        logger.warning(
            "Feature flag resolve invalid endpoint for key=%s endpoint=%s; using default.",
            flag_key,
            endpoint,
        )
        return default_value, False
    except Exception:
        logger.warning(
            "Feature flag resolve failed for key=%s; using default.", flag_key
        )
        return default_value, False
    return default_value, False


class Settings(BaseSettings):
    """Environment-backed settings."""

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
    # Deprecated compatibility alias for TRADING_MODE.
    trading_live_enabled: bool = Field(default=False, alias="TRADING_LIVE_ENABLED")
    trading_ws_crypto_enabled: bool = Field(
        default=False,
        alias="TRADING_WS_CRYPTO_ENABLED",
        description="Deprecated compatibility alias for TRADING_CRYPTO_ENABLED.",
    )
    trading_universe_crypto_enabled: bool = Field(
        default=False,
        alias="TRADING_UNIVERSE_CRYPTO_ENABLED",
        description="Deprecated compatibility alias for TRADING_CRYPTO_ENABLED.",
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
    trading_signal_lookback_minutes: int = Field(
        default=15, alias="TRADING_SIGNAL_LOOKBACK_MINUTES"
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
    trading_signal_staleness_alert_critical_reasons_raw: Optional[str] = Field(
        default="cursor_ahead_of_stream,no_signals_in_window,universe_source_unavailable",
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
    trading_poll_ms: int = Field(default=5000, alias="TRADING_POLL_MS")
    trading_reconcile_ms: int = Field(default=15000, alias="TRADING_RECONCILE_MS")
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
    trading_strategy_runtime_mode: Literal["legacy", "plugin_v3", "scheduler_v3"] = (
        Field(
            default="scheduler_v3",
            alias="TRADING_STRATEGY_RUNTIME_MODE",
            description=(
                "Strategy runtime mode. plugin_v3 enables plugin scaffolding; "
                "scheduler_v3 uses scheduler integration with migration controls; "
                "legacy keeps current behavior."
            ),
        )
    )
    trading_strategy_scheduler_enabled: bool = Field(
        default=False,
        alias="TRADING_STRATEGY_SCHEDULER_ENABLED",
        description="Migration flag for scheduler-integrated strategy runtime path.",
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
    trading_forecast_service_url: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_SERVICE_URL",
        validation_alias=AliasChoices(
            "TRADING_FORECAST_SERVICE_URL",
            "TRADING_FORECAST_ROUTER_PROVIDER_URL",
        ),
        description="Base URL for the empirical forecast service.",
    )
    trading_forecast_service_timeout_seconds: int = Field(
        default=5,
        alias="TRADING_FORECAST_SERVICE_TIMEOUT_SECONDS",
        validation_alias=AliasChoices(
            "TRADING_FORECAST_SERVICE_TIMEOUT_SECONDS",
            "TRADING_FORECAST_ROUTER_PROVIDER_TIMEOUT_SECONDS",
        ),
        description="HTTP timeout for empirical forecast service requests.",
    )
    trading_forecast_service_require_healthy: bool = Field(
        default=True,
        alias="TRADING_FORECAST_SERVICE_REQUIRE_HEALTHY",
        description="Treat forecast service readiness failures as operational degradation.",
    )
    trading_forecast_service_fail_mode: Literal[
        "allow_operational_fallback", "fail_closed"
    ] = Field(
        default="allow_operational_fallback",
        alias="TRADING_FORECAST_SERVICE_FAIL_MODE",
        description="How Torghut reacts when empirical forecast service is unavailable.",
    )
    trading_forecast_service_allowed_model_families_raw: Optional[str] = Field(
        default="chronos,moment,financial_tsfm",
        alias="TRADING_FORECAST_SERVICE_ALLOWED_MODEL_FAMILIES",
        description="Comma-separated model families allowed from the empirical forecast service.",
    )
    trading_forecast_service_api_key: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_SERVICE_API_KEY",
        validation_alias=AliasChoices(
            "TRADING_FORECAST_SERVICE_API_KEY",
            "TRADING_FORECAST_ROUTER_PROVIDER_API_KEY",
        ),
        description="Optional API key forwarded to the empirical forecast service.",
    )
    trading_forecast_router_policy_path: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_ROUTER_POLICY_PATH",
        description="Optional path to forecast router policy JSON.",
    )
    trading_forecast_router_provider_mode: Literal["deterministic", "http"] = Field(
        default="deterministic",
        alias="TRADING_FORECAST_ROUTER_PROVIDER_MODE",
        description="Forecast producer mode. http enables external empirical inference service integration.",
    )
    trading_forecast_router_provider_url: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_ROUTER_PROVIDER_URL",
        description="Optional base URL for external forecast inference service.",
    )
    trading_forecast_router_provider_timeout_seconds: int = Field(
        default=5,
        alias="TRADING_FORECAST_ROUTER_PROVIDER_TIMEOUT_SECONDS",
        description="HTTP timeout for external forecast inference requests.",
    )
    trading_forecast_router_provider_api_key: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_ROUTER_PROVIDER_API_KEY",
        description="Optional API key forwarded to external forecast inference service.",
    )
    trading_forecast_registry_manifest_path: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_REGISTRY_MANIFEST_PATH",
        description="Path to the forecast model registry manifest consumed by torghut-forecast.",
    )
    trading_forecast_registry_manifest_url: Optional[str] = Field(
        default=None,
        alias="TRADING_FORECAST_REGISTRY_MANIFEST_URL",
        description="Optional HTTP URL for the forecast model registry manifest.",
    )
    trading_forecast_registry_refresh_seconds: int = Field(
        default=30,
        alias="TRADING_FORECAST_REGISTRY_REFRESH_SECONDS",
        description="Refresh cadence for torghut-forecast registry manifest reloads.",
    )
    trading_forecast_calibration_stale_after_seconds: int = Field(
        default=604800,
        alias="TRADING_FORECAST_CALIBRATION_STALE_AFTER_SECONDS",
        description="Forecast calibration freshness budget used by torghut-forecast readiness checks.",
    )
    trading_empirical_job_stale_after_seconds: int = Field(
        default=86400,
        alias="TRADING_EMPIRICAL_JOB_STALE_AFTER_SECONDS",
        description="Freshness budget for empirical parity and Janus workflow outputs.",
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
        default=120000,
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
    trading_autonomy_artifact_dir: str = Field(
        default=str(Path(tempfile.gettempdir()) / "torghut-autonomy"),
        alias="TRADING_AUTONOMY_ARTIFACT_DIR",
        description="Output directory for autonomous lane artifacts.",
    )
    trading_empirical_benchmark_parity_report_path: Optional[str] = Field(
        default=None,
        alias="TRADING_EMPIRICAL_BENCHMARK_PARITY_REPORT_PATH",
        description="Optional path to externally generated benchmark parity report JSON.",
    )
    trading_empirical_foundation_router_parity_report_path: Optional[str] = Field(
        default=None,
        alias="TRADING_EMPIRICAL_FOUNDATION_ROUTER_PARITY_REPORT_PATH",
        description="Optional path to externally generated foundation-router parity report JSON.",
    )
    trading_empirical_deeplob_bdlob_report_path: Optional[str] = Field(
        default=None,
        alias="TRADING_EMPIRICAL_DEEPLOB_BDLOB_REPORT_PATH",
        description="Optional path to externally generated DeepLOB/BDLOB report JSON.",
    )
    trading_empirical_advisor_fallback_slo_report_path: Optional[str] = Field(
        default=None,
        alias="TRADING_EMPIRICAL_ADVISOR_FALLBACK_SLO_REPORT_PATH",
        description="Optional path to externally generated advisor fallback SLO report JSON.",
    )
    trading_empirical_janus_event_car_path: Optional[str] = Field(
        default=None,
        alias="TRADING_EMPIRICAL_JANUS_EVENT_CAR_PATH",
        description="Optional path to externally generated Janus event/CAR artifact JSON.",
    )
    trading_empirical_janus_hgrm_reward_path: Optional[str] = Field(
        default=None,
        alias="TRADING_EMPIRICAL_JANUS_HGRM_REWARD_PATH",
        description="Optional path to externally generated Janus HGRM reward artifact JSON.",
    )
    trading_drift_governance_enabled: bool = Field(
        default=True,
        alias="TRADING_DRIFT_GOVERNANCE_ENABLED",
        description="Enable autonomous drift detection, trigger decisions, and audited governance artifacts.",
    )
    trading_drift_max_required_null_rate: float = Field(
        default=0.02,
        alias="TRADING_DRIFT_MAX_REQUIRED_NULL_RATE",
        description="Drift threshold for maximum required feature null-rate.",
    )
    trading_drift_max_staleness_ms_p95: int = Field(
        default=180000,
        alias="TRADING_DRIFT_MAX_STALENESS_MS_P95",
        description="Drift threshold for p95 feature staleness in milliseconds.",
    )
    trading_drift_max_duplicate_ratio: float = Field(
        default=0.05,
        alias="TRADING_DRIFT_MAX_DUPLICATE_RATIO",
        description="Drift threshold for duplicate event ratio.",
    )
    trading_drift_max_schema_mismatch_total: int = Field(
        default=0,
        alias="TRADING_DRIFT_MAX_SCHEMA_MISMATCH_TOTAL",
        description="Drift threshold for schema mismatch count.",
    )
    trading_drift_max_model_calibration_error: float = Field(
        default=0.45,
        alias="TRADING_DRIFT_MAX_MODEL_CALIBRATION_ERROR",
        description="Drift threshold for model calibration error from profitability evidence.",
    )
    trading_drift_max_model_llm_error_ratio: float = Field(
        default=0.10,
        alias="TRADING_DRIFT_MAX_MODEL_LLM_ERROR_RATIO",
        description="Drift threshold for LLM runtime error ratio.",
    )
    trading_drift_min_performance_net_pnl: float = Field(
        default=0.0,
        alias="TRADING_DRIFT_MIN_PERFORMANCE_NET_PNL",
        description="Drift floor for net PnL.",
    )
    trading_drift_max_performance_drawdown: float = Field(
        default=0.08,
        alias="TRADING_DRIFT_MAX_PERFORMANCE_DRAWDOWN",
        description="Drift threshold for absolute drawdown.",
    )
    trading_drift_max_performance_cost_bps: float = Field(
        default=35.0,
        alias="TRADING_DRIFT_MAX_PERFORMANCE_COST_BPS",
        description="Drift threshold for execution cost in bps.",
    )
    trading_drift_max_execution_fallback_ratio: float = Field(
        default=0.25,
        alias="TRADING_DRIFT_MAX_EXECUTION_FALLBACK_RATIO",
        description="Drift threshold for execution fallback ratio.",
    )
    trading_drift_trigger_retrain_reason_codes_raw: Optional[str] = Field(
        default=(
            "data_required_null_rate_exceeded,data_staleness_p95_exceeded,data_duplicate_ratio_exceeded,"
            "data_schema_mismatch_detected,model_calibration_error_exceeded,model_llm_error_ratio_exceeded"
        ),
        alias="TRADING_DRIFT_TRIGGER_RETRAIN_REASON_CODES",
        description="Comma-separated reason codes that trigger retraining workflows.",
    )
    trading_drift_trigger_reselection_reason_codes_raw: Optional[str] = Field(
        default=(
            "performance_net_pnl_below_floor,performance_drawdown_exceeded,performance_cost_bps_exceeded,"
            "performance_execution_fallback_ratio_exceeded"
        ),
        alias="TRADING_DRIFT_TRIGGER_RESELECTION_REASON_CODES",
        description="Comma-separated reason codes that trigger reselection workflows.",
    )
    trading_drift_retrain_cooldown_seconds: int = Field(
        default=3600,
        alias="TRADING_DRIFT_RETRAIN_COOLDOWN_SECONDS",
        description="Cooldown between retraining triggers for repeated drift incidents.",
    )
    trading_drift_reselection_cooldown_seconds: int = Field(
        default=3600,
        alias="TRADING_DRIFT_RESELECTION_COOLDOWN_SECONDS",
        description="Cooldown between reselection triggers for repeated drift incidents.",
    )
    trading_drift_live_promotion_requires_evidence: bool = Field(
        default=True,
        alias="TRADING_DRIFT_LIVE_PROMOTION_REQUIRES_EVIDENCE",
        description="Require explicit drift-governance evidence before autonomous live promotion.",
    )
    trading_drift_live_promotion_max_evidence_age_seconds: int = Field(
        default=1800,
        alias="TRADING_DRIFT_LIVE_PROMOTION_MAX_EVIDENCE_AGE_SECONDS",
        description="Maximum age for drift evidence used to authorize live promotion.",
    )
    trading_drift_rollback_on_performance: bool = Field(
        default=True,
        alias="TRADING_DRIFT_ROLLBACK_ON_PERFORMANCE",
        description="Trigger emergency rollback hooks when configured performance drift reason codes are detected.",
    )
    trading_drift_rollback_reason_codes_raw: Optional[str] = Field(
        default=(
            "performance_net_pnl_below_floor,performance_drawdown_exceeded,performance_cost_bps_exceeded,"
            "performance_execution_fallback_ratio_exceeded"
        ),
        alias="TRADING_DRIFT_ROLLBACK_REASON_CODES",
        description="Comma-separated drift reason codes that trigger rollback hooks.",
    )
    trading_evidence_continuity_enabled: bool = Field(
        default=True,
        alias="TRADING_EVIDENCE_CONTINUITY_ENABLED",
        description="Enable periodic research evidence continuity reconciliation checks.",
    )
    trading_evidence_continuity_interval_seconds: int = Field(
        default=86400,
        alias="TRADING_EVIDENCE_CONTINUITY_INTERVAL_SECONDS",
        description="Interval between evidence continuity checks.",
    )
    trading_evidence_continuity_run_limit: int = Field(
        default=8,
        alias="TRADING_EVIDENCE_CONTINUITY_RUN_LIMIT",
        description="How many latest non-skipped research runs to check for continuity.",
    )
    trading_universe_source: Literal["jangar", "static"] = Field(
        default="static", alias="TRADING_UNIVERSE_SOURCE"
    )
    trading_universe_require_non_empty_jangar: bool = Field(
        default=True,
        alias="TRADING_UNIVERSE_REQUIRE_NON_EMPTY_JANGAR",
        description="Fail closed when Jangar-backed universe cannot be resolved to a non-empty symbol set.",
    )
    trading_universe_static_fallback_enabled: bool = Field(
        default=False,
        alias="TRADING_UNIVERSE_STATIC_FALLBACK_ENABLED",
        description=(
            "When enabled, Jangar resolution failures may fall back to static symbols if configured. "
            "Fail-closed behavior remains in effect when no fallback symbols are available."
        ),
    )
    trading_universe_static_fallback_symbols_raw: Optional[str] = Field(
        default=None,
        alias="TRADING_UNIVERSE_STATIC_FALLBACK_SYMBOLS",
        description=(
            "Optional comma-separated fallback symbols used only when "
            "TRADING_UNIVERSE_STATIC_FALLBACK_ENABLED=true and Jangar resolution is unavailable."
        ),
    )
    trading_universe_max_stale_seconds: int = Field(
        default=900,
        alias="TRADING_UNIVERSE_MAX_STALE_SECONDS",
        description="Maximum age for cached Jangar symbol universe before it is treated as stale.",
    )
    trading_static_symbols_raw: Optional[str] = Field(
        default=None, alias="TRADING_STATIC_SYMBOLS"
    )
    trading_universe_cache_seconds: int = Field(
        default=300, alias="TRADING_UNIVERSE_CACHE_SECONDS"
    )
    trading_universe_timeout_seconds: int = Field(
        default=5, alias="TRADING_UNIVERSE_TIMEOUT_SECONDS"
    )
    trading_default_qty: int = Field(default=1, alias="TRADING_DEFAULT_QTY")
    trading_max_notional_per_trade: Optional[float] = Field(
        default=None, alias="TRADING_MAX_NOTIONAL_PER_TRADE"
    )
    trading_min_notional_per_trade: Optional[float] = Field(
        default=None, alias="TRADING_MIN_NOTIONAL_PER_TRADE"
    )
    trading_max_participation_rate: Optional[float] = Field(
        default=None, alias="TRADING_MAX_PARTICIPATION_RATE"
    )
    trading_execution_prefer_limit: bool = Field(
        default=True, alias="TRADING_EXECUTION_PREFER_LIMIT"
    )
    trading_execution_max_retries: int = Field(
        default=0, alias="TRADING_EXECUTION_MAX_RETRIES"
    )
    trading_execution_backoff_base_seconds: float = Field(
        default=0.25, alias="TRADING_EXECUTION_BACKOFF_BASE_SECONDS"
    )
    trading_execution_backoff_multiplier: float = Field(
        default=2.0, alias="TRADING_EXECUTION_BACKOFF_MULTIPLIER"
    )
    trading_execution_backoff_max_seconds: float = Field(
        default=2.0, alias="TRADING_EXECUTION_BACKOFF_MAX_SECONDS"
    )
    trading_execution_advisor_enabled: bool = Field(
        default=True,
        alias="TRADING_EXECUTION_ADVISOR_ENABLED",
        description="Enable bounded microstructure execution advisor integration.",
    )
    trading_execution_advisor_live_apply_enabled: bool = Field(
        default=False,
        alias="TRADING_EXECUTION_ADVISOR_LIVE_APPLY_ENABLED",
        description="Allow advisor outputs to alter broker-facing execution behavior.",
    )
    trading_execution_advisor_max_staleness_seconds: int = Field(
        default=15,
        alias="TRADING_EXECUTION_ADVISOR_MAX_STALENESS_SECONDS",
        description="Maximum tolerated age for advisor microstructure/advice payloads.",
    )
    trading_execution_advisor_timeout_ms: int = Field(
        default=250,
        alias="TRADING_EXECUTION_ADVISOR_TIMEOUT_MS",
        description="Maximum tolerated advisor inference latency before deterministic fallback.",
    )
    trading_execution_adapter: Literal["alpaca", "lean", "simulation"] = Field(
        default="alpaca",
        alias="TRADING_EXECUTION_ADAPTER",
        description="Primary execution adapter selection.",
    )
    trading_execution_fallback_adapter: Literal["none", "alpaca"] = Field(
        default="alpaca",
        alias="TRADING_EXECUTION_FALLBACK_ADAPTER",
        description="Fallback adapter when primary adapter fails.",
    )
    trading_execution_adapter_policy: Literal["all", "allowlist"] = Field(
        default="allowlist",
        alias="TRADING_EXECUTION_ADAPTER_POLICY",
        description="Execution adapter routing policy.",
    )
    trading_execution_adapter_symbols_raw: Optional[str] = Field(
        default=None,
        alias="TRADING_EXECUTION_ADAPTER_SYMBOLS",
        description="Comma-separated symbol allowlist for adapter routing.",
    )
    trading_simulation_enabled: bool = Field(
        default=False,
        alias="TRADING_SIMULATION_ENABLED",
        description="Enable simulation-mode persistence and execution metadata paths.",
    )
    trading_simulation_run_id: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_RUN_ID",
        description="Stable identifier for a simulation run.",
    )
    trading_simulation_dataset_id: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_DATASET_ID",
        description="Dataset identifier attached to simulation telemetry.",
    )
    trading_simulation_clock_mode: Literal["live", "cursor"] = Field(
        default="cursor",
        alias="TRADING_SIMULATION_CLOCK_MODE",
        description="Authoritative time source for the trading runtime when simulation mode is enabled.",
    )
    trading_simulation_window_start: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_WINDOW_START",
        description="Replay window start timestamp used as the fallback simulation clock when no cursor is available.",
    )
    trading_simulation_window_end: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_WINDOW_END",
        description="Replay window end timestamp attached to simulation runtime status.",
    )
    trading_simulation_clock_cache_seconds: int = Field(
        default=1,
        alias="TRADING_SIMULATION_CLOCK_CACHE_SECONDS",
        description="Cache TTL for replay clock lookups against the simulation cursor store.",
    )
    trading_simulation_fetch_window_seconds: int = Field(
        default=10,
        alias="TRADING_SIMULATION_FETCH_WINDOW_SECONDS",
        description="Maximum simulation signal window drained per ingest fetch.",
    )
    trading_simulation_universe_symbols_path: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_UNIVERSE_SYMBOLS_PATH",
        description="Optional JSON file containing the replay-scoped symbol universe for dedicated simulation runs.",
    )
    trading_simulation_order_updates_topic: str = Field(
        default="torghut.sim.trade-updates.v1",
        alias="TRADING_SIMULATION_ORDER_UPDATES_TOPIC",
        description="Kafka topic for simulated trade-updates events.",
    )
    trading_simulation_order_updates_bootstrap_servers: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_ORDER_UPDATES_BOOTSTRAP_SERVERS",
        description="Kafka bootstrap servers for simulated trade-updates emission; defaults to order-feed bootstrap.",
    )
    trading_simulation_order_updates_security_protocol: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_ORDER_UPDATES_SECURITY_PROTOCOL",
        description="Kafka security protocol for simulated trade-updates emission; defaults to order-feed protocol.",
    )
    trading_simulation_order_updates_sasl_mechanism: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_ORDER_UPDATES_SASL_MECHANISM",
        description="Kafka SASL mechanism for simulated trade-updates emission; defaults to order-feed mechanism.",
    )
    trading_simulation_order_updates_sasl_username: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_ORDER_UPDATES_SASL_USERNAME",
        description="Kafka SASL username for simulated trade-updates emission; defaults to order-feed username.",
    )
    trading_simulation_order_updates_sasl_password: Optional[str] = Field(
        default=None,
        alias="TRADING_SIMULATION_ORDER_UPDATES_SASL_PASSWORD",
        description="Kafka SASL password for simulated trade-updates emission; defaults to order-feed password.",
    )
    trading_lean_runner_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_RUNNER_URL",
        description="Base URL for LEAN runner API.",
    )
    trading_lean_runner_timeout_seconds: int = Field(
        default=5,
        alias="TRADING_LEAN_RUNNER_TIMEOUT_SECONDS",
        description="HTTP timeout for LEAN runner calls.",
    )
    trading_lean_runner_upstream_timeout_seconds: int = Field(
        default=10,
        alias="TRADING_LEAN_RUNNER_UPSTREAM_TIMEOUT_SECONDS",
        description="HTTP timeout for LEAN runner upstream proxy calls.",
    )
    trading_lean_backtest_upstream_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_BACKTEST_UPSTREAM_URL",
        description="Optional upstream URL for authoritative LEAN backtest submission and polling.",
    )
    trading_lean_shadow_upstream_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_SHADOW_UPSTREAM_URL",
        description="Optional upstream URL for authoritative LEAN shadow simulation.",
    )
    trading_lean_strategy_shadow_upstream_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_STRATEGY_SHADOW_UPSTREAM_URL",
        description="Optional upstream URL for authoritative LEAN strategy shadow evaluation.",
    )
    trading_lean_runner_healthcheck_enabled: bool = Field(
        default=True,
        alias="TRADING_LEAN_RUNNER_HEALTHCHECK_ENABLED",
        description="Validate LEAN runner /healthz before enabling LEAN adapter routing.",
    )
    trading_lean_runner_healthcheck_timeout_seconds: int = Field(
        default=2,
        alias="TRADING_LEAN_RUNNER_HEALTHCHECK_TIMEOUT_SECONDS",
        description="HTTP timeout for LEAN runner preflight health checks.",
    )
    trading_lean_runner_require_healthy: bool = Field(
        default=True,
        alias="TRADING_LEAN_RUNNER_REQUIRE_HEALTHY",
        description="Fallback to Alpaca adapter when LEAN runner preflight health checks fail.",
    )
    trading_lean_backtest_enabled: bool = Field(
        default=False,
        alias="TRADING_LEAN_BACKTEST_ENABLED",
        description="Enable asynchronous LEAN backtest lane orchestration.",
    )
    trading_lean_shadow_execution_enabled: bool = Field(
        default=False,
        alias="TRADING_LEAN_SHADOW_EXECUTION_ENABLED",
        description="Enable LEAN execution shadow simulation telemetry for live intents.",
    )
    trading_lean_strategy_shadow_enabled: bool = Field(
        default=False,
        alias="TRADING_LEAN_STRATEGY_SHADOW_ENABLED",
        description="Enable LEAN strategy-runtime shadow evaluations without control-plane replacement.",
    )
    trading_lean_live_canary_enabled: bool = Field(
        default=False,
        alias="TRADING_LEAN_LIVE_CANARY_ENABLED",
        description="Enable strict LEAN live canary routing controls.",
    )
    trading_lean_lane_disable_switch: bool = Field(
        default=False,
        alias="TRADING_LEAN_LANE_DISABLE_SWITCH",
        description="Emergency hard disable for LEAN multi-lane behavior.",
    )
    trading_lean_live_canary_crypto_only: bool = Field(
        default=True,
        alias="TRADING_LEAN_LIVE_CANARY_CRYPTO_ONLY",
        description="Restrict LEAN live canary activation to crypto symbols only.",
    )
    trading_lean_live_canary_symbols_raw: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_LIVE_CANARY_SYMBOLS",
        description="Comma-separated symbol allowlist for LEAN live canaries.",
    )
    trading_lean_live_canary_fallback_ratio_limit: float = Field(
        default=0.25,
        alias="TRADING_LEAN_LIVE_CANARY_FALLBACK_RATIO_LIMIT",
        description="Hard rollback trigger threshold for LEAN fallback ratio in live canary.",
    )
    trading_lean_live_canary_hard_rollback_enabled: bool = Field(
        default=True,
        alias="TRADING_LEAN_LIVE_CANARY_HARD_ROLLBACK_ENABLED",
        description="Trigger emergency stop and evidence capture when live canary breaches thresholds.",
    )
    trading_max_position_pct_equity: Optional[float] = Field(
        default=None, alias="TRADING_MAX_POSITION_PCT_EQUITY"
    )
    trading_portfolio_notional_per_position: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_NOTIONAL_PER_POSITION",
        description="Target notional per position for portfolio sizing (optional).",
    )
    trading_portfolio_volatility_target: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_VOLATILITY_TARGET",
        description="Volatility target for portfolio sizing (optional).",
    )
    trading_portfolio_volatility_floor: float = Field(
        default=0.0,
        alias="TRADING_PORTFOLIO_VOLATILITY_FLOOR",
        description="Floor used when scaling by volatility (default 0).",
    )
    trading_portfolio_max_positions: Optional[int] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_POSITIONS",
        description="Max concurrent positions allowed (optional).",
    )
    trading_portfolio_max_notional_per_symbol: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_NOTIONAL_PER_SYMBOL",
        description="Max notional per symbol for portfolio sizing (optional).",
    )
    trading_portfolio_max_gross_exposure: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_GROSS_EXPOSURE",
        description="Absolute gross exposure cap (optional).",
    )
    trading_portfolio_max_gross_exposure_pct_equity: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_GROSS_EXPOSURE_PCT_EQUITY",
        description="Gross exposure cap as a pct of equity (optional).",
    )
    trading_portfolio_max_net_exposure: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_NET_EXPOSURE",
        description="Absolute net exposure cap (optional).",
    )
    trading_portfolio_max_net_exposure_pct_equity: Optional[float] = Field(
        default=None,
        alias="TRADING_PORTFOLIO_MAX_NET_EXPOSURE_PCT_EQUITY",
        description="Net exposure cap as a pct of equity (optional).",
    )
    trading_allocator_enabled: bool = Field(
        default=False,
        alias="TRADING_ALLOCATOR_ENABLED",
        description="Enable deterministic portfolio allocator before execution policy and risk checks.",
    )
    trading_allocator_default_regime: str = Field(
        default="neutral",
        alias="TRADING_ALLOCATOR_DEFAULT_REGIME",
        description="Fallback regime label used when no regime context is present on a signal/decision.",
    )
    trading_allocator_default_budget_multiplier: float = Field(
        default=1.0,
        alias="TRADING_ALLOCATOR_DEFAULT_BUDGET_MULTIPLIER",
        description="Default budget multiplier applied when regime-specific override is absent.",
    )
    trading_allocator_default_capacity_multiplier: float = Field(
        default=1.0,
        alias="TRADING_ALLOCATOR_DEFAULT_CAPACITY_MULTIPLIER",
        description="Default symbol-capacity multiplier when regime-specific override is absent.",
    )
    trading_allocator_regime_low_confidence_threshold: float = Field(
        default=0.60,
        alias="TRADING_ALLOCATOR_REGIME_LOW_CONFIDENCE_THRESHOLD",
        description="Posterior confidence threshold below which low-confidence regime protection applies.",
    )
    trading_allocator_regime_low_confidence_multiplier: float = Field(
        default=0.70,
        alias="TRADING_ALLOCATOR_REGIME_LOW_CONFIDENCE_MULTIPLIER",
        description="Multiplier applied when regime confidence is below threshold.",
    )
    trading_allocator_min_multiplier: float = Field(
        default=0.0,
        alias="TRADING_ALLOCATOR_MIN_MULTIPLIER",
        description="Lower bound clamp for allocator multipliers to preserve deterministic behavior.",
    )
    trading_allocator_max_multiplier: float = Field(
        default=2.0,
        alias="TRADING_ALLOCATOR_MAX_MULTIPLIER",
        description="Upper bound clamp for allocator multipliers to preserve deterministic behavior.",
    )
    trading_allocator_max_symbol_pct_equity: Optional[float] = Field(
        default=None,
        alias="TRADING_ALLOCATOR_MAX_SYMBOL_PCT_EQUITY",
        description="Allocator pre-risk concentration cap as percent of equity per symbol (optional).",
    )
    trading_allocator_max_symbol_notional: Optional[float] = Field(
        default=None,
        alias="TRADING_ALLOCATOR_MAX_SYMBOL_NOTIONAL",
        description="Allocator pre-risk concentration cap as absolute notional per symbol (optional).",
    )
    trading_allocator_symbol_correlation_groups: dict[str, str] = Field(
        default_factory=dict,
        alias="TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS",
        validation_alias=AliasChoices(
            "TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS",
            "TRADING_ALLOCATOR_CORRELATION_SYMBOL_GROUPS",
        ),
        description="Symbol->correlation group map used for correlation-aware throttles (JSON object).",
    )
    trading_allocator_regime_budget_multipliers: dict[str, float] = Field(
        default_factory=dict,
        alias="TRADING_ALLOCATOR_REGIME_BUDGET_MULTIPLIERS",
        description="Regime->budget multiplier map used by allocator (JSON object).",
    )
    trading_allocator_regime_capacity_multipliers: dict[str, float] = Field(
        default_factory=dict,
        alias="TRADING_ALLOCATOR_REGIME_CAPACITY_MULTIPLIERS",
        description="Regime->symbol capacity multiplier map used by allocator (JSON object).",
    )
    trading_runtime_uncertainty_degrade_qty_multipliers_by_regime: dict[str, float] = (
        Field(
            default_factory=dict,
            alias="TRADING_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIERS_BY_REGIME",
            description=(
                "Regime->qty multiplier map used when runtime uncertainty gate selects degrade."
            ),
        )
    )
    trading_runtime_uncertainty_degrade_max_participation_rate_by_regime: dict[
        str, float
    ] = Field(
        default_factory=dict,
        alias="TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE_BY_REGIME",
        description=(
            "Regime->max participation override map used when runtime uncertainty gate "
            "selects degrade."
        ),
    )
    trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime: dict[
        str, float
    ] = Field(
        default_factory=dict,
        alias="TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME",
        description=(
            "Regime->minimum execution seconds map used when runtime uncertainty "
            "gate selects degrade."
        ),
    )
    trading_runtime_regime_confidence_thresholds_by_entropy_band: dict[
        str, tuple[float, float]
    ] = Field(
        default_factory=lambda: {
            "low": (0.65, 0.45),
            "medium": (0.75, 0.55),
            "high": (0.85, 0.70),
        },
        alias="TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND",
        description=(
            "Entropy-band->(degrade_threshold, abstain_threshold) pairs used by "
            "runtime regime-confidence gating."
        ),
    )
    trading_allocator_strategy_notional_caps: dict[str, float] = Field(
        default_factory=dict,
        alias="TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS",
        description="Strategy->per-cycle notional budget cap map used by allocator (JSON object).",
    )
    trading_allocator_symbol_notional_caps: dict[str, float] = Field(
        default_factory=dict,
        alias="TRADING_ALLOCATOR_SYMBOL_NOTIONAL_CAPS",
        description="Symbol->per-cycle notional budget cap map used by allocator (JSON object).",
    )
    trading_allocator_correlation_group_caps: dict[str, float] = Field(
        default_factory=dict,
        alias="TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS",
        validation_alias=AliasChoices(
            "TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS",
            "TRADING_ALLOCATOR_CORRELATION_GROUP_NOTIONAL_CAPS",
        ),
        description="Correlation-group->per-cycle notional cap map used by allocator (JSON object).",
    )
    trading_fragility_mode: Literal["off", "observe", "enforce"] = Field(
        default="enforce",
        alias="TRADING_FRAGILITY_MODE",
        description="Fragility enforcement mode for allocator and risk checks.",
    )
    trading_fragility_unknown_state: Literal[
        "normal", "elevated", "stress", "crisis"
    ] = Field(
        default="elevated",
        alias="TRADING_FRAGILITY_UNKNOWN_STATE",
        description="Conservative fragility fallback state when fragility features are missing/invalid.",
    )
    trading_fragility_elevated_threshold: float = Field(
        default=0.35,
        alias="TRADING_FRAGILITY_ELEVATED_THRESHOLD",
        description="Score threshold for elevated fragility state.",
    )
    trading_fragility_stress_threshold: float = Field(
        default=0.55,
        alias="TRADING_FRAGILITY_STRESS_THRESHOLD",
        description="Score threshold for stress fragility state.",
    )
    trading_fragility_crisis_threshold: float = Field(
        default=0.80,
        alias="TRADING_FRAGILITY_CRISIS_THRESHOLD",
        description="Score threshold for crisis fragility state.",
    )
    trading_fragility_state_budget_multipliers: dict[str, float] = Field(
        default_factory=lambda: {
            "normal": 1.0,
            "elevated": 0.85,
            "stress": 0.55,
            "crisis": 0.25,
        },
        alias="TRADING_FRAGILITY_STATE_BUDGET_MULTIPLIERS",
        description="Fragility-state budget multipliers applied by allocator; values are clamped to [0,1].",
    )
    trading_fragility_state_capacity_multipliers: dict[str, float] = Field(
        default_factory=lambda: {
            "normal": 1.0,
            "elevated": 0.8,
            "stress": 0.5,
            "crisis": 0.2,
        },
        alias="TRADING_FRAGILITY_STATE_CAPACITY_MULTIPLIERS",
        description="Fragility-state symbol capacity multipliers applied by allocator; values are clamped to [0,1].",
    )
    trading_fragility_state_participation_clamps: dict[str, float] = Field(
        default_factory=lambda: {
            "normal": 0.1,
            "elevated": 0.08,
            "stress": 0.04,
            "crisis": 0.02,
        },
        alias="TRADING_FRAGILITY_STATE_PARTICIPATION_CLAMPS",
        description="Fragility-state max participation clamps forwarded to execution policy.",
    )
    trading_fragility_state_abstain_bias: dict[str, float] = Field(
        default_factory=lambda: {
            "normal": 0.0,
            "elevated": 0.15,
            "stress": 0.40,
            "crisis": 0.75,
        },
        alias="TRADING_FRAGILITY_STATE_ABSTAIN_BIAS",
        description="Fragility-state abstain bias for autonomy/execution participation controls.",
    )
    trading_cooldown_seconds: int = Field(default=0, alias="TRADING_COOLDOWN_SECONDS")
    trading_planned_decision_timeout_seconds: int = Field(
        default=600,
        alias="TRADING_PLANNED_DECISION_TIMEOUT_SECONDS",
        description=(
            "Maximum age (seconds) for a trade_decisions row to remain in planned state "
            "without an execution before it is force-rejected."
        ),
    )
    trading_allow_shorts: bool = Field(default=False, alias="TRADING_ALLOW_SHORTS")
    trading_fractional_equities_enabled: bool = Field(
        default=False,
        alias="TRADING_FRACTIONAL_EQUITIES_ENABLED",
        description=(
            "Allow fractional equity quantities for long-side orders. "
            "Short-increasing equity orders remain whole-share only."
        ),
    )
    trading_account_label: str = Field(default="paper", alias="TRADING_ACCOUNT_LABEL")
    trading_accounts_json: Optional[str] = Field(
        default=None,
        alias="TRADING_ACCOUNTS_JSON",
        description=(
            "Optional JSON account registry for multi-account execution. "
            "Accepted forms: array of accounts or object with {accounts:[...]}."
        ),
    )
    trading_kill_switch_enabled: bool = Field(
        default=True, alias="TRADING_KILL_SWITCH_ENABLED"
    )
    trading_emergency_stop_enabled: bool = Field(
        default=False,
        alias="TRADING_EMERGENCY_STOP_ENABLED",
        description="Enable autonomous emergency stop hooks that block order submission after critical safety breaches.",
    )
    trading_emergency_stop_recovery_cycles: int = Field(
        default=3,
        alias="TRADING_EMERGENCY_STOP_RECOVERY_CYCLES",
        description=(
            "Consecutive safety-control cycles with no freshness breach before auto-clearing "
            "a freshness-triggered emergency stop."
        ),
    )
    trading_rollback_signal_lag_seconds_limit: int = Field(
        default=600,
        alias="TRADING_ROLLBACK_SIGNAL_LAG_SECONDS_LIMIT",
        description="Signal lag threshold (seconds) that triggers autonomous emergency stop.",
    )
    trading_rollback_signal_staleness_alert_streak_limit: int = Field(
        default=3,
        alias="TRADING_ROLLBACK_SIGNAL_STALENESS_ALERT_STREAK_LIMIT",
        description="Consecutive critical signal staleness reasons allowed before emergency stop.",
    )
    trading_rollback_autonomy_failure_streak_limit: int = Field(
        default=3,
        alias="TRADING_ROLLBACK_AUTONOMY_FAILURE_STREAK_LIMIT",
        description="Consecutive autonomous lane failures allowed before emergency stop.",
    )
    trading_rollback_fallback_ratio_limit: float = Field(
        default=0.25,
        alias="TRADING_ROLLBACK_FALLBACK_RATIO_LIMIT",
        description="Execution fallback ratio threshold that triggers emergency stop.",
    )
    trading_rollback_max_drawdown_limit: float = Field(
        default=0.08,
        alias="TRADING_ROLLBACK_MAX_DRAWDOWN_LIMIT",
        description="Absolute drawdown threshold from autonomous gate artifacts that triggers emergency stop.",
    )
    trading_jangar_symbols_url: Optional[str] = Field(
        default=None, alias="JANGAR_SYMBOLS_URL"
    )
    trading_jangar_control_plane_status_url: Optional[str] = Field(
        default=None,
        alias="TRADING_JANGAR_CONTROL_PLANE_STATUS_URL",
        description=(
            "Optional Jangar control-plane status endpoint used for hypothesis dependency quorum checks."
        ),
    )
    trading_jangar_control_plane_timeout_seconds: float = Field(
        default=2.0,
        alias="TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS",
        description="Timeout for Jangar control-plane status fetches.",
    )
    trading_jangar_control_plane_cache_ttl_seconds: int = Field(
        default=15,
        alias="TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS",
        description="Cache TTL for Jangar control-plane status used by hypothesis readiness.",
    )
    trading_market_context_url: Optional[str] = Field(
        default=None,
        alias="TRADING_MARKET_CONTEXT_URL",
        description="Jangar market-context endpoint consumed by LLM review.",
    )
    trading_market_context_timeout_seconds: int = Field(
        default=300,
        alias="TRADING_MARKET_CONTEXT_TIMEOUT_SECONDS",
        description="Timeout for market-context fetches.",
    )
    trading_market_context_required: bool = Field(
        default=False,
        alias="TRADING_MARKET_CONTEXT_REQUIRED",
        description="Require market context for LLM requests.",
    )
    trading_market_context_fail_mode: Literal["shadow_only", "fail_closed"] = Field(
        default="shadow_only",
        alias="TRADING_MARKET_CONTEXT_FAIL_MODE",
        description="How to handle missing/low-quality market context.",
    )
    trading_market_context_min_quality: float = Field(
        default=0.4,
        alias="TRADING_MARKET_CONTEXT_MIN_QUALITY",
        description="Minimum quality score for allowing LLM reviews.",
    )
    trading_market_context_max_staleness_seconds: int = Field(
        default=300,
        alias="TRADING_MARKET_CONTEXT_MAX_STALENESS_SECONDS",
        description="Maximum accepted market-context staleness.",
    )
    trading_market_context_allow_degraded_last_good: bool = Field(
        default=True,
        alias="TRADING_MARKET_CONTEXT_ALLOW_DEGRADED_LAST_GOOD",
        description="Allow degraded last-good market context when generation failed but a bounded stale snapshot exists.",
    )
    trading_market_context_fundamentals_degraded_max_staleness_seconds: int = Field(
        default=86400,
        alias="TRADING_MARKET_CONTEXT_FUNDAMENTALS_DEGRADED_MAX_STALENESS_SECONDS",
        description="Hard stale cap for degraded last-good fundamentals context.",
    )
    trading_market_context_news_degraded_max_staleness_seconds: int = Field(
        default=1800,
        alias="TRADING_MARKET_CONTEXT_NEWS_DEGRADED_MAX_STALENESS_SECONDS",
        description="Hard stale cap for degraded last-good news context.",
    )
    trading_clickhouse_url: Optional[str] = Field(
        default=None, alias="TA_CLICKHOUSE_URL"
    )
    trading_clickhouse_username: Optional[str] = Field(
        default=None, alias="TA_CLICKHOUSE_USERNAME"
    )
    trading_clickhouse_password: Optional[str] = Field(
        default=None, alias="TA_CLICKHOUSE_PASSWORD"
    )
    trading_clickhouse_timeout_seconds: int = Field(
        default=5,
        alias="TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS",
        validation_alias=AliasChoices(
            "TA_CLICKHOUSE_CONN_TIMEOUT_SECONDS", "CLICKHOUSE_TIMEOUT_SECONDS"
        ),
    )
    trading_readiness_dependency_cache_enabled: bool = Field(
        default=True,
        alias="TRADING_READINESS_DEPENDENCY_CACHE_ENABLED",
        description=(
            "Cache readiness dependency checks for probe stability while avoiding constant "
            "dependency calls under high probe frequency."
        ),
    )
    trading_readiness_dependency_cache_ttl_seconds: int = Field(
        default=8,
        alias="TRADING_READINESS_DEPENDENCY_CACHE_TTL_SECONDS",
        description=(
            "Maximum cache age for readiness dependency checks (in seconds). Set to 0 to "
            "force synchronous checks on every request."
        ),
    )
    trading_readiness_dependency_cache_stale_tolerance_seconds: int = Field(
        default=20,
        alias="TRADING_READINESS_DEPENDENCY_CACHE_STALE_TOLERANCE_SECONDS",
        description=(
            "Additional seconds allowed to reuse stale readiness dependency cache "
            "on /readyz requests before a hard refresh is forced."
        ),
    )
    trading_alpaca_healthcheck_timeout_seconds: float = Field(
        default=2.0,
        alias="TRADING_ALPACA_HEALTHCHECK_TIMEOUT_SECONDS",
        description=(
            "Timeout in seconds for a single Alpaca account probe used by readiness "
            "checks."
        ),
    )
    trading_alpaca_healthcheck_retries: int = Field(
        default=2,
        alias="TRADING_ALPACA_HEALTHCHECK_RETRIES",
        description=(
            "Number of Alpaca account-probe attempts before readiness marks the "
            "broker unavailable."
        ),
    )
    trading_alpaca_healthcheck_backoff_seconds: float = Field(
        default=0.25,
        alias="TRADING_ALPACA_HEALTHCHECK_BACKOFF_SECONDS",
        description=(
            "Base backoff in seconds between Alpaca readiness retries."
        ),
    )
    trading_alpaca_healthcheck_last_good_ttl_seconds: int = Field(
        default=90,
        alias="TRADING_ALPACA_HEALTHCHECK_LAST_GOOD_TTL_SECONDS",
        description=(
            "How long readiness may trust the last successful Alpaca probe when the "
            "broker is only slow or transiently unreachable."
        ),
    )
    trading_db_schema_graph_branch_tolerance: int = Field(
        default=1,
        alias="TRADING_DB_SCHEMA_GRAPH_BRANCH_TOLERANCE",
        description=(
            "Maximum allowed migration graph branch count before readiness marks "
            "lineage divergence."
        ),
    )
    trading_db_schema_graph_allow_divergence_roots: bool = Field(
        default=False,
        alias="TRADING_DB_SCHEMA_GRAPH_ALLOW_DIVERGENCE_ROOTS",
        description=(
            "Allow schema graph branch-count divergence as a warning instead of a "
            "hard readiness failure."
        ),
    )
    trading_startup_readiness_grace_seconds: int = Field(
        default=45,
        alias="TRADING_STARTUP_READINESS_GRACE_SECONDS",
        description=(
            "Grace window (in seconds) where startup delay is allowed while "
            "readiness remains optimistic during scheduler startup initialization."
        ),
    )

    # Jangar gateway (recommended for LLM calls in-cluster).
    jangar_base_url: Optional[str] = Field(default=None, alias="JANGAR_BASE_URL")
    jangar_api_key: Optional[str] = Field(default=None, alias="JANGAR_API_KEY")
    posthog_enabled: bool = Field(
        default=False,
        alias="POSTHOG_ENABLED",
        description=(
            "Enable best-effort PostHog domain telemetry capture. This must never block trading execution."
        ),
    )
    posthog_host: Optional[str] = Field(default=None, alias="POSTHOG_HOST")
    posthog_api_key: Optional[str] = Field(default=None, alias="POSTHOG_API_KEY")
    posthog_project_id: Optional[str] = Field(default=None, alias="POSTHOG_PROJECT_ID")
    posthog_timeout_seconds: float = Field(default=1.0, alias="POSTHOG_TIMEOUT_SECONDS")
    posthog_distinct_id: str = Field(
        default="torghut-service",
        alias="POSTHOG_DISTINCT_ID",
    )

    llm_enabled: bool = Field(default=True, alias="LLM_ENABLED")
    llm_model: str = Field(default="gpt-5.3-codex-spark", alias="LLM_MODEL")
    llm_prompt_version: str = Field(default="v1", alias="LLM_PROMPT_VERSION")
    llm_temperature: float = Field(default=0.2, alias="LLM_TEMPERATURE")
    llm_max_tokens: int = Field(default=300, alias="LLM_MAX_TOKENS")
    llm_timeout_seconds: int = Field(default=20, alias="LLM_TIMEOUT_SECONDS")
    llm_fail_mode: Literal["veto", "pass_through"] = Field(
        default="veto", alias="LLM_FAIL_MODE"
    )
    llm_fail_mode_enforcement: Literal["strict_veto", "configured"] = Field(
        default="strict_veto",
        alias="LLM_FAIL_MODE_ENFORCEMENT",
        description=(
            "strict_veto keeps deterministic fail-closed posture across modes. configured honors LLM_FAIL_MODE "
            "except where rollout-stage policy overrides apply."
        ),
    )
    llm_fail_open_live_approved: bool = Field(
        default=False,
        alias="LLM_FAIL_OPEN_LIVE_APPROVED",
        description=(
            "Explicit approval gate required before enabling live pass-through fail-open behavior for the "
            "effective rollout stage."
        ),
    )
    llm_min_confidence: float = Field(default=0.5, alias="LLM_MIN_CONFIDENCE")
    llm_min_calibrated_top_probability: float = Field(
        default=0.45, alias="LLM_MIN_CALIBRATED_TOP_PROBABILITY"
    )
    llm_min_probability_margin: float = Field(
        default=0.05, alias="LLM_MIN_PROBABILITY_MARGIN"
    )
    llm_max_uncertainty: float = Field(default=0.6, alias="LLM_MAX_UNCERTAINTY")
    llm_max_uncertainty_band: Literal["low", "medium", "high"] = Field(
        default="medium", alias="LLM_MAX_UNCERTAINTY_BAND"
    )
    llm_min_calibration_quality_score: float = Field(
        default=0.5, alias="LLM_MIN_CALIBRATION_QUALITY_SCORE"
    )
    llm_abstain_fail_mode: Literal["veto", "pass_through"] = Field(
        default="pass_through", alias="LLM_ABSTAIN_FAIL_MODE"
    )
    llm_escalate_fail_mode: Literal["veto", "pass_through"] = Field(
        default="veto", alias="LLM_ESCALATE_FAIL_MODE"
    )
    llm_quality_fail_mode: Literal["veto", "pass_through"] = Field(
        default="veto", alias="LLM_QUALITY_FAIL_MODE"
    )
    llm_adjustment_allowed: bool = Field(default=False, alias="LLM_ADJUSTMENT_ALLOWED")
    llm_max_qty_multiplier: float = Field(default=1.25, alias="LLM_MAX_QTY_MULTIPLIER")
    llm_min_qty_multiplier: float = Field(default=0.5, alias="LLM_MIN_QTY_MULTIPLIER")
    llm_shadow_mode: bool = Field(default=False, alias="LLM_SHADOW_MODE")
    llm_rollout_stage: Literal[
        "stage0",
        "stage1",
        "stage2",
        "stage3",
        "stage0_baseline",
        "stage1_shadow_pilot",
        "stage2_paper_advisory",
        "stage3_controlled_live",
    ] = Field(default="stage3", alias="LLM_ROLLOUT_STAGE")
    llm_recent_decisions: int = Field(default=5, alias="LLM_RECENT_DECISIONS")
    llm_circuit_max_errors: int = Field(default=3, alias="LLM_CIRCUIT_MAX_ERRORS")
    llm_circuit_window_seconds: int = Field(
        default=300, alias="LLM_CIRCUIT_WINDOW_SECONDS"
    )
    llm_circuit_cooldown_seconds: int = Field(
        default=600, alias="LLM_CIRCUIT_COOLDOWN_SECONDS"
    )
    llm_token_budget_max: int = Field(default=1200, alias="LLM_TOKEN_BUDGET_MAX")
    llm_allowed_prompt_versions_raw: Optional[str] = Field(
        default=None, alias="LLM_ALLOWED_PROMPT_VERSIONS"
    )
    llm_allowed_models_raw: Optional[str] = Field(
        default=None, alias="LLM_ALLOWED_MODELS"
    )
    llm_evaluation_report: Optional[str] = Field(
        default=None, alias="LLM_EVALUATION_REPORT"
    )
    llm_effective_challenge_id: Optional[str] = Field(
        default=None, alias="LLM_EFFECTIVE_CHALLENGE_ID"
    )
    llm_shadow_completed_at: Optional[str] = Field(
        default=None, alias="LLM_SHADOW_COMPLETED_AT"
    )
    llm_model_version_lock: Optional[str] = Field(
        default=None, alias="LLM_MODEL_VERSION_LOCK"
    )
    llm_adjustment_approved: bool = Field(
        default=False, alias="LLM_ADJUSTMENT_APPROVED"
    )
    llm_committee_enabled: bool = Field(default=True, alias="LLM_COMMITTEE_ENABLED")
    llm_committee_roles_raw: str = Field(
        default="researcher,risk_critic,execution_critic,policy_judge",
        alias="LLM_COMMITTEE_ROLES",
    )
    llm_committee_mandatory_roles_raw: str = Field(
        default="risk_critic,execution_critic,policy_judge",
        alias="LLM_COMMITTEE_MANDATORY_ROLES",
    )
    llm_committee_fail_closed_verdict: Literal["veto", "abstain"] = Field(
        default="veto",
        alias="LLM_COMMITTEE_FAIL_CLOSED_VERDICT",
    )
    # Runtime mode controls whether DSPy is used for review and what fallback contract applies.
    llm_dspy_runtime_mode: Literal["disabled", "shadow", "active"] = Field(
        default="disabled",
        alias="LLM_DSPY_RUNTIME_MODE",
    )
    llm_dspy_artifact_hash: Optional[str] = Field(
        default=None,
        alias="LLM_DSPY_ARTIFACT_HASH",
    )
    llm_dspy_program_name: str = Field(
        default="trade-review-committee-v1",
        alias="LLM_DSPY_PROGRAM_NAME",
    )
    llm_dspy_signature_version: str = Field(
        default="v1",
        alias="LLM_DSPY_SIGNATURE_VERSION",
    )
    llm_dspy_timeout_seconds: int = Field(
        default=8,
        alias="LLM_DSPY_TIMEOUT_SECONDS",
    )
    llm_dspy_live_runtime_block_fail_mode: Literal[
        "veto", "pass_through", "pass_through_reduced_size"
    ] = Field(
        default="veto",
        alias="LLM_DSPY_LIVE_RUNTIME_BLOCK_FAIL_MODE",
    )
    llm_dspy_live_runtime_block_qty_multiplier: float = Field(
        default=0.5,
        alias="LLM_DSPY_LIVE_RUNTIME_BLOCK_QTY_MULTIPLIER",
    )
    llm_dspy_runtime_fallback_alert_ratio: float = Field(
        default=0.01,
        alias="LLM_DSPY_RUNTIME_FALLBACK_ALERT_RATIO",
    )
    llm_dspy_compile_metrics_policy_ref: str = Field(
        default="config/trading/llm/dspy-metrics.yaml",
        alias="LLM_DSPY_COMPILE_METRICS_POLICY_REF",
    )
    llm_dspy_secret_binding_ref: str = Field(
        default="codex-github-token",
        alias="LLM_DSPY_SECRET_BINDING_REF",
    )
    llm_dspy_agentrun_ttl_seconds: int = Field(
        default=14400,
        alias="LLM_DSPY_AGENTRUN_TTL_SECONDS",
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    def _apply_feature_flag_overrides(self) -> None:
        if not self.trading_feature_flags_enabled:
            return
        if not self.trading_feature_flags_url:
            return

        endpoint = self.trading_feature_flags_url.strip().rstrip("/")
        if not endpoint:
            return
        namespace_key = self.trading_feature_flags_namespace.strip()
        if not namespace_key:
            return
        entity_id = self.trading_feature_flags_entity_id.strip()
        if not entity_id:
            return

        self.trading_feature_flags_url = endpoint
        self.trading_feature_flags_namespace = namespace_key
        self.trading_feature_flags_entity_id = entity_id
        for field_name, flag_key in FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD.items():
            default_value = bool(getattr(self, field_name))
            resolved, success = _resolve_boolean_feature_flag(
                endpoint=endpoint,
                namespace_key=namespace_key,
                entity_id=entity_id,
                flag_key=flag_key,
                default_value=default_value,
                timeout_ms=self.trading_feature_flags_timeout_ms,
            )
            setattr(self, field_name, resolved)
            if not success:
                logger.warning(
                    "Feature flag endpoint unavailable; skipping remaining overrides after key=%s.",
                    flag_key,
                )
                break

    @staticmethod
    def _normalize_csv_setting(raw: str) -> str:
        return ",".join([item.strip() for item in raw.split(",") if item.strip()])

    @staticmethod
    def _validate_non_negative_value(value: float, message: str) -> None:
        if value < 0:
            raise ValueError(message)

    @staticmethod
    def _validate_non_negative_map_values(
        name: str,
        values: dict[str, float],
    ) -> None:
        for key, value in values.items():
            if value < 0:
                raise ValueError(f"{name}[{key}] must be >= 0")

    def _apply_trading_defaults(self) -> None:
        mode_explicit = "trading_mode" in self.model_fields_set
        deprecated_live_explicit = "trading_live_enabled" in self.model_fields_set
        if not mode_explicit and deprecated_live_explicit:
            self.trading_mode = "live" if self.trading_live_enabled else "paper"
        elif (
            mode_explicit
            and deprecated_live_explicit
            and self.trading_live_enabled != (self.trading_mode == "live")
        ):
            logger.warning(
                "Ignoring deprecated TRADING_LIVE_ENABLED because TRADING_MODE is set."
            )
        self.trading_live_enabled = self.trading_mode == "live"

        crypto_explicit = "trading_crypto_enabled" in self.model_fields_set
        deprecated_ws_explicit = "trading_ws_crypto_enabled" in self.model_fields_set
        deprecated_universe_explicit = (
            "trading_universe_crypto_enabled" in self.model_fields_set
        )
        if not crypto_explicit and (
            deprecated_ws_explicit or deprecated_universe_explicit
        ):
            ws_enabled = (
                self.trading_ws_crypto_enabled if deprecated_ws_explicit else True
            )
            universe_enabled = (
                self.trading_universe_crypto_enabled
                if deprecated_universe_explicit
                else True
            )
            self.trading_crypto_enabled = bool(ws_enabled and universe_enabled)
        elif crypto_explicit and (
            (
                deprecated_ws_explicit
                and self.trading_ws_crypto_enabled != self.trading_crypto_enabled
            )
            or (
                deprecated_universe_explicit
                and self.trading_universe_crypto_enabled != self.trading_crypto_enabled
            )
        ):
            logger.warning(
                "Ignoring deprecated TRADING_WS_CRYPTO_ENABLED/TRADING_UNIVERSE_CRYPTO_ENABLED "
                "because TRADING_CRYPTO_ENABLED is set."
            )
        self.trading_ws_crypto_enabled = self.trading_crypto_enabled
        self.trading_universe_crypto_enabled = self.trading_crypto_enabled

        if "trading_account_label" not in self.model_fields_set:
            self.trading_account_label = self.trading_mode

    def _normalize_optional_url_settings(self) -> None:
        for field_name in (
            "jangar_base_url",
            "trading_jangar_control_plane_status_url",
            "trading_market_context_url",
            "trading_lean_runner_url",
            "trading_forecast_service_url",
            "trading_forecast_router_provider_url",
            "trading_forecast_registry_manifest_url",
            "trading_lean_backtest_upstream_url",
            "trading_lean_shadow_upstream_url",
            "trading_lean_strategy_shadow_upstream_url",
            "posthog_host",
        ):
            raw_value = cast(str | None, getattr(self, field_name))
            if not raw_value:
                continue
            setattr(self, field_name, raw_value.strip().rstrip("/"))

    def _normalize_optional_nullable_settings(self) -> None:
        for field_name in (
            "trading_order_feed_topic_v2",
            "trading_order_feed_security_protocol",
            "trading_order_feed_sasl_mechanism",
            "trading_order_feed_sasl_username",
            "trading_order_feed_sasl_password",
            "trading_accounts_json",
            "trading_autonomy_approval_token",
            "trading_forecast_service_api_key",
            "trading_forecast_router_provider_api_key",
            "trading_forecast_registry_manifest_path",
            "trading_simulation_run_id",
            "trading_simulation_dataset_id",
            "trading_simulation_order_updates_bootstrap_servers",
            "trading_simulation_order_updates_security_protocol",
            "trading_simulation_order_updates_sasl_mechanism",
            "trading_simulation_order_updates_sasl_username",
            "trading_simulation_order_updates_sasl_password",
            "trading_empirical_benchmark_parity_report_path",
            "trading_empirical_foundation_router_parity_report_path",
            "trading_empirical_deeplob_bdlob_report_path",
            "trading_empirical_advisor_fallback_slo_report_path",
            "trading_empirical_janus_event_car_path",
            "trading_empirical_janus_hgrm_reward_path",
            "posthog_api_key",
            "posthog_project_id",
        ):
            raw_value = cast(str | None, getattr(self, field_name))
            if not raw_value:
                continue
            normalized_value = raw_value.strip()
            setattr(self, field_name, normalized_value or None)

        self.posthog_distinct_id = self.posthog_distinct_id.strip() or "torghut-service"
        if self.trading_hypothesis_registry_path is not None:
            self.trading_hypothesis_registry_path = (
                self.trading_hypothesis_registry_path.strip() or None
            )
        if self.trading_forecast_router_policy_path is not None:
            self.trading_forecast_router_policy_path = (
                self.trading_forecast_router_policy_path.strip() or None
            )
        if self.trading_forecast_service_url and not self.trading_forecast_router_provider_url:
            self.trading_forecast_router_provider_url = self.trading_forecast_service_url
        if (
            self.trading_forecast_service_api_key
            and not self.trading_forecast_router_provider_api_key
        ):
            self.trading_forecast_router_provider_api_key = (
                self.trading_forecast_service_api_key
            )

    def _normalize_trading_csv_settings(self) -> None:
        for field_name in (
            "trading_execution_adapter_symbols_raw",
            "trading_forecast_service_allowed_model_families_raw",
            "trading_lean_live_canary_symbols_raw",
            "trading_signal_allowed_sources_raw",
            "trading_signal_staleness_alert_critical_reasons_raw",
            "trading_signal_market_closed_expected_reasons_raw",
            "trading_drift_trigger_retrain_reason_codes_raw",
            "trading_drift_trigger_reselection_reason_codes_raw",
            "trading_drift_rollback_reason_codes_raw",
        ):
            raw_value = cast(str | None, getattr(self, field_name))
            if not raw_value:
                continue
            setattr(self, field_name, self._normalize_csv_setting(raw_value))

    def _normalize_llm_settings(self) -> None:
        if self.llm_allowed_models_raw:
            self.llm_allowed_models_raw = self._normalize_csv_setting(
                self.llm_allowed_models_raw
            )
        if self.llm_allowed_prompt_versions_raw:
            self.llm_allowed_prompt_versions_raw = self._normalize_csv_setting(
                self.llm_allowed_prompt_versions_raw
            )
        for field_name in (
            "llm_evaluation_report",
            "llm_effective_challenge_id",
            "llm_shadow_completed_at",
            "llm_dspy_artifact_hash",
        ):
            raw_value = cast(str | None, getattr(self, field_name))
            if not raw_value:
                continue
            normalized = raw_value.strip()
            setattr(self, field_name, normalized or None)
        if self.llm_model_version_lock is not None:
            normalized_model_version_lock = self.llm_model_version_lock.strip()
            # Model lock evidence must be explicitly configured; never backfill from llm_model.
            self.llm_model_version_lock = normalized_model_version_lock or None
        self.llm_dspy_program_name = self.llm_dspy_program_name.strip()
        self.llm_dspy_signature_version = self.llm_dspy_signature_version.strip()
        self.llm_dspy_compile_metrics_policy_ref = (
            self.llm_dspy_compile_metrics_policy_ref.strip()
        )
        self.llm_dspy_secret_binding_ref = self.llm_dspy_secret_binding_ref.strip()
        self.llm_committee_roles_raw = self._normalize_csv_setting(
            self.llm_committee_roles_raw
        )
        self.llm_committee_mandatory_roles_raw = self._normalize_csv_setting(
            self.llm_committee_mandatory_roles_raw
        )

    def _normalize_strategy_notional_caps(self) -> None:
        normalized_strategy_caps: dict[str, float] = {}
        for key, value in self.trading_allocator_strategy_notional_caps.items():
            normalized_key = key.strip()
            if not normalized_key:
                continue
            if value < 0:
                raise ValueError(
                    f"TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS[{key}] must be >= 0"
                )
            normalized_strategy_caps[normalized_key] = value
        self.trading_allocator_strategy_notional_caps = normalized_strategy_caps

    def _normalize_symbol_notional_caps(self) -> None:
        normalized_symbol_caps: dict[str, float] = {}
        for key, value in self.trading_allocator_symbol_notional_caps.items():
            normalized_key = key.strip().upper()
            if not normalized_key:
                continue
            if value < 0:
                raise ValueError(
                    f"TRADING_ALLOCATOR_SYMBOL_NOTIONAL_CAPS[{key}] must be >= 0"
                )
            normalized_symbol_caps[normalized_key] = value
        self.trading_allocator_symbol_notional_caps = normalized_symbol_caps

    def _normalize_correlation_symbol_groups(self) -> None:
        normalized_correlation_groups: dict[str, str] = {}
        for key, value in self.trading_allocator_symbol_correlation_groups.items():
            normalized_key = key.strip().upper()
            normalized_value = str(value).strip().lower()
            if not normalized_key or not normalized_value:
                continue
            normalized_correlation_groups[normalized_key] = normalized_value
        self.trading_allocator_symbol_correlation_groups = normalized_correlation_groups

    def _normalize_correlation_group_notional_caps(self) -> None:
        normalized_correlation_caps: dict[str, float] = {}
        for (
            key,
            value,
        ) in self.trading_allocator_correlation_group_caps.items():
            normalized_key = key.strip().lower()
            if not normalized_key:
                continue
            if value < 0:
                raise ValueError(
                    f"TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS[{key}] must be >= 0"
                )
            normalized_correlation_caps[normalized_key] = value
        self.trading_allocator_correlation_group_caps = normalized_correlation_caps

    @staticmethod
    def _normalize_allocator_alias_payload(
        raw: str,
        *,
        mode: str,
    ) -> dict[str, str | float]:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError("allocator alias payload must be valid JSON") from exc
        if not isinstance(parsed, dict):
            raise ValueError("allocator alias payload must be a JSON object")

        parsed_map = cast(dict[object, object], parsed)

        if mode == "correlation_symbol_groups":
            normalized: dict[str, str | float] = {}
            for key, value in parsed_map.items():
                normalized_key = str(key).strip().upper()
                normalized_value = str(value).strip().lower()
                if not normalized_key or not normalized_value:
                    continue
                normalized[normalized_key] = normalized_value
            return normalized

        if mode == "correlation_group_caps":
            normalized: dict[str, str | float] = {}
            for key, value in parsed_map.items():
                normalized_key = str(key).strip().lower()
                if not normalized_key:
                    continue
                normalized[normalized_key] = float(str(value))
            return normalized

        raise ValueError(f"unknown allocator alias normalization mode: {mode}")

    def _validate_allocator_alias_environment_parity(self) -> None:
        alias_pairs: tuple[tuple[str, str, str], ...] = (
            (
                "TRADING_ALLOCATOR_SYMBOL_CORRELATION_GROUPS",
                "TRADING_ALLOCATOR_CORRELATION_SYMBOL_GROUPS",
                "correlation_symbol_groups",
            ),
            (
                "TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS",
                "TRADING_ALLOCATOR_CORRELATION_GROUP_NOTIONAL_CAPS",
                "correlation_group_caps",
            ),
        )
        for canonical_env, legacy_env, mode in alias_pairs:
            canonical_raw = os.environ.get(canonical_env)
            legacy_raw = os.environ.get(legacy_env)
            if canonical_raw is None or legacy_raw is None:
                continue
            canonical = self._normalize_allocator_alias_payload(
                canonical_raw, mode=mode
            )
            legacy = self._normalize_allocator_alias_payload(legacy_raw, mode=mode)
            if canonical != legacy:
                raise ValueError(
                    f"{canonical_env} and {legacy_env} differ; set only one canonical form"
                )

    def _normalize_runtime_regime_confidence_thresholds_by_entropy_band(self) -> None:
        normalized: dict[str, tuple[float, float]] = {}
        for (
            key,
            thresholds,
        ) in self.trading_runtime_regime_confidence_thresholds_by_entropy_band.items():
            normalized_key = str(key).strip().lower()
            if not normalized_key:
                continue
            normalized[normalized_key] = (float(thresholds[0]), float(thresholds[1]))
        self.trading_runtime_regime_confidence_thresholds_by_entropy_band = normalized

    @staticmethod
    def _normalize_regime_keyed_float_map(values: dict[str, float]) -> dict[str, float]:
        normalized: dict[str, float] = {}
        for key, value in values.items():
            normalized_key = str(key).strip().lower()
            if not normalized_key:
                continue
            normalized[normalized_key] = value
        return normalized

    def _normalize_runtime_uncertainty_degrade_maps(self) -> None:
        self.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime = (
            self._normalize_regime_keyed_float_map(
                self.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime
            )
        )
        self.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime = self._normalize_regime_keyed_float_map(
            self.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime
        )
        raw_execution = self._normalize_regime_keyed_float_map(
            self.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime
        )
        normalized_execution: dict[str, float] = {}
        for key, value in raw_execution.items():
            if isinstance(value, bool):
                raise ValueError(
                    "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME"
                    f"[{key}] must be an integer"
                )
            if value < 0:
                raise ValueError(
                    "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME"
                    f"[{key}] must be >= 0"
                )
            execution_seconds = int(value)
            if execution_seconds != value:
                raise ValueError(
                    "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME"
                    f"[{key}] must be an integer"
                )
            normalized_execution[key] = execution_seconds
        self.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime = (
            normalized_execution
        )

    def _normalize_allocator_settings(self) -> None:
        self.trading_allocator_default_regime = (
            self.trading_allocator_default_regime.strip() or "neutral"
        )
        self._normalize_strategy_notional_caps()
        self._normalize_symbol_notional_caps()
        self._normalize_correlation_symbol_groups()
        self._normalize_correlation_group_notional_caps()

    def _validate_trading_source_settings(self) -> None:
        if (
            self.trading_enabled
            or self.trading_autonomy_enabled
            or self.trading_mode == "live"
        ) and self.trading_universe_source != "jangar":
            raise ValueError(
                "TRADING_UNIVERSE_SOURCE must be 'jangar' when trading or autonomy is enabled"
            )

    def _validate_allocator_scalar_settings(self) -> None:
        checks: list[tuple[float, str]] = [
            (
                self.trading_allocator_default_budget_multiplier,
                "TRADING_ALLOCATOR_DEFAULT_BUDGET_MULTIPLIER must be >= 0",
            ),
            (
                self.trading_allocator_default_capacity_multiplier,
                "TRADING_ALLOCATOR_DEFAULT_CAPACITY_MULTIPLIER must be >= 0",
            ),
            (
                self.trading_drift_max_required_null_rate,
                "TRADING_DRIFT_MAX_REQUIRED_NULL_RATE must be >= 0",
            ),
            (
                self.trading_drift_max_staleness_ms_p95,
                "TRADING_DRIFT_MAX_STALENESS_MS_P95 must be >= 0",
            ),
            (
                self.trading_drift_max_duplicate_ratio,
                "TRADING_DRIFT_MAX_DUPLICATE_RATIO must be >= 0",
            ),
            (
                self.trading_drift_max_schema_mismatch_total,
                "TRADING_DRIFT_MAX_SCHEMA_MISMATCH_TOTAL must be >= 0",
            ),
            (
                self.trading_drift_retrain_cooldown_seconds,
                "TRADING_DRIFT_RETRAIN_COOLDOWN_SECONDS must be >= 0",
            ),
            (
                self.trading_drift_reselection_cooldown_seconds,
                "TRADING_DRIFT_RESELECTION_COOLDOWN_SECONDS must be >= 0",
            ),
            (
                self.trading_drift_live_promotion_max_evidence_age_seconds,
                "TRADING_DRIFT_LIVE_PROMOTION_MAX_EVIDENCE_AGE_SECONDS must be >= 0",
            ),
            (
                self.trading_signal_continuity_recovery_cycles,
                "TRADING_SIGNAL_CONTINUITY_RECOVERY_CYCLES must be >= 0",
            ),
            (
                self.trading_allocator_min_multiplier,
                "TRADING_ALLOCATOR_MIN_MULTIPLIER must be >= 0",
            ),
            (
                self.trading_planned_decision_timeout_seconds,
                "TRADING_PLANNED_DECISION_TIMEOUT_SECONDS must be >= 0",
            ),
            (
                self.trading_readiness_dependency_cache_stale_tolerance_seconds,
                (
                    "TRADING_READINESS_DEPENDENCY_CACHE_STALE_TOLERANCE_SECONDS "
                    "must be >= 0"
                ),
            ),
            (
                self.trading_jangar_control_plane_timeout_seconds,
                "TRADING_JANGAR_CONTROL_PLANE_TIMEOUT_SECONDS must be >= 0",
            ),
            (
                self.trading_jangar_control_plane_cache_ttl_seconds,
                "TRADING_JANGAR_CONTROL_PLANE_CACHE_TTL_SECONDS must be >= 0",
            ),
        ]
        for value, message in checks:
            self._validate_non_negative_value(value, message)
        if (
            self.trading_allocator_max_multiplier
            < self.trading_allocator_min_multiplier
        ):
            raise ValueError(
                "TRADING_ALLOCATOR_MAX_MULTIPLIER must be >= TRADING_ALLOCATOR_MIN_MULTIPLIER"
            )
        if not (0 <= self.trading_allocator_regime_low_confidence_threshold <= 1):
            raise ValueError(
                "TRADING_ALLOCATOR_REGIME_LOW_CONFIDENCE_THRESHOLD must be within [0, 1]"
            )
        if not (0 <= self.trading_allocator_regime_low_confidence_multiplier <= 1):
            raise ValueError(
                "TRADING_ALLOCATOR_REGIME_LOW_CONFIDENCE_MULTIPLIER must be within [0, 1]"
            )

    def _validate_allocator_map_settings(self) -> None:
        for name, values in (
            (
                "TRADING_ALLOCATOR_REGIME_CAPACITY_MULTIPLIERS",
                self.trading_allocator_regime_capacity_multipliers,
            ),
            (
                "TRADING_ALLOCATOR_STRATEGY_NOTIONAL_CAPS",
                self.trading_allocator_strategy_notional_caps,
            ),
            (
                "TRADING_ALLOCATOR_SYMBOL_NOTIONAL_CAPS",
                self.trading_allocator_symbol_notional_caps,
            ),
            (
                "TRADING_ALLOCATOR_CORRELATION_GROUP_CAPS",
                self.trading_allocator_correlation_group_caps,
            ),
        ):
            self._validate_non_negative_map_values(name, values)

    def _validate_runtime_uncertainty_degrade_map_settings(self) -> None:
        self._validate_non_negative_map_values(
            "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIERS_BY_REGIME",
            self.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
        )
        self._validate_non_negative_map_values(
            "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE_BY_REGIME",
            self.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime,
        )
        for name, values in (
            (
                "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_QTY_MULTIPLIERS_BY_REGIME",
                self.trading_runtime_uncertainty_degrade_qty_multipliers_by_regime,
            ),
            (
                "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MAX_PARTICIPATION_RATE_BY_REGIME",
                self.trading_runtime_uncertainty_degrade_max_participation_rate_by_regime,
            ),
        ):
            for key, value in values.items():
                if value > 1:
                    raise ValueError(f"{name}[{key}] must be <= 1")
        for (
            key,
            value,
        ) in self.trading_runtime_uncertainty_degrade_min_execution_seconds_by_regime.items():
            if value < 0:
                raise ValueError(
                    "TRADING_RUNTIME_UNCERTAINTY_DEGRADE_MIN_EXECUTION_SECONDS_BY_REGIME"
                    f"[{key}] must be >= 0"
                )

    def _validate_runtime_regime_confidence_thresholds_by_entropy_band(self) -> None:
        for (
            entropy_band,
            thresholds,
        ) in self.trading_runtime_regime_confidence_thresholds_by_entropy_band.items():
            if len(thresholds) != 2:
                raise ValueError(
                    "TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND"
                    f"[{entropy_band}] must contain exactly two values"
                )
            degrade_threshold, abstain_threshold = thresholds
            if not (0 <= degrade_threshold <= 1):
                raise ValueError(
                    "TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND"
                    f"[{entropy_band}] degrade_threshold must be within [0, 1]"
                )
            if not (0 <= abstain_threshold <= 1):
                raise ValueError(
                    "TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND"
                    f"[{entropy_band}] abstain_threshold must be within [0, 1]"
                )
            if degrade_threshold < abstain_threshold:
                raise ValueError(
                    "TRADING_RUNTIME_REGIME_CONFIDENCE_THRESHOLDS_BY_ENTROPY_BAND"
                    f"[{entropy_band}] requires degrade_threshold >= abstain_threshold"
                )

    def _validate_fragility_settings(self) -> None:
        if not (
            0 <= self.trading_fragility_elevated_threshold <= 1
            and 0 <= self.trading_fragility_stress_threshold <= 1
            and 0 <= self.trading_fragility_crisis_threshold <= 1
        ):
            raise ValueError(
                "TRADING_FRAGILITY_*_THRESHOLD values must be within [0, 1]"
            )
        if not (
            self.trading_fragility_elevated_threshold
            <= self.trading_fragility_stress_threshold
            <= self.trading_fragility_crisis_threshold
        ):
            raise ValueError(
                "TRADING_FRAGILITY thresholds must satisfy elevated <= stress <= crisis"
            )
        _validate_fragility_map(
            "TRADING_FRAGILITY_STATE_BUDGET_MULTIPLIERS",
            self.trading_fragility_state_budget_multipliers,
        )
        _validate_fragility_map(
            "TRADING_FRAGILITY_STATE_CAPACITY_MULTIPLIERS",
            self.trading_fragility_state_capacity_multipliers,
        )
        _validate_fragility_map(
            "TRADING_FRAGILITY_STATE_PARTICIPATION_CLAMPS",
            self.trading_fragility_state_participation_clamps,
        )
        _validate_fragility_map(
            "TRADING_FRAGILITY_STATE_ABSTAIN_BIAS",
            self.trading_fragility_state_abstain_bias,
        )
        self.trading_allocator_symbol_correlation_groups = {
            str(key).strip().upper(): str(value).strip().lower()
            for key, value in self.trading_allocator_symbol_correlation_groups.items()
            if str(key).strip() and str(value).strip()
        }

    def _validate_llm_settings(self) -> None:
        if (
            self.llm_fail_mode_enforcement == "strict_veto"
            and self.llm_fail_mode != "veto"
        ):
            raise ValueError(
                "LLM_FAIL_MODE must be 'veto' when LLM_FAIL_MODE_ENFORCEMENT=strict_veto"
            )
        interval_checks: list[tuple[float, str]] = [
            (self.llm_min_confidence, "LLM_MIN_CONFIDENCE must be within [0, 1]"),
            (
                self.llm_min_calibrated_top_probability,
                "LLM_MIN_CALIBRATED_TOP_PROBABILITY must be within [0, 1]",
            ),
            (
                self.llm_min_probability_margin,
                "LLM_MIN_PROBABILITY_MARGIN must be within [0, 1]",
            ),
            (self.llm_max_uncertainty, "LLM_MAX_UNCERTAINTY must be within [0, 1]"),
            (
                self.llm_min_calibration_quality_score,
                "LLM_MIN_CALIBRATION_QUALITY_SCORE must be within [0, 1]",
            ),
            (
                self.trading_lean_live_canary_fallback_ratio_limit,
                "TRADING_LEAN_LIVE_CANARY_FALLBACK_RATIO_LIMIT must be within [0, 1]",
            ),
        ]
        for value, message in interval_checks:
            if not 0 <= value <= 1:
                raise ValueError(message)
        if self.llm_live_fail_open_requested and not self.llm_fail_open_live_approved:
            raise ValueError(
                "LLM_FAIL_OPEN_LIVE_APPROVED must be true when live effective fail mode is pass_through"
            )
        if self.llm_dspy_timeout_seconds <= 0:
            raise ValueError("LLM_DSPY_TIMEOUT_SECONDS must be > 0")
        if self.llm_dspy_agentrun_ttl_seconds < 0:
            raise ValueError("LLM_DSPY_AGENTRUN_TTL_SECONDS must be >= 0")
        if not 0 < self.llm_dspy_live_runtime_block_qty_multiplier <= 1:
            raise ValueError(
                "LLM_DSPY_LIVE_RUNTIME_BLOCK_QTY_MULTIPLIER must be within (0, 1]"
            )
        if (
            self.llm_dspy_runtime_mode in {"shadow", "active"}
            and not self.llm_dspy_artifact_hash
        ):
            raise ValueError(
                "LLM_DSPY_ARTIFACT_HASH is required when LLM_DSPY_RUNTIME_MODE is shadow or active"
            )
        if not self.llm_dspy_program_name:
            raise ValueError("LLM_DSPY_PROGRAM_NAME must be set")
        if not self.llm_dspy_signature_version:
            raise ValueError("LLM_DSPY_SIGNATURE_VERSION must be set")

    def _validate_posthog_settings(self) -> None:
        if self.posthog_timeout_seconds <= 0:
            raise ValueError("POSTHOG_TIMEOUT_SECONDS must be > 0")
        if not self.posthog_enabled:
            return
        if not self.posthog_host:
            raise ValueError("POSTHOG_HOST is required when POSTHOG_ENABLED=true")
        parsed = urlsplit(self.posthog_host)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise ValueError("POSTHOG_HOST must be a valid http(s) URL")
        if not self.posthog_api_key:
            raise ValueError("POSTHOG_API_KEY is required when POSTHOG_ENABLED=true")

    def model_post_init(self, __context: Any) -> None:
        if not os.getenv("LOG_FORMAT"):
            self.log_format = "json" if self.app_env in {"stage", "prod"} else "text"
        if not os.getenv("LOG_LEVEL"):
            self.log_level = "INFO"
        self._validate_allocator_alias_environment_parity()
        self._apply_feature_flag_overrides()
        self._apply_trading_defaults()
        self._normalize_optional_url_settings()
        self._normalize_optional_nullable_settings()
        self._normalize_trading_csv_settings()
        self._validate_trading_source_settings()
        self._normalize_llm_settings()
        self._validate_allocator_scalar_settings()
        self._validate_non_negative_map_values(
            "TRADING_ALLOCATOR_REGIME_BUDGET_MULTIPLIERS",
            self.trading_allocator_regime_budget_multipliers,
        )
        self._normalize_allocator_settings()
        self._normalize_runtime_regime_confidence_thresholds_by_entropy_band()
        self._normalize_runtime_uncertainty_degrade_maps()
        self._validate_allocator_map_settings()
        self._validate_runtime_uncertainty_degrade_map_settings()
        self._validate_runtime_regime_confidence_thresholds_by_entropy_band()
        self._validate_fragility_settings()
        self._validate_llm_settings()
        self._validate_posthog_settings()

    @property
    def sqlalchemy_dsn(self) -> str:
        """Return a SQLAlchemy-friendly DSN, normalizing postgres URIs to psycopg."""

        if self.db_dsn.startswith("postgresql+psycopg://"):
            return self.db_dsn

        if self.db_dsn.startswith("postgres://"):
            return self.db_dsn.replace("postgres://", "postgresql+psycopg://", 1)

        if self.db_dsn.startswith("postgresql://"):
            return self.db_dsn.replace("postgresql://", "postgresql+psycopg://", 1)

        return self.db_dsn

    @property
    def trading_static_symbols(self) -> List[str]:
        if not self.trading_static_symbols_raw:
            return []
        return [
            symbol.strip()
            for symbol in self.trading_static_symbols_raw.split(",")
            if symbol.strip()
        ]

    @property
    def trading_universe_static_fallback_symbols(self) -> list[str]:
        if self.trading_universe_static_fallback_symbols_raw:
            return [
                symbol.strip()
                for symbol in self.trading_universe_static_fallback_symbols_raw.split(
                    ","
                )
                if symbol.strip()
            ]
        return self.trading_static_symbols

    @property
    def trading_execution_adapter_symbols(self) -> set[str]:
        if not self.trading_execution_adapter_symbols_raw:
            return set()
        return {
            symbol.strip()
            for symbol in self.trading_execution_adapter_symbols_raw.split(",")
            if symbol.strip()
        }

    @property
    def trading_forecast_service_allowed_model_families(self) -> set[str]:
        if not self.trading_forecast_service_allowed_model_families_raw:
            return {"chronos", "moment", "financial_tsfm"}
        return {
            family.strip().lower().replace("-", "_")
            for family in self.trading_forecast_service_allowed_model_families_raw.split(
                ","
            )
            if family.strip()
        }

    @property
    def trading_order_feed_topics(self) -> list[str]:
        topics: list[str] = []
        primary = self.trading_order_feed_topic.strip()
        if primary:
            topics.append(primary)
        if self.trading_order_feed_topic_v2:
            v2 = self.trading_order_feed_topic_v2.strip()
            if v2 and v2 not in topics:
                topics.insert(0, v2)
        return topics

    @property
    def trading_order_feed_bootstrap_server_list(self) -> list[str]:
        raw = self.trading_order_feed_bootstrap_servers or ""
        return [item.strip() for item in raw.split(",") if item.strip()]

    @property
    def trading_order_feed_kafka_security_kwargs(self) -> dict[str, str]:
        kwargs: dict[str, str] = {}
        if self.trading_order_feed_security_protocol:
            kwargs["security_protocol"] = self.trading_order_feed_security_protocol
        if self.trading_order_feed_sasl_mechanism:
            kwargs["sasl_mechanism"] = self.trading_order_feed_sasl_mechanism
        if self.trading_order_feed_sasl_username:
            kwargs["sasl_plain_username"] = self.trading_order_feed_sasl_username
        if self.trading_order_feed_sasl_password:
            kwargs["sasl_plain_password"] = self.trading_order_feed_sasl_password
        return kwargs

    @property
    def trading_simulation_order_updates_bootstrap_server_list(self) -> list[str]:
        raw = (
            self.trading_simulation_order_updates_bootstrap_servers
            or self.trading_order_feed_bootstrap_servers
            or ""
        )
        return [item.strip() for item in raw.split(",") if item.strip()]

    @property
    def trading_simulation_order_updates_kafka_security_kwargs(self) -> dict[str, str]:
        kwargs: dict[str, str] = {}
        security_protocol = (
            self.trading_simulation_order_updates_security_protocol
            or self.trading_order_feed_security_protocol
        )
        sasl_mechanism = (
            self.trading_simulation_order_updates_sasl_mechanism
            or self.trading_order_feed_sasl_mechanism
        )
        sasl_username = (
            self.trading_simulation_order_updates_sasl_username
            or self.trading_order_feed_sasl_username
        )
        sasl_password = (
            self.trading_simulation_order_updates_sasl_password
            or self.trading_order_feed_sasl_password
        )
        if security_protocol:
            kwargs["security_protocol"] = security_protocol
        if sasl_mechanism:
            kwargs["sasl_mechanism"] = sasl_mechanism
        if sasl_username:
            kwargs["sasl_plain_username"] = sasl_username
        if sasl_password:
            kwargs["sasl_plain_password"] = sasl_password
        return kwargs

    @property
    def trading_accounts(self) -> list[TradingAccountLane]:
        fallback = TradingAccountLane(
            label=self.trading_account_label,
            mode=self.trading_mode,
            api_key=self.apca_api_key_id,
            secret_key=self.apca_api_secret_key,
            base_url=self.apca_api_base_url,
            enabled=True,
        )
        if not self.trading_multi_account_enabled:
            return [fallback]
        if not self.trading_accounts_json:
            return [fallback]
        try:
            parsed = json.loads(self.trading_accounts_json)
            if isinstance(parsed, dict):
                parsed_map = cast(dict[str, Any], parsed)
                raw_candidates = parsed_map.get("accounts")
            else:
                raw_candidates = parsed
            if not isinstance(raw_candidates, list):
                raise ValueError("accounts registry must be a list")
            lanes = [
                TradingAccountLane.model_validate(cast(dict[str, Any], item))
                for item in cast(list[object], raw_candidates)
                if isinstance(item, dict)
            ]
        except (json.JSONDecodeError, ValidationError, ValueError):
            logger.exception(
                "Invalid TRADING_ACCOUNTS_JSON; falling back to single-account runtime."
            )
            return [fallback]

        enabled_lanes: list[TradingAccountLane] = []
        seen_labels: set[str] = set()
        for lane in lanes:
            if not lane.enabled:
                continue
            resolved_label = lane.label.strip()
            if not resolved_label:
                continue
            if resolved_label in seen_labels:
                logger.warning(
                    "Duplicate TRADING_ACCOUNTS_JSON label dropped label=%s",
                    resolved_label,
                )
                continue
            seen_labels.add(resolved_label)
            enabled_lanes.append(
                lane.model_copy(
                    update={
                        "label": resolved_label,
                        "api_key": lane.api_key or self.apca_api_key_id,
                        "secret_key": lane.secret_key or self.apca_api_secret_key,
                        "base_url": lane.base_url or self.apca_api_base_url,
                    }
                )
            )
        if not enabled_lanes:
            return [fallback]
        return enabled_lanes

    @property
    def trading_lean_live_canary_symbols(self) -> set[str]:
        if not self.trading_lean_live_canary_symbols_raw:
            return set()
        return {
            symbol.strip()
            for symbol in self.trading_lean_live_canary_symbols_raw.split(",")
            if symbol.strip()
        }

    @property
    def trading_signal_staleness_alert_critical_reasons(self) -> set[str]:
        if not self.trading_signal_staleness_alert_critical_reasons_raw:
            return set()
        return {
            reason.strip()
            for reason in self.trading_signal_staleness_alert_critical_reasons_raw.split(
                ","
            )
            if reason.strip()
        }

    @property
    def trading_signal_market_closed_expected_reasons(self) -> set[str]:
        if not self.trading_signal_market_closed_expected_reasons_raw:
            return set()
        return {
            reason.strip()
            for reason in self.trading_signal_market_closed_expected_reasons_raw.split(
                ","
            )
            if reason.strip()
        }

    @property
    def trading_drift_trigger_retrain_reason_codes(self) -> set[str]:
        if not self.trading_drift_trigger_retrain_reason_codes_raw:
            return set()
        return {
            reason.strip()
            for reason in self.trading_drift_trigger_retrain_reason_codes_raw.split(",")
            if reason.strip()
        }

    @property
    def trading_drift_trigger_reselection_reason_codes(self) -> set[str]:
        if not self.trading_drift_trigger_reselection_reason_codes_raw:
            return set()
        return {
            reason.strip()
            for reason in self.trading_drift_trigger_reselection_reason_codes_raw.split(
                ","
            )
            if reason.strip()
        }

    @property
    def trading_drift_rollback_reason_codes(self) -> set[str]:
        if not self.trading_drift_rollback_reason_codes_raw:
            return set()
        return {
            reason.strip()
            for reason in self.trading_drift_rollback_reason_codes_raw.split(",")
            if reason.strip()
        }

    @property
    def llm_allowed_models(self) -> set[str]:
        if not self.llm_allowed_models_raw:
            return set()
        return {
            model.strip()
            for model in self.llm_allowed_models_raw.split(",")
            if model.strip()
        }

    @property
    def llm_allowed_prompt_versions(self) -> set[str]:
        if not self.llm_allowed_prompt_versions_raw:
            return set()
        return {
            version.strip()
            for version in self.llm_allowed_prompt_versions_raw.split(",")
            if version.strip()
        }

    @property
    def llm_policy_exceptions(self) -> list[str]:
        exceptions: list[str] = []
        if self.llm_fail_mode_enforcement == "configured":
            exceptions.append("configured_fail_mode_enabled")
        if self.llm_live_fail_open_requested and self.llm_fail_open_live_approved:
            exceptions.append("live_fail_open_approved")
        return exceptions

    @property
    def llm_committee_roles(self) -> list[str]:
        return [
            item.strip()
            for item in self.llm_committee_roles_raw.split(",")
            if item.strip()
        ]

    @property
    def llm_committee_mandatory_roles(self) -> list[str]:
        return [
            item.strip()
            for item in self.llm_committee_mandatory_roles_raw.split(",")
            if item.strip()
        ]

    def llm_dspy_live_runtime_gate(self) -> tuple[bool, tuple[str, ...]]:
        normalized_stage = self._normalize_rollout_stage(self.llm_rollout_stage)
        reasons: list[str] = []

        if self.trading_mode != "live":
            reasons.append("dspy_live_requires_live_trading_mode")
        if self.llm_dspy_runtime_mode != "active":
            reasons.append("dspy_live_runtime_mode_not_active")
        if normalized_stage != "stage3":
            reasons.append("dspy_live_rollout_stage_not_stage3")
        if not self.jangar_base_url:
            reasons.append("dspy_jangar_base_url_missing")
        else:
            parsed_base_url = urlsplit(self.jangar_base_url)
            normalized_base_path = parsed_base_url.path.rstrip("/")
            if not parsed_base_url.scheme:
                reasons.append("dspy_jangar_base_url_invalid")
            elif parsed_base_url.scheme not in {"http", "https"}:
                reasons.append("dspy_jangar_base_url_invalid")
            elif not parsed_base_url.hostname:
                reasons.append("dspy_jangar_base_url_invalid")
            elif parsed_base_url.query or parsed_base_url.fragment:
                reasons.append("dspy_jangar_base_url_invalid")
            elif normalized_base_path and normalized_base_path not in (
                "/openai/v1",
                "/openai/v1/chat/completions",
            ):
                reasons.append("dspy_jangar_base_url_invalid")

        if not self.llm_dspy_artifact_hash:
            reasons.append("dspy_artifact_hash_missing")
        else:
            normalized_hash = self.llm_dspy_artifact_hash.strip().lower()
            if len(normalized_hash) != 64:
                reasons.append("dspy_artifact_hash_invalid_length")
            elif any(ch not in string.hexdigits for ch in normalized_hash):
                reasons.append("dspy_artifact_hash_not_hex")
            elif (
                normalized_hash == (_dspy_bootstrap_artifact_hash() or "")
                and self.llm_dspy_runtime_mode == "active"
            ):
                reasons.append("dspy_bootstrap_artifact_forbidden")

        if not self.llm_allowed_models:
            reasons.append("llm_model_inventory_missing")
        elif self.llm_model not in self.llm_allowed_models:
            reasons.append("llm_model_not_in_inventory")

        if normalized_stage in {"stage2", "stage3"}:
            if not self.llm_evaluation_report:
                reasons.append("llm_evaluation_report_missing")
            if not self.llm_effective_challenge_id:
                reasons.append("llm_effective_challenge_missing")
            if not self.llm_shadow_completed_at:
                reasons.append("llm_shadow_completion_missing")
            if not self.llm_model_version_lock:
                reasons.append("llm_model_version_lock_missing")
            elif not self._matches_model_version_lock(
                self.llm_model, self.llm_model_version_lock
            ):
                reasons.append("llm_model_version_lock_mismatch")

        if not self.llm_committee_enabled:
            reasons.append("llm_committee_disabled")
        if self.llm_committee_roles and not all(
            role in _LLM_COMMITTEE_ROLES for role in self.llm_committee_roles
        ):
            reasons.append("llm_committee_roles_invalid")
        if self.llm_committee_mandatory_roles and not all(
            role in _LLM_COMMITTEE_ROLES for role in self.llm_committee_mandatory_roles
        ):
            reasons.append("llm_committee_mandatory_roles_invalid")

        migration_allowed, migration_reasons = self.llm_dspy_cutover_migration_guard()
        if not migration_allowed:
            reasons.extend(migration_reasons)

        return (not reasons, tuple(reasons))

    def llm_dspy_cutover_migration_guard(self) -> tuple[bool, tuple[str, ...]]:
        """Reject mixed legacy/DSPy posture when active cutover mode is requested."""

        if self.llm_dspy_runtime_mode != "active":
            return True, ()

        reasons: list[str] = []
        if self.llm_fail_mode_enforcement != "strict_veto":
            reasons.append("dspy_cutover_requires_strict_veto_enforcement")
        if self.llm_fail_mode != "veto":
            reasons.append("dspy_cutover_requires_veto_fail_mode")
        if self.llm_abstain_fail_mode != "veto":
            reasons.append("dspy_cutover_requires_veto_abstain_fail_mode")
        if self.llm_escalate_fail_mode != "veto":
            reasons.append("dspy_cutover_requires_veto_escalate_fail_mode")
        if self.llm_quality_fail_mode != "veto":
            reasons.append("dspy_cutover_requires_veto_quality_fail_mode")
        if self.llm_shadow_mode:
            reasons.append("dspy_cutover_requires_shadow_mode_disabled")

        for exception in self.llm_policy_exceptions:
            reasons.append(f"dspy_cutover_policy_exception_{exception}")

        return (not reasons, tuple(reasons))

    @property
    def llm_dspy_live_runtime_allowed(self) -> bool:
        allowed, _ = self.llm_dspy_live_runtime_gate()
        return allowed

    @property
    def llm_live_fail_open_requested(self) -> bool:
        return self.llm_live_fail_open_requested_for_stage(self.llm_rollout_stage)

    def llm_live_fail_open_requested_for_stage(self, rollout_stage: str) -> bool:
        if self.trading_mode != "live":
            return False
        normalized_stage = self._normalize_rollout_stage(rollout_stage)
        if normalized_stage in {"stage1", "stage2"}:
            return (
                self.llm_effective_fail_mode(rollout_stage=normalized_stage)
                == "pass_through"
            )
        return self.llm_effective_fail_mode() == "pass_through"

    def llm_effective_fail_mode_for_current_rollout(
        self,
    ) -> Literal["veto", "pass_through"]:
        rollout_stage = self._normalize_rollout_stage(self.llm_rollout_stage)
        if rollout_stage in {"stage1", "stage2"}:
            return self.llm_effective_fail_mode(rollout_stage=rollout_stage)
        return self.llm_effective_fail_mode()

    def llm_effective_fail_mode(
        self, *, rollout_stage: Optional[str] = None
    ) -> Literal["veto", "pass_through"]:
        if rollout_stage == "stage1":
            if self.llm_fail_mode_enforcement == "strict_veto":
                return "veto"
            return "pass_through"

        if rollout_stage == "stage2":
            return "pass_through"

        if self.llm_fail_mode_enforcement == "strict_veto":
            return "veto"
        return self.llm_fail_mode

    @staticmethod
    def _normalize_rollout_stage(stage: str) -> str:
        if stage.startswith("stage0"):
            return "stage0"
        if stage.startswith("stage1"):
            return "stage1"
        if stage.startswith("stage2"):
            return "stage2"
        if stage.startswith("stage3"):
            return "stage3"
        return "stage3"

    @staticmethod
    def _matches_model_version_lock(model: str, version_lock: str) -> bool:
        if not version_lock:
            return False
        if model == version_lock:
            return True
        if "@" in version_lock:
            locked_model = version_lock.split("@", 1)[0].strip()
            return bool(locked_model) and model == locked_model
        return False


def _validate_fragility_map(name: str, values: dict[str, float]) -> None:
    for state, value in values.items():
        if value < 0 or value > 1:
            raise ValueError(f"{name}[{state}] must be within [0, 1]")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance so values are loaded once."""

    return Settings()  # type: ignore[call-arg]


settings = get_settings()
