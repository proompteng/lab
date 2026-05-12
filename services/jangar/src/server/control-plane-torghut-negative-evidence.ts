export type TorghutNegativeEvidenceInput = {
  readiness_status?: 'healthy' | 'degraded' | 'unknown'
  readyz_status_code?: number | null
  market_context_status?: 'healthy' | 'degraded' | 'stale' | 'unknown'
  market_context_stale_domains?: string[]
  open_quant_alerts?: number
  critical_quant_alerts?: number
  rollout_ambiguity_refs?: string[]
  paper_settlement_clean?: boolean
  consumer_evidence_receipt_id?: string | null
  consumer_evidence_status?: 'current' | 'stale' | 'missing' | 'unavailable' | 'route_missing' | 'schema_mismatch'
  consumer_evidence_fresh_until?: string | null
  consumer_evidence_reason_codes?: string[]
  capital_reentry_cohort_ledger_id?: string | null
  capital_reentry_aggregate_state?: string | null
  capital_reentry_cohort_ids?: string[]
  capital_reentry_blocking_reason_codes?: string[]
  profit_repair_settlement_ledger_id?: string | null
  profit_repair_aggregate_state?: string | null
  profit_repair_lot_ids?: string[]
  profit_repair_blocking_reason_codes?: string[]
  routeability_repair_acceptance_ledger_id?: string | null
  routeability_aggregate_state?: string | null
  routeability_lot_ids?: string[]
  routeability_blocking_reason_codes?: string[]
  accepted_routeable_candidate_count?: number | null
  profit_freshness_frontier_id?: string | null
  profit_freshness_state?: string | null
  profit_freshness_repair_lot_ids?: string[]
  profit_freshness_selected_repair_ids?: string[]
  profit_freshness_blocking_reason_codes?: string[]
  evidence_clock_arbiter_id?: string | null
  evidence_clock_status?: string | null
  evidence_clock_split_clock_names?: string[]
  evidence_clock_blocking_reason_codes?: string[]
  evidence_clock_custody_status?: string | null
  evidence_clock_custody_ref?: string | null
  evidence_clock_custody_reason_codes?: string[]
  routeable_profit_candidate_exchange_id?: string | null
  routeable_exchange_zero_notional_repair_lot_ids?: string[]
  routeable_exchange_routeable_candidate_count?: number | null
  routeable_exchange_rejected_candidate_count?: number | null
}
