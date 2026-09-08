"""Runtime risk, allocator, readiness, and integration settings."""

from datetime import time
from decimal import Decimal
from typing import Literal, Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class RuntimeRiskSettingsFields(BaseSettings):
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

    trading_pipeline_mode: Literal["simple"] = Field(
        default="simple",
        alias="TRADING_PIPELINE_MODE",
        description="Order-submission pipeline implementation. The simple lane is the only supported path.",
    )

    trading_economic_policy_path: Optional[str] = Field(
        default=None,
        alias="TRADING_ECONOMIC_POLICY_PATH",
        description="Path to the immutable economic policy used by every execution stage.",
    )

    trading_economic_policy_expected_digest: Optional[str] = Field(
        default=None,
        alias="TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST",
        description="Pinned sha256 digest for the configured economic policy.",
    )

    trading_simple_max_order_pct_equity: Optional[float] = Field(
        default=0.50,
        alias="TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY",
        description=(
            "Simple-lane max new-exposure order notional as a fraction of account "
            "equity. Closing or covering quantity is exempt."
        ),
    )

    trading_simple_max_gross_exposure_pct_equity: Optional[float] = Field(
        default=1.0,
        alias="TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY",
        description=(
            "Simple-lane max gross exposure as a fraction of account equity. "
            "Closing or covering quantity is exempt."
        ),
    )

    trading_simple_max_net_exposure_pct_equity: Optional[float] = Field(
        default=0.50,
        alias="TRADING_SIMPLE_MAX_NET_EXPOSURE_PCT_EQUITY",
        description=(
            "Simple-lane maximum absolute net exposure as a fraction of account "
            "equity. Trades that reduce absolute net exposure remain allowed."
        ),
    )

    trading_simple_max_symbol_pct_equity: Optional[float] = Field(
        default=0.50,
        alias="TRADING_SIMPLE_MAX_SYMBOL_PCT_EQUITY",
        description=(
            "Simple-lane maximum absolute exposure per symbol as a fraction of "
            "account equity. Closing or covering quantity is exempt."
        ),
    )

    trading_simple_buying_power_reserve_bps: float = Field(
        default=1000.0,
        alias="TRADING_SIMPLE_BUYING_POWER_RESERVE_BPS",
        description=(
            "Simple-lane buying-power reserve in basis points before quantity "
            "clamping, to avoid broker rejects from quote drift, fees, or cost-basis "
            "rounding."
        ),
    )

    trading_simple_submit_enabled: bool = Field(
        default=False,
        alias="TRADING_SIMPLE_SUBMIT_ENABLED",
        description="Allow the simple lane to submit live broker orders.",
    )

    trading_live_submit_enabled: bool = Field(
        default=False,
        alias="TRADING_LIVE_SUBMIT_ENABLED",
        description=(
            "Explicit operator toggle for live-mode order submission. This replaces "
            "alpha-promotion/source-collection authority as the live submission switch."
        ),
    )

    trading_simple_order_feed_telemetry_enabled: bool = Field(
        default=False,
        alias="TRADING_SIMPLE_ORDER_FEED_TELEMETRY_ENABLED",
        description=(
            "In simple mode, enable Kafka order-feed ingestion for execution "
            "lifecycle telemetry and reconciliation."
        ),
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

    trading_daily_loss_stop_pct_equity: float = Field(
        default=0.01,
        alias="TRADING_DAILY_LOSS_STOP_PCT_EQUITY",
        description="Live account equity loss from the session start that latches a stop.",
    )

    trading_persistent_drawdown_stop_pct_equity: float = Field(
        default=0.05,
        alias="TRADING_PERSISTENT_DRAWDOWN_STOP_PCT_EQUITY",
        description="Live account equity drawdown from its persisted high-water mark.",
    )

    trading_new_exposure_cutoff_time_et: time = Field(
        default=time(hour=15, minute=30),
        alias="TRADING_NEW_EXPOSURE_CUTOFF_TIME_ET",
    )

    trading_flatten_start_time_et: time = Field(
        default=time(hour=15, minute=45),
        alias="TRADING_FLATTEN_START_TIME_ET",
    )

    trading_flat_confirmation_time_et: time = Field(
        default=time(hour=15, minute=50),
        alias="TRADING_FLAT_CONFIRMATION_TIME_ET",
    )

    trading_pair_delta_tolerance_bps: float = Field(
        default=8.0,
        alias="TRADING_PAIR_DELTA_TOLERANCE_BPS",
        description="Maximum notional imbalance accepted after paired execution.",
    )

    trading_closeout_reprice_seconds: float = Field(
        default=2.0,
        alias="TRADING_CLOSEOUT_REPRICE_SECONDS",
    )

    trading_closeout_max_attempts: int = Field(
        default=3,
        alias="TRADING_CLOSEOUT_MAX_ATTEMPTS",
    )

    trading_closeout_slippage_bps: float = Field(
        default=8.0,
        alias="TRADING_CLOSEOUT_SLIPPAGE_BPS",
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

    trading_jangar_quant_health_url: Optional[str] = Field(
        default=None,
        alias="TRADING_JANGAR_QUANT_HEALTH_URL",
        description=(
            "Explicit Jangar quant health endpoint consumed by the shared live submission gate and live/sim lane authority."
        ),
    )

    trading_jangar_quant_health_required: bool = Field(
        default=False,
        alias="TRADING_JANGAR_QUANT_HEALTH_REQUIRED",
        description=(
            "Require the external Jangar quant health endpoint before the live submission gate can pass. "
            "Leave false for Torghut-owned local strategy execution."
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

    trading_jangar_quant_window: Literal["1m", "5m", "15m", "1h", "1d", "5d", "20d"] = (
        Field(
            default="15m",
            alias="TRADING_JANGAR_QUANT_WINDOW",
            description="Quant evaluation window used by the shared live submission gate.",
        )
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

    trading_signal_max_executable_spread_bps: Decimal = Field(
        default=Decimal("50"),
        alias="TRADING_SIGNAL_MAX_EXECUTABLE_SPREAD_BPS",
        description="Reject signals whose executable spread exceeds this bound before strategy evaluation.",
    )

    trading_signal_max_quote_mid_jump_bps: Decimal = Field(
        default=Decimal("150"),
        alias="TRADING_SIGNAL_MAX_QUOTE_MID_JUMP_BPS",
        description="Reject wide-spread signals whose midpoint jumps too far from the last executable quote.",
    )

    trading_signal_max_jump_with_wide_spread_bps: Decimal = Field(
        default=Decimal("25"),
        alias="TRADING_SIGNAL_MAX_JUMP_WITH_WIDE_SPREAD_BPS",
        description="Only apply the midpoint-jump filter when the spread is at least this wide.",
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
        description=("Base backoff in seconds between Alpaca readiness retries."),
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

    # Agents control-plane API for AgentRun submission. JANGAR_* remains a read-only compatibility alias
    # only where older product callers still provide it explicitly.

    agents_base_url: Optional[str] = Field(default=None, alias="AGENTS_BASE_URL")

    agents_api_key: Optional[str] = Field(default=None, alias="AGENTS_API_KEY")

    # Jangar gateway (recommended for LLM calls in-cluster).

    jangar_base_url: Optional[str] = Field(default=None, alias="JANGAR_BASE_URL")

    jangar_api_key: Optional[str] = Field(default=None, alias="JANGAR_API_KEY")

    llm_enabled: bool = Field(default=True, alias="LLM_ENABLED")

    llm_model: str = Field(default="gpt-5.6-sol", alias="LLM_MODEL")

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


__all__ = ["RuntimeRiskSettingsFields"]
