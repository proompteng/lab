"""Autonomy, drift, universe, execution, and simulation settings."""

import tempfile
from pathlib import Path
from typing import Literal, Optional

from pydantic import Field
from pydantic_settings import BaseSettings


class AutonomyExecutionSettingsFields(BaseSettings):
    trading_autonomy_artifact_dir: str = Field(
        default=str(Path(tempfile.gettempdir()) / "torghut-autonomy"),
        alias="TRADING_AUTONOMY_ARTIFACT_DIR",
        description="Output directory for autonomous lane artifacts.",
    )

    trading_autonomy_artifact_retention_runs: int = Field(
        default=288,
        ge=1,
        alias="TRADING_AUTONOMY_ARTIFACT_RETENTION_RUNS",
        description="Maximum number of timestamped autonomy run directories retained on local storage.",
    )

    trading_autonomy_alpha_train_prices_path: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_ALPHA_TRAIN_PRICES_PATH",
        description="Optional CSV path for strategy-factory train prices consumed by autonomous lane runs.",
    )

    trading_autonomy_alpha_test_prices_path: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_ALPHA_TEST_PRICES_PATH",
        description="Optional CSV path for strategy-factory test prices consumed by autonomous lane runs.",
    )

    trading_autonomy_alpha_gate_policy_path: Optional[str] = Field(
        default=None,
        alias="TRADING_AUTONOMY_ALPHA_GATE_POLICY_PATH",
        description="Optional gate-policy JSON path for autonomous strategy-factory sidecar runs.",
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

    trading_universe_symbol_allowlist_raw: Optional[str] = Field(
        default=None,
        alias="TRADING_UNIVERSE_SYMBOL_ALLOWLIST",
        description=(
            "Optional comma-separated symbol allowlist applied to all resolved equity universes. "
            "Configured live/paper deployments use this to prevent broader Jangar feeds from "
            "expanding beyond the researched semiconductor/technology universe."
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

    trading_lean_backtest_upstream_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_BACKTEST_UPSTREAM_URL",
        description="Optional upstream URL for authoritative LEAN backtest submission and polling.",
    )

    trading_lean_strategy_shadow_upstream_url: Optional[str] = Field(
        default=None,
        alias="TRADING_LEAN_STRATEGY_SHADOW_UPSTREAM_URL",
        description="Optional upstream URL for authoritative LEAN strategy shadow evaluation.",
    )

    trading_lean_backtest_enabled: bool = Field(
        default=False,
        alias="TRADING_LEAN_BACKTEST_ENABLED",
        description="Enable asynchronous LEAN backtest lane orchestration.",
    )

    trading_lean_strategy_shadow_enabled: bool = Field(
        default=False,
        alias="TRADING_LEAN_STRATEGY_SHADOW_ENABLED",
        description="Enable LEAN strategy-runtime shadow evaluations without control-plane replacement.",
    )

    trading_lean_lane_disable_switch: bool = Field(
        default=False,
        alias="TRADING_LEAN_LANE_DISABLE_SWITCH",
        description="Emergency hard disable for LEAN multi-lane behavior.",
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


__all__ = ["AutonomyExecutionSettingsFields"]
