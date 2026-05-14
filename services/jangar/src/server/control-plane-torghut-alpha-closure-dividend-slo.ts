import type { TorghutAlphaClosureDividendSlo } from '~/data/agents-control-plane'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
  stringValues,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '~/server/primitives-http'

export const ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION = 'torghut.alpha-closure-dividend-slo.v1'

export const readAlphaClosureDividendSlo = (
  payload: Record<string, unknown> | null,
): TorghutAlphaClosureDividendSlo | null => {
  const slo = asRecord(payload?.alpha_closure_dividend_slo)
  if (!slo) return null
  const schema = normalizeNonEmpty(slo.schema_version)
  if (schema !== ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION) return null

  const sloId = normalizeNonEmpty(slo.slo_id)
  if (!sloId) return null

  return {
    schema_version: ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION,
    slo_id: sloId,
    generated_at: normalizeNonEmpty(slo.generated_at),
    fresh_until: normalizeNonEmpty(slo.fresh_until),
    source_revenue_repair_ref: normalizeNonEmpty(slo.source_revenue_repair_ref),
    source_board_ref: normalizeNonEmpty(slo.source_board_ref),
    source_settlement_market_ref: normalizeNonEmpty(slo.source_settlement_market_ref),
    selected_hypothesis_id: normalizeNonEmpty(slo.selected_hypothesis_id),
    selected_value_gate: normalizeReason(slo.selected_value_gate),
    selected_repair_class: normalizeReason(slo.selected_repair_class),
    required_settlement_receipt: normalizeNonEmpty(slo.required_settlement_receipt),
    active_dedupe_key: normalizeNonEmpty(slo.active_dedupe_key),
    routeable_candidate_count_before: normalizeNumber(slo.routeable_candidate_count_before),
    routeable_candidate_count_after: normalizeNumber(slo.routeable_candidate_count_after),
    measured_delta: normalizeNumber(slo.measured_delta),
    dividend_state: normalizeReason(slo.dividend_state),
    retired_reason_codes: stringList(slo.retired_reason_codes),
    preserved_reason_codes: stringList(slo.preserved_reason_codes),
    introduced_reason_codes: stringList(slo.introduced_reason_codes),
    no_delta_budget_state: normalizeReason(slo.no_delta_budget_state),
    no_delta_debt_count: normalizeNumber(slo.no_delta_debt_count),
    release_conditions: stringValues(slo.release_conditions),
    next_allowed_attempt_after: normalizeNonEmpty(slo.next_allowed_attempt_after),
    validation_commands: stringValues(slo.validation_commands),
    enforcement_mode: normalizeReason(slo.enforcement_mode),
    max_notional: normalizeNonEmpty(slo.max_notional),
    capital_rule: normalizeReason(slo.capital_rule),
    reason_codes: stringList(slo.reason_codes),
    rollback_target: normalizeNonEmpty(slo.rollback_target),
  }
}

export const alphaClosureDividendSloSchemaMismatch = (payload: Record<string, unknown> | null): string | null => {
  const slo = asRecord(payload?.alpha_closure_dividend_slo)
  if (!slo) return null
  const schema = normalizeNonEmpty(slo.schema_version)
  if (!schema || schema === ALPHA_CLOSURE_DIVIDEND_SLO_SCHEMA_VERSION) return null
  return `alpha_closure_dividend_slo:${schema}`
}
