# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Application configuration for the torghut service."""

import json
import logging
import tempfile
import os
from decimal import Decimal
from functools import lru_cache
from http.client import HTTPConnection, HTTPSConnection
from pathlib import Path
import string
from typing import Any, List, Literal, Optional, cast
from urllib.parse import urlsplit

from pydantic import AliasChoices, BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from ..logging_config import configure_logging

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_20 import *
from .part_02_settingsfieldspart1 import *
from .part_03_settingsfieldspart2 import *
from .part_04_settingsfieldspart3 import *


class _SettingsFieldsPart4(BaseSettings):
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


__all__ = [name for name in globals() if not name.startswith("__")]
