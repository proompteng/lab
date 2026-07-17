"""Concrete Torghut settings model and derived accessors."""

import json
import os
from functools import lru_cache
import string
from typing import Any, List, cast
from urllib.parse import urlsplit

from pydantic import ValidationError
from pydantic_settings import SettingsConfigDict

from .common import (
    LLM_COMMITTEE_ROLES,
    TradingAccountLane,
    dspy_bootstrap_artifact_hash,
    logger,
)
from .normalization import SettingsNormalizationMixin


class SettingsAccessorsMixin(SettingsNormalizationMixin):
    def _validate_scheduler_timing_settings(self) -> None:
        success_max_age_ms = self.trading_scheduler_success_max_age_seconds * 1000.0
        if self.trading_reconcile_ms >= success_max_age_ms:
            raise ValueError(
                "TRADING_RECONCILE_MS must be strictly less than "
                "TRADING_SCHEDULER_SUCCESS_MAX_AGE_SECONDS * 1000"
            )

    def _validate_tigerbeetle_settings(self) -> None:
        if self.tigerbeetle_cluster_id <= 0:
            raise ValueError("TORGHUT_TIGERBEETLE_CLUSTER_ID must be > 0")
        if self.tigerbeetle_health_timeout_seconds <= 0:
            raise ValueError("TORGHUT_TIGERBEETLE_HEALTH_TIMEOUT_SECONDS must be > 0")
        if self.tigerbeetle_rpc_timeout_seconds <= 0:
            raise ValueError("TORGHUT_TIGERBEETLE_RPC_TIMEOUT_SECONDS must be > 0")
        if self.tigerbeetle_reconcile_max_age_seconds <= 0:
            raise ValueError(
                "TORGHUT_TIGERBEETLE_RECONCILE_MAX_AGE_SECONDS must be > 0"
            )
        if self.tigerbeetle_enabled and not self.tigerbeetle_replica_addresses:
            raise ValueError(
                "TORGHUT_TIGERBEETLE_REPLICA_ADDRESSES is required when TigerBeetle is enabled"
            )
        if self.tigerbeetle_economic_parity_required and not self.tigerbeetle_enabled:
            raise ValueError(
                "TORGHUT_TIGERBEETLE_ENABLED is required when economic parity is required"
            )

    def model_post_init(self, __context: Any) -> None:
        del __context
        if not os.getenv("LOG_FORMAT"):
            self.log_format = "json" if self.app_env in {"stage", "prod"} else "text"
        if not os.getenv("LOG_LEVEL"):
            self.log_level = "INFO"
        self._apply_feature_flag_overrides()
        self._apply_trading_defaults()
        self._normalize_optional_url_settings()
        self._normalize_optional_nullable_settings()
        self._normalize_trading_csv_settings()
        self._normalize_tigerbeetle_settings()
        self._validate_scheduler_timing_settings()
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
        self._validate_tigerbeetle_settings()

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
    def trading_universe_symbol_allowlist(self) -> list[str]:
        if not self.trading_universe_symbol_allowlist_raw:
            return []
        return [
            symbol.strip().upper()
            for symbol in self.trading_universe_symbol_allowlist_raw.split(",")
            if symbol.strip()
        ]

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

    def _append_dspy_runtime_mode_reasons(
        self, reasons: list[str], normalized_stage: str
    ) -> None:
        if self.trading_mode != "live":
            reasons.append("dspy_live_requires_live_trading_mode")
        if self.llm_dspy_runtime_mode != "active":
            reasons.append("dspy_live_runtime_mode_not_active")
        if normalized_stage != "stage3":
            reasons.append("dspy_live_rollout_stage_not_stage3")

    def _append_dspy_jangar_url_reasons(self, reasons: list[str]) -> None:
        if not self.jangar_base_url:
            reasons.append("dspy_jangar_base_url_missing")
            return

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

    def _append_dspy_artifact_reasons(self, reasons: list[str]) -> None:
        if not self.llm_dspy_artifact_hash:
            reasons.append("dspy_artifact_hash_missing")
            return

        normalized_hash = self.llm_dspy_artifact_hash.strip().lower()
        if len(normalized_hash) != 64:
            reasons.append("dspy_artifact_hash_invalid_length")
        elif any(ch not in string.hexdigits for ch in normalized_hash):
            reasons.append("dspy_artifact_hash_not_hex")
        elif (
            normalized_hash == (dspy_bootstrap_artifact_hash() or "")
            and self.llm_dspy_runtime_mode == "active"
        ):
            reasons.append("dspy_bootstrap_artifact_forbidden")

    def _append_dspy_model_inventory_reasons(self, reasons: list[str]) -> None:
        if not self.llm_allowed_models:
            reasons.append("llm_model_inventory_missing")
        elif self.llm_model not in self.llm_allowed_models:
            reasons.append("llm_model_not_in_inventory")

    def _append_dspy_stage_evidence_reasons(
        self, reasons: list[str], normalized_stage: str
    ) -> None:
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

    def _append_dspy_committee_reasons(self, reasons: list[str]) -> None:
        if not self.llm_committee_enabled:
            reasons.append("llm_committee_disabled")
        if self.llm_committee_roles and not all(
            role in LLM_COMMITTEE_ROLES for role in self.llm_committee_roles
        ):
            reasons.append("llm_committee_roles_invalid")
        if self.llm_committee_mandatory_roles and not all(
            role in LLM_COMMITTEE_ROLES for role in self.llm_committee_mandatory_roles
        ):
            reasons.append("llm_committee_mandatory_roles_invalid")

    def llm_dspy_live_runtime_gate(self) -> tuple[bool, tuple[str, ...]]:
        normalized_stage = self._normalize_rollout_stage(self.llm_rollout_stage)
        reasons: list[str] = []
        self._append_dspy_runtime_mode_reasons(reasons, normalized_stage)
        self._append_dspy_jangar_url_reasons(reasons)
        self._append_dspy_artifact_reasons(reasons)
        self._append_dspy_model_inventory_reasons(reasons)
        self._append_dspy_stage_evidence_reasons(reasons, normalized_stage)
        self._append_dspy_committee_reasons(reasons)

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


class Settings(
    SettingsAccessorsMixin,
):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return a cached Settings instance so values are loaded once."""

    return Settings()


__all__ = ["Settings", "get_settings"]
