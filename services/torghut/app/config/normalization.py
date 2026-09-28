"""Settings normalization and validation mixins."""

from typing import Literal, Optional, cast

from .common import (
    BooleanFeatureFlagRequest,
    FEATURE_FLAG_BOOLEAN_KEY_BY_FIELD,
    logger,
    resolve_boolean_feature_flag,
)
from .autonomy_execution_fields import AutonomyExecutionSettingsFields
from .llm_fields import LlmSettingsFields
from .runtime_risk_fields import RuntimeRiskSettingsFields
from .service_fields import CoreSettingsFields


def validate_fragility_map(name: str, values: dict[str, float]) -> None:
    for state, value in values.items():
        if value < 0 or value > 1:
            raise ValueError(f"{name}[{state}] must be within [0, 1]")


class SettingsNormalizationMixin(
    CoreSettingsFields,
    AutonomyExecutionSettingsFields,
    RuntimeRiskSettingsFields,
    LlmSettingsFields,
):
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
            resolved, success = resolve_boolean_feature_flag(
                BooleanFeatureFlagRequest(
                    endpoint=endpoint,
                    namespace_key=namespace_key,
                    entity_id=entity_id,
                    flag_key=flag_key,
                    default_value=default_value,
                    timeout_ms=self.trading_feature_flags_timeout_ms,
                )
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
    def _validate_non_negative_value(value: float | None, message: str) -> None:
        if value is None:
            return
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
        if "trading_account_label" not in self.model_fields_set:
            self.trading_account_label = self.trading_mode

    def _normalize_optional_url_settings(self) -> None:
        for field_name in (
            "jangar_base_url",
            "trading_jangar_control_plane_status_url",
            "trading_jangar_quant_health_url",
            "trading_market_context_url",
            "trading_forecast_registry_manifest_url",
            "trading_lean_backtest_upstream_url",
            "trading_lean_strategy_shadow_upstream_url",
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
            "trading_economic_policy_path",
            "trading_economic_policy_expected_digest",
            "trading_autonomy_approval_token",
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
        ):
            raw_value = cast(str | None, getattr(self, field_name))
            if not raw_value:
                continue
            normalized_value = raw_value.strip()
            setattr(self, field_name, normalized_value or None)

        policy_path = self.trading_economic_policy_path
        policy_digest = self.trading_economic_policy_expected_digest
        if bool(policy_path) != bool(policy_digest):
            raise ValueError(
                "TRADING_ECONOMIC_POLICY_PATH and TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST "
                "must be configured together"
            )
        if policy_digest is not None:
            normalized_digest = policy_digest.lower()
            prefix, separator, value = normalized_digest.partition(":")
            if (
                separator != ":"
                or prefix != "sha256"
                or len(value) != 64
                or any(character not in "0123456789abcdef" for character in value)
            ):
                raise ValueError(
                    "TRADING_ECONOMIC_POLICY_EXPECTED_DIGEST must use sha256:<64 lowercase hex>"
                )
            self.trading_economic_policy_expected_digest = normalized_digest

        if self.trading_hypothesis_registry_path is not None:
            self.trading_hypothesis_registry_path = (
                self.trading_hypothesis_registry_path.strip() or None
            )
        if self.trading_forecast_router_policy_path is not None:
            self.trading_forecast_router_policy_path = (
                self.trading_forecast_router_policy_path.strip() or None
            )

    def _normalize_trading_csv_settings(self) -> None:
        for field_name in (
            "trading_forecast_service_allowed_model_families_raw",
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
        trading_active = (
            self.trading_enabled
            or self.trading_autonomy_enabled
            or self.trading_mode == "live"
        )
        if not trading_active:
            return
        if self.trading_universe_source in {"jangar", "static"}:
            return
        raise ValueError("TRADING_UNIVERSE_SOURCE must be 'jangar' or 'static'")

    def _validate_allocator_scalar_settings(self) -> None:
        checks: list[tuple[float | None, str]] = [
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
                self.trading_simple_max_order_pct_equity,
                "TRADING_SIMPLE_MAX_ORDER_PCT_EQUITY must be >= 0",
            ),
            (
                self.trading_simple_max_gross_exposure_pct_equity,
                "TRADING_SIMPLE_MAX_GROSS_EXPOSURE_PCT_EQUITY must be >= 0",
            ),
            (
                self.trading_simple_max_net_exposure_pct_equity,
                "TRADING_SIMPLE_MAX_NET_EXPOSURE_PCT_EQUITY must be >= 0",
            ),
            (
                self.trading_simple_max_symbol_pct_equity,
                "TRADING_SIMPLE_MAX_SYMBOL_PCT_EQUITY must be >= 0",
            ),
            (
                self.trading_simple_buying_power_reserve_bps,
                "TRADING_SIMPLE_BUYING_POWER_RESERVE_BPS must be >= 0",
            ),
            (
                self.trading_daily_loss_stop_pct_equity,
                "TRADING_DAILY_LOSS_STOP_PCT_EQUITY must be >= 0",
            ),
            (
                self.trading_persistent_drawdown_stop_pct_equity,
                "TRADING_PERSISTENT_DRAWDOWN_STOP_PCT_EQUITY must be >= 0",
            ),
            (
                self.trading_pair_delta_tolerance_bps,
                "TRADING_PAIR_DELTA_TOLERANCE_BPS must be >= 0",
            ),
            (
                self.trading_closeout_reprice_seconds,
                "TRADING_CLOSEOUT_REPRICE_SECONDS must be >= 0",
            ),
            (
                self.trading_closeout_max_attempts,
                "TRADING_CLOSEOUT_MAX_ATTEMPTS must be >= 0",
            ),
            (
                self.trading_closeout_slippage_bps,
                "TRADING_CLOSEOUT_SLIPPAGE_BPS must be >= 0",
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
        for value, name in (
            (
                self.trading_daily_loss_stop_pct_equity,
                "TRADING_DAILY_LOSS_STOP_PCT_EQUITY",
            ),
            (
                self.trading_persistent_drawdown_stop_pct_equity,
                "TRADING_PERSISTENT_DRAWDOWN_STOP_PCT_EQUITY",
            ),
        ):
            if not 0 < value <= 1:
                raise ValueError(f"{name} must be within (0, 1]")
        if self.trading_closeout_max_attempts < 1:
            raise ValueError("TRADING_CLOSEOUT_MAX_ATTEMPTS must be >= 1")
        if not (
            self.trading_new_exposure_cutoff_time_et
            <= self.trading_flatten_start_time_et
            <= self.trading_flat_confirmation_time_et
        ):
            raise ValueError(
                "TRADING_NEW_EXPOSURE_CUTOFF_TIME_ET, "
                "TRADING_FLATTEN_START_TIME_ET, and "
                "TRADING_FLAT_CONFIRMATION_TIME_ET must be ordered"
            )
        if (
            self.trading_enabled
            and self.trading_mode == "live"
            and self.trading_simple_submit_enabled
            and self.trading_live_submit_enabled
            and not self.trading_emergency_stop_enabled
        ):
            raise ValueError(
                "TRADING_EMERGENCY_STOP_ENABLED must be true when live submission is enabled"
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
        validate_fragility_map(
            "TRADING_FRAGILITY_STATE_BUDGET_MULTIPLIERS",
            self.trading_fragility_state_budget_multipliers,
        )
        validate_fragility_map(
            "TRADING_FRAGILITY_STATE_CAPACITY_MULTIPLIERS",
            self.trading_fragility_state_capacity_multipliers,
        )
        validate_fragility_map(
            "TRADING_FRAGILITY_STATE_PARTICIPATION_CLAMPS",
            self.trading_fragility_state_participation_clamps,
        )
        validate_fragility_map(
            "TRADING_FRAGILITY_STATE_ABSTAIN_BIAS",
            self.trading_fragility_state_abstain_bias,
        )
        self.trading_allocator_symbol_correlation_groups = {
            str(key).strip().upper(): str(value).strip().lower()
            for key, value in self.trading_allocator_symbol_correlation_groups.items()
            if str(key).strip() and str(value).strip()
        }

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

    def _normalize_tigerbeetle_settings(self) -> None:
        self.tigerbeetle_replica_addresses = self._normalize_csv_setting(
            self.tigerbeetle_replica_addresses
        )


__all__ = ["SettingsNormalizationMixin", "validate_fragility_map"]
