from __future__ import annotations

from datetime import timedelta

from app.trading.runtime_ledger import (
    EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
    POST_COST_PNL_BASIS,
)


EXECUTION_ELIGIBLE_DECISION_STATUSES = (
    "submitted",
    "filled",
    "partially_filled",
)


POST_COST_BASIS_RUNTIME_LEDGER = POST_COST_PNL_BASIS


POST_COST_BASIS_EXECUTION_RECONSTRUCTION = (
    "execution_reconstructed_pnl_after_explicit_costs"
)


RUNTIME_LEDGER_ARTIFACT_SCHEMAS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "torghut.exact_replay_ledger.rows.v1",
    }
)


RUNTIME_LEDGER_BUCKET_SCHEMAS = frozenset(
    {
        EXACT_REPLAY_LEDGER_SCHEMA_VERSION,
        "torghut.runtime-ledger-bucket.v1",
    }
)


EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS = "exact_replay_artifact_only_not_live"


EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS = (
    "exact_replay_artifact_not_runtime_proof",
    "runtime_ledger_source_window_missing",
    "runtime_ledger_source_refs_missing",
)


RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER = "runtime_ledger_source_window_missing"


RUNTIME_LEDGER_CARRY_IN_LOOKBACK = timedelta(days=5)


RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD = timedelta(seconds=3600)


RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS = 900


RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS = 300


RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER = "runtime_ledger_source_refs_missing"


RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER = (
    "runtime_ledger_execution_tca_refs_missing"
)


CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX = "configured-paper-collection:"


CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND = (
    "configured_simple_lane_paper_data_collection"
)


RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER = (
    "runtime_ledger_authority_class_missing"
)


EXECUTION_TCA_MISSING_BLOCKER = "execution_tca_missing"


_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS = frozenset(
    {
        "runtime_order_feed_execution_source",
        "event_sourced_runtime_ledger_profit_proof",
        "source_execution_runtime_ledger_materialized",
        "execution_order_events_runtime_ledger",
        "source_execution_lifecycle_materialized_runtime_ledger",
    }
)


_RUNTIME_LEDGER_DECISION_EVENTS = frozenset(
    {"decision", "trade_decision", "signal_decision"}
)


_RUNTIME_LEDGER_FILL_EVENTS = frozenset(
    {"fill", "filled", "partial_fill", "partially_filled"}
)


_RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS = _RUNTIME_LEDGER_FILL_EVENTS | frozenset(
    {"order_submitted"}
)


ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER = "order_feed_fill_lifecycle_missing"


ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER = "order_feed_fill_lifecycle_incomplete"


ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER = (
    "order_feed_fill_lifecycle_order_id_missing"
)


ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER = (
    "order_feed_unlinked_fill_lifecycle_present"
)


ORDER_FEED_LIFECYCLE_MISSING_BLOCKER = "order_feed_lifecycle_missing"


EXECUTION_ECONOMICS_MISSING_BLOCKER = "execution_economics_missing"


ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER = "order_feed_fill_delta_basis_missing"


ORDER_FEED_FILL_DELTA_MISSING_BLOCKER = "order_feed_fill_delta_missing"


_EXECUTION_TCA_REF_KEYS = (
    "execution_tca_metric_ids",
    "execution_tca_metric_refs",
    "execution_tca_metric_id",
    "execution_tca_metric_ref",
    "execution_tca_metrics",
    "execution_tca_ids",
    "execution_tca_refs",
    "execution_tca_id",
    "execution_tca_ref",
    "runtime_ledger_execution_tca_metric_ids",
    "runtime_ledger_execution_tca_metric_refs",
    "runtime_ledger_execution_tca_metric_id",
    "runtime_ledger_execution_tca_metric_ref",
    "runtime_ledger_execution_tca_ids",
    "runtime_ledger_execution_tca_refs",
    "runtime_ledger_execution_tca_id",
    "runtime_ledger_execution_tca_ref",
    "tca_metric_ids",
    "tca_metric_refs",
    "tca_metric_id",
    "tca_metric_ref",
    "tca_ids",
    "tca_refs",
    "tca_id",
    "tca_ref",
)


_SOURCE_WINDOW_REF_KEYS = (
    "source_window_ids",
    "source_window_refs",
    "source_window_id",
    "source_window_ref",
    "runtime_ledger_source_window_ids",
    "runtime_ledger_source_window_refs",
    "runtime_ledger_source_window_id",
    "runtime_ledger_source_window_ref",
)


_EXECUTION_ORDER_EVENT_REF_KEYS = (
    "execution_order_event_ids",
    "execution_order_event_refs",
    "execution_order_event_id",
    "execution_order_event_ref",
    "runtime_ledger_execution_order_event_ids",
    "runtime_ledger_execution_order_event_refs",
    "runtime_ledger_execution_order_event_id",
    "runtime_ledger_execution_order_event_ref",
)


_RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS = frozenset(
    {
        "runtime_ledger_source_window_missing",
        "runtime_ledger_source_window_ids_missing",
        "runtime_ledger_source_refs_missing",
        "runtime_ledger_trade_decision_refs_missing",
        "runtime_ledger_execution_refs_missing",
        "runtime_ledger_execution_order_event_refs_missing",
        "runtime_ledger_source_offsets_missing",
        "runtime_ledger_source_materialization_missing",
        "runtime_ledger_authority_class_missing",
        "order_feed_source_window_gap",
        "order_feed_lifecycle_missing",
        "execution_economics_missing",
    }
)


_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS = (
    "execution_id",
    "trade_decision_id",
    "decision_id",
    "decision_hash",
    "order_id",
    "alpaca_order_id",
    "client_order_id",
    "execution_correlation_id",
)


_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS = (
    "account_equity",
    "portfolio_equity",
    "start_equity",
    "starting_equity",
    "equity",
    "portfolio_value",
    "net_liquidation",
    "net_liquidation_value",
)


SOURCE_LINEAGE_CANDIDATE_KEYS = (
    "candidate_id",
    "candidate_ids",
    "strategy_candidate_id",
    "strategy_candidate_ids",
    "source_candidate_id",
    "source_candidate_ids",
)


SOURCE_LINEAGE_HYPOTHESIS_KEYS = (
    "hypothesis_id",
    "hypothesis_ids",
    "strategy_hypothesis_id",
    "strategy_hypothesis_ids",
    "source_hypothesis_id",
    "source_hypothesis_ids",
)


SOURCE_DECISION_MODE_MISSING_PARTITION = "source_decision_mode_missing"


_LINEAGE_CONTEXT_KEYS = (
    "strategy_id",
    "primary_declared_strategy_id",
    "source_declared_strategy_ids",
    "paper_route_target_plan_source",
    "simulation_run_id",
    "dataset_id",
    "dataset_snapshot_ref",
    "dataset_snapshot_hash",
    "replay_data_hash",
    "replay_tape_content_sha256",
    "source_query_digest",
    "source_topic",
    "source_partition",
)


_AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS = frozenset(
    {
        "paper_route_probe_runtime_observed",
        "paper_runtime_observed",
        "runtime_ledger_source_collection_candidate",
        "live_runtime_observed",
    }
)


__all__ = [
    "_AUTHORITATIVE_RUNTIME_LEDGER_MATERIALIZATION_SOURCE_KINDS",
    "EXECUTION_ELIGIBLE_DECISION_STATUSES",
    "POST_COST_BASIS_RUNTIME_LEDGER",
    "POST_COST_BASIS_EXECUTION_RECONSTRUCTION",
    "RUNTIME_LEDGER_ARTIFACT_SCHEMAS",
    "RUNTIME_LEDGER_BUCKET_SCHEMAS",
    "EXACT_REPLAY_ARTIFACT_AUTHORITY_CLASS",
    "EXACT_REPLAY_ARTIFACT_AUTHORITY_BLOCKERS",
    "RUNTIME_LEDGER_SOURCE_WINDOW_MISSING_BLOCKER",
    "RUNTIME_LEDGER_CARRY_IN_LOOKBACK",
    "RUNTIME_LEDGER_POST_WINDOW_CLOSEOUT_LOOKAHEAD",
    "RUNTIME_LEDGER_FLAT_START_SNAPSHOT_STALE_SECONDS",
    "RUNTIME_LEDGER_FLAT_START_SNAPSHOT_AFTER_START_GRACE_SECONDS",
    "RUNTIME_LEDGER_SOURCE_REFS_MISSING_BLOCKER",
    "RUNTIME_LEDGER_EXECUTION_TCA_REFS_MISSING_BLOCKER",
    "CONFIGURED_PAPER_COLLECTION_HYPOTHESIS_PREFIX",
    "CONFIGURED_SIMPLE_LANE_PAPER_SOURCE_KIND",
    "RUNTIME_LEDGER_AUTHORITY_CLASS_MISSING_BLOCKER",
    "EXECUTION_TCA_MISSING_BLOCKER",
    "_RUNTIME_LEDGER_PROMOTION_GRADE_AUTHORITY_MARKERS",
    "_RUNTIME_LEDGER_DECISION_EVENTS",
    "_RUNTIME_LEDGER_FILL_EVENTS",
    "_RUNTIME_LEDGER_ORDER_LIFECYCLE_EVENTS",
    "ORDER_FEED_FILL_LIFECYCLE_MISSING_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_INCOMPLETE_BLOCKER",
    "ORDER_FEED_FILL_LIFECYCLE_ORDER_ID_MISSING_BLOCKER",
    "ORDER_FEED_UNLINKED_FILL_LIFECYCLE_PRESENT_BLOCKER",
    "ORDER_FEED_LIFECYCLE_MISSING_BLOCKER",
    "EXECUTION_ECONOMICS_MISSING_BLOCKER",
    "ORDER_FEED_FILL_DELTA_BASIS_MISSING_BLOCKER",
    "ORDER_FEED_FILL_DELTA_MISSING_BLOCKER",
    "_EXECUTION_TCA_REF_KEYS",
    "_SOURCE_WINDOW_REF_KEYS",
    "_EXECUTION_ORDER_EVENT_REF_KEYS",
    "_RUNTIME_LEDGER_SOURCE_AUTHORITY_BLOCKERS",
    "_RUNTIME_LIFECYCLE_IDENTIFIER_KEYS",
    "_RUNTIME_LEDGER_EQUITY_DENOMINATOR_KEYS",
    "SOURCE_LINEAGE_CANDIDATE_KEYS",
    "SOURCE_LINEAGE_HYPOTHESIS_KEYS",
    "SOURCE_DECISION_MODE_MISSING_PARTITION",
    "_LINEAGE_CONTEXT_KEYS",
]
