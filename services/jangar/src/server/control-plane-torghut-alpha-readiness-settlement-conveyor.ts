import type { TorghutAlphaReadinessSettlementConveyorRef } from '~/data/agents-control-plane'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '~/server/primitives-http'

export const ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION =
  'torghut.alpha-readiness-settlement-conveyor-ref.v1'

export const readAlphaReadinessSettlementConveyorRef = (
  payload: Record<string, unknown> | null,
): TorghutAlphaReadinessSettlementConveyorRef | null => {
  const conveyor = asRecord(payload?.alpha_readiness_settlement_conveyor)
  if (!conveyor) return null
  const schema = normalizeNonEmpty(conveyor.schema_version)
  if (schema !== ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION) return null

  return {
    schema_version: ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION,
    conveyor_schema_version: normalizeNonEmpty(conveyor.conveyor_schema_version),
    conveyor_id: normalizeNonEmpty(conveyor.conveyor_id),
    generated_at: normalizeNonEmpty(conveyor.generated_at),
    fresh_until: normalizeNonEmpty(conveyor.fresh_until),
    status: normalizeReason(conveyor.status),
    settlement_state: normalizeReason(conveyor.settlement_state),
    reason_codes: stringList(conveyor.reason_codes),
    selected_hypothesis_id: normalizeNonEmpty(conveyor.selected_hypothesis_id),
    selected_value_gate: normalizeReason(conveyor.selected_value_gate),
    routeable_candidate_count_before: normalizeNumber(conveyor.routeable_candidate_count_before),
    routeable_candidate_count_after: normalizeNumber(conveyor.routeable_candidate_count_after),
    measured_routeable_candidate_delta: normalizeNumber(conveyor.measured_routeable_candidate_delta),
    active_no_delta_lease_count: normalizeNumber(conveyor.active_no_delta_lease_count),
    required_receipt: normalizeNonEmpty(conveyor.required_receipt),
    validation_command: normalizeNonEmpty(conveyor.validation_command),
    no_delta_release_key: normalizeNonEmpty(conveyor.no_delta_release_key),
    repeat_launch_decision: normalizeReason(conveyor.repeat_launch_decision),
    max_notional: normalizeNonEmpty(conveyor.max_notional),
    capital_rule: normalizeReason(conveyor.capital_rule),
    rollback_target: normalizeNonEmpty(conveyor.rollback_target),
  }
}

export const alphaReadinessSettlementConveyorRefSchemaMismatch = (
  payload: Record<string, unknown> | null,
): string | null => {
  const conveyor = asRecord(payload?.alpha_readiness_settlement_conveyor)
  if (!conveyor) return null
  const schema = normalizeNonEmpty(conveyor.schema_version)
  if (!schema || schema === ALPHA_READINESS_SETTLEMENT_CONVEYOR_REF_SCHEMA_VERSION) return null
  return `alpha_readiness_settlement_conveyor:${schema}`
}
