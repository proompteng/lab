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

logger = logging.getLogger(__name__)


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
        payload = payload_map.get("strategies", payload_map)
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
        if config.name in seen:
            raise ValueError(f"duplicate strategy name in catalog: {config.name}")
        seen.add(config.name)
        strategy = existing.get(config.name)
        if strategy is None:
            strategy = Strategy(name=config.name)
            session.add(strategy)
        strategy.description = config.description
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
