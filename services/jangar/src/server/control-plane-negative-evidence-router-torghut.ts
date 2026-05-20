import type { NegativeEvidenceKind } from '~/server/control-plane-status-types'

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
  route_warrant_id?: string | null
  route_warrant_state?: string | null
  route_warrant_repair_packet_ids?: string[]
  route_warrant_blocking_dependency_names?: string[]
  route_warrant_blocking_reason_codes?: string[]
  repair_bid_settlement_ledger_id?: string | null
  repair_bid_settlement_status?: string | null
  repair_bid_settlement_selected_lot_ids?: string[]
  repair_bid_settlement_dispatchable_lot_ids?: string[]
  repair_bid_settlement_held_lot_ids?: string[]
  repair_bid_settlement_blocking_reason_codes?: string[]
}

type AddEvidence = (kind: NegativeEvidenceKind, reason: string, refs?: string[]) => void

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

export const addTorghutEvidenceClockNegativeEvidence = (input: {
  torghut: TorghutNegativeEvidenceInput
  consumerEvidenceRef: string
  addEvidence: AddEvidence
}) => {
  const evidenceClockRefs = uniqueStrings([
    input.torghut.evidence_clock_arbiter_id ?? '',
    input.torghut.routeable_profit_candidate_exchange_id ?? '',
    ...(input.torghut.routeable_exchange_zero_notional_repair_lot_ids ?? []),
  ])
  const refs = evidenceClockRefs.length > 0 ? evidenceClockRefs : [input.consumerEvidenceRef]

  if (input.torghut.evidence_clock_status && input.torghut.evidence_clock_status !== 'current') {
    input.addEvidence('data_freshness_negative', `evidence_clock_${input.torghut.evidence_clock_status}`, refs)
  }

  for (const reason of input.torghut.evidence_clock_blocking_reason_codes ?? []) {
    input.addEvidence('data_freshness_negative', reason, refs)
  }

  if (input.torghut.evidence_clock_custody_status && input.torghut.evidence_clock_custody_status !== 'current') {
    const custodyReason = `evidence_clock_custody_${input.torghut.evidence_clock_custody_status}`
    input.addEvidence('data_freshness_negative', custodyReason, refs)
    input.addEvidence('current_runtime_negative', custodyReason, refs)
    input.addEvidence('rollout_ambiguity_negative', custodyReason, refs)
  }

  for (const reason of input.torghut.evidence_clock_custody_reason_codes ?? []) {
    input.addEvidence('rollout_ambiguity_negative', reason, refs)
  }

  for (const clockName of input.torghut.evidence_clock_split_clock_names ?? []) {
    if (clockName === 'rollout' || clockName === 'capital_gate') {
      input.addEvidence('rollout_ambiguity_negative', `evidence_clock_${clockName}_split`, refs)
    }
  }
}
