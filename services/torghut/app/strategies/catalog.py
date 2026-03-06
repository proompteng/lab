"""Load and reconcile strategy catalog definitions."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal, cast

import yaml
from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Strategy
from ..trading.strategy_specs import (
    build_compiled_strategy_artifacts,
    strategy_type_supports_spec_v2,
)

logger = logging.getLogger(__name__)

_CATALOG_METADATA_MARKER = "\n[catalog_metadata]\n"


class StrategyConfig(BaseModel):
    """Declarative strategy configuration for catalog files."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    enabled: bool = True
    strategy_id: str | None = None
    strategy_type: str | None = None
    version: str | None = None
    params: dict[str, Any] | None = None
    priority: int = 100
    base_timeframe: str = "1Min"
    universe_type: str = "static"
    universe_symbols: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices("universe_symbols", "symbols"),
    )
    max_position_pct_equity: Decimal | None = None
    max_notional_per_trade: Decimal | None = None

    @field_validator("universe_symbols", mode="before")
    @classmethod
    def _coerce_symbols(cls, value: Any) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            return [symbol.strip() for symbol in value.split(",") if symbol.strip()]
        return [str(symbol) for symbol in value]

    @model_validator(mode="after")
    def _normalize_strategy(self) -> "StrategyConfig":
        strategy_id = (self.strategy_id or "").strip()
        if not self.name and strategy_id:
            self.name = strategy_id

        if not self.name:
            raise ValueError("strategy.name is required; provide name or strategy_id")

        strategy_type = (self.strategy_type or "").strip()
        if self.universe_type == "static" and strategy_type:
            normalized_universe_type = _map_strategy_type_to_universe_type(strategy_type)
            if normalized_universe_type:
                self.universe_type = normalized_universe_type

        if self.strategy_type and self.version:
            if self.description is None:
                self.description = f"{self.strategy_type} v{self.version}"
            elif f"{self.strategy_type}@{self.version}" not in self.description:
                self.description = f"{self.description} ({self.strategy_type}@{self.version})"
        return self


class StrategyCatalogConfig(BaseModel):
    """Wrapper for a list of strategy configs."""

    model_config = ConfigDict(extra="forbid")

    strategies: list[StrategyConfig]


@dataclass
class StrategyCatalog:
    path: Path
    mode: Literal["merge", "sync"] = "merge"
    reload_seconds: int = 10
    _last_checked_at: float = field(default=0.0, init=False)
    _last_digest: str | None = field(default=None, init=False)

    @classmethod
    def from_settings(cls) -> "StrategyCatalog | None":
        if not settings.trading_strategy_config_path:
            return None
        return cls(
            path=Path(settings.trading_strategy_config_path).expanduser(),
            mode=settings.trading_strategy_config_mode,
            reload_seconds=settings.trading_strategy_reload_seconds,
        )

    def refresh(self, session: Session) -> bool:
        now = time.monotonic()
        if now - self._last_checked_at < self.reload_seconds:
            return False
        self._last_checked_at = now

        if not self.path.exists():
            logger.warning("Strategy catalog not found path=%s", self.path)
            return False

        try:
            raw, payload = _load_catalog_payload(self.path)
            digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
            if digest == self._last_digest:
                return False
            catalog = _parse_catalog_payload(payload)
        except (OSError, json.JSONDecodeError, ValidationError, ValueError, yaml.YAMLError) as exc:
            logger.warning("Strategy catalog load failed path=%s error=%s", self.path, exc)
            return False

        try:
            applied = _apply_catalog(session, catalog, mode=self.mode)
        except Exception:
            session.rollback()
            logger.exception("Strategy catalog apply failed path=%s", self.path)
            return False

        self._last_digest = digest
        if applied:
            logger.info(
                "Strategy catalog applied path=%s strategies=%s mode=%s",
                self.path,
                applied,
                self.mode,
            )
        return applied > 0


def _load_catalog_payload(path: Path) -> tuple[str, Any]:
    raw = path.read_text(encoding="utf-8")
    if not raw.strip():
        return raw, []

    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        payload = yaml.safe_load(raw)
    elif suffix == ".json":
        payload = json.loads(raw)
    else:
        raise ValueError(f"unsupported strategy catalog extension: {suffix}")

    return raw, payload


def _parse_catalog_payload(payload: Any) -> StrategyCatalogConfig:
    if payload is None:
        return StrategyCatalogConfig(strategies=[])
    if isinstance(payload, dict):
        payload_map = cast(dict[str, Any], payload)
        strategies_payload = payload_map.get("strategies")
        if strategies_payload is None:
            raise ValueError("strategy catalog must define a 'strategies' list")
        if not isinstance(strategies_payload, list):
            raise ValueError("strategy catalog 'strategies' value must be a list")
        return StrategyCatalogConfig.model_validate({"strategies": strategies_payload})
    if isinstance(payload, list):
        return StrategyCatalogConfig.model_validate({"strategies": payload})
    raise ValueError("strategy catalog must be a list or contain a 'strategies' key")


def _map_strategy_type_to_universe_type(strategy_type: str) -> str:
    normalized = strategy_type.strip().lower()
    if normalized in {"static", "legacy_macd_rsi"}:
        return "static"
    if normalized in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
        return "intraday_tsmom_v1"
    return strategy_type


def _apply_catalog(session: Session, catalog: StrategyCatalogConfig, mode: Literal["merge", "sync"]) -> int:
    existing = {strategy.name: strategy for strategy in session.execute(select(Strategy)).scalars().all()}
    seen: set[str] = set()
    updated = 0

    for config in catalog.strategies:
        if config.name is None:
            raise ValueError("strategy name is required")
        strategy_name = config.name

        if strategy_name in seen:
            raise ValueError(f"duplicate strategy name in catalog: {config.name}")
        seen.add(strategy_name)
        strategy = existing.get(strategy_name)
        if strategy is None:
            strategy = Strategy(name=strategy_name)
            session.add(strategy)
        strategy.description = _compose_strategy_description(config)
        strategy.enabled = config.enabled
        strategy.base_timeframe = config.base_timeframe
        strategy.universe_type = config.universe_type
        strategy.universe_symbols = config.universe_symbols or None
        strategy.max_position_pct_equity = config.max_position_pct_equity
        strategy.max_notional_per_trade = config.max_notional_per_trade
        updated += 1

    if mode == "sync":
        for name, strategy in existing.items():
            if name not in seen and strategy.enabled:
                strategy.enabled = False
                updated += 1

    if updated:
        session.commit()
    return updated


def extract_catalog_metadata(description: str | None) -> dict[str, Any]:
    if description is None:
        return {}
    marker_index = description.rfind(_CATALOG_METADATA_MARKER)
    if marker_index < 0:
        return {}
    raw = description[marker_index + len(_CATALOG_METADATA_MARKER) :].strip()
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(payload, dict):
        return {}
    return cast(dict[str, Any], payload)


def strip_catalog_metadata(description: str | None) -> str | None:
    if description is None:
        return None
    marker_index = description.rfind(_CATALOG_METADATA_MARKER)
    if marker_index < 0:
        cleaned = description.strip()
        return cleaned or None
    cleaned = description[:marker_index].strip()
    return cleaned or None


def _compose_strategy_description(config: StrategyConfig) -> str | None:
    base_description = strip_catalog_metadata(config.description)
    metadata = _strategy_catalog_metadata(config)
    if not metadata:
        return base_description
    encoded = json.dumps(metadata, sort_keys=True, separators=(",", ":"), default=str)
    if base_description:
        return f"{base_description}{_CATALOG_METADATA_MARKER}{encoded}"
    return f"catalog-managed{_CATALOG_METADATA_MARKER}{encoded}"


def _strategy_catalog_metadata(config: StrategyConfig) -> dict[str, Any]:
    strategy_id = str(config.strategy_id or config.name or "").strip()
    strategy_type = str(config.strategy_type or config.universe_type or "").strip()
    version = str(config.version or "").strip()
    params = dict(config.params or {})
    if not strategy_id and not strategy_type and not version and not params:
        return {}

    metadata: dict[str, Any] = {
        "strategy_id": strategy_id or None,
        "strategy_type": strategy_type or None,
        "version": version or None,
        "params": params,
        "catalog_source": "strategy_catalog",
    }

    if strategy_type and strategy_type_supports_spec_v2(strategy_type):
        compiled = build_compiled_strategy_artifacts(
            strategy_id=strategy_id or str(config.name or strategy_type),
            strategy_type=strategy_type,
            semantic_version=version or "1.0.0",
            params=params,
            base_timeframe=config.base_timeframe,
            universe_symbols=list(config.universe_symbols),
            source="spec_v2",
        )
        metadata["compiler_source"] = "spec_v2"
        metadata["strategy_spec_v2"] = compiled.strategy_spec.to_payload()
        metadata["compiled_targets"] = {
            "evaluator_config": compiled.evaluator_config,
            "shadow_runtime_config": compiled.shadow_runtime_config,
            "live_runtime_config": compiled.live_runtime_config,
            "promotion_metadata": compiled.promotion_metadata,
        }
    else:
        metadata["compiler_source"] = "legacy_runtime"

    return {key: value for key, value in metadata.items() if value is not None}
