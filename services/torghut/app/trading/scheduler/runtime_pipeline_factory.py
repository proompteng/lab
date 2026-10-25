"""Production scheduler pipeline construction."""

from __future__ import annotations

from ...alpaca_client import TorghutAlpacaClient
from ...config import TradingAccountLane, settings
from ...db import SessionLocal
from ...strategies import StrategyCatalog
from ..broker_account_activity_backfill import (
    AlpacaAccountActivitiesClient,
    BrokerAccountActivityIngestor,
)
from ..decisions import DecisionEngine
from ..execution import OrderExecutor
from ..execution_adapters import build_execution_adapter
from ..firewall import OrderFirewall
from ..ingest import ClickHouseSignalIngestor
from ..order_feed import OrderFeedIngestor
from ..prices import ClickHousePriceFetcher
from ..reconcile import Reconciler
from ..risk import RiskEngine
from ..universe import UniverseResolver
from .pipeline import TradingPipeline
from .pipeline.contexts import TradingPipelineRuntimeDependencies
from .state import TradingState


def build_trading_pipeline_for_account(
    *,
    lane: TradingAccountLane,
    state: TradingState,
) -> TradingPipeline:
    price_fetcher = ClickHousePriceFetcher()
    strategy_catalog = StrategyCatalog.from_settings()
    alpaca_client = TorghutAlpacaClient(
        api_key=lane.api_key,
        secret_key=lane.secret_key,
        base_url=lane.base_url,
    )
    order_firewall = OrderFirewall(alpaca_client, account_label=lane.label)
    execution_adapter = build_execution_adapter(
        alpaca_client=alpaca_client,
        order_firewall=order_firewall,
        session_factory=SessionLocal,
        account_label=lane.label,
        endpoint_url=order_firewall.broker_endpoint_url,
    )
    broker_account_activity_ingestor = BrokerAccountActivityIngestor(
        client=AlpacaAccountActivitiesClient(
            api_key=lane.api_key or settings.apca_api_key_id or "",
            secret_key=lane.secret_key or settings.apca_api_secret_key or "",
            endpoint_url=alpaca_client.endpoint_url,
        ),
        session_factory=SessionLocal,
        account_label=lane.label,
    )
    executor = OrderExecutor()
    executor.prime_shorting_metadata_cache(alpaca_client)
    dependencies = TradingPipelineRuntimeDependencies(
        alpaca_client=alpaca_client,
        order_firewall=order_firewall,
        ingestor=ClickHouseSignalIngestor(account_label=lane.label),
        decision_engine=DecisionEngine(price_fetcher=price_fetcher),
        risk_engine=RiskEngine(),
        executor=executor,
        execution_adapter=execution_adapter,
        reconciler=Reconciler(account_label=lane.label),
        universe_resolver=UniverseResolver(),
        state=state,
        account_label=lane.label,
        session_factory=SessionLocal,
        price_fetcher=price_fetcher,
        strategy_catalog=strategy_catalog,
        order_feed_ingestor=OrderFeedIngestor(
            default_account_label=lane.label,
            broker_environment=broker_account_activity_ingestor.environment,
            broker_endpoint_fingerprint=(
                broker_account_activity_ingestor.endpoint_fingerprint
            ),
        ),
        broker_account_activity_ingestor=broker_account_activity_ingestor,
    )
    return TradingPipeline(dependencies=dependencies)
