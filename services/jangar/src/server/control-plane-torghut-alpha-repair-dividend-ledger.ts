import type { TorghutAlphaRepairDividendLedgerRef } from '~/server/control-plane-status-types'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '@proompteng/agent-contracts/json'

export const ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION = 'torghut.alpha-repair-dividend-ledger-ref.v1'

export const readAlphaRepairDividendLedgerRef = (
  payload: Record<string, unknown> | null,
): TorghutAlphaRepairDividendLedgerRef | null => {
  const ledger = asRecord(payload?.alpha_repair_dividend_ledger)
  if (!ledger) return null
  const schema = normalizeNonEmpty(ledger.schema_version)
  if (schema !== ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION) return null

  return {
    schema_version: ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION,
    ledger_schema_version: normalizeNonEmpty(ledger.ledger_schema_version),
    ledger_id: normalizeNonEmpty(ledger.ledger_id),
    generated_at: normalizeNonEmpty(ledger.generated_at),
    fresh_until: normalizeNonEmpty(ledger.fresh_until),
    status: normalizeReason(ledger.status),
    dividend_state: normalizeReason(ledger.dividend_state),
    reason_codes: stringList(ledger.reason_codes),
    selected_hypothesis_id: normalizeNonEmpty(ledger.selected_hypothesis_id),
    selected_value_gate: normalizeReason(ledger.selected_value_gate),
    routeable_candidate_count_before: normalizeNumber(ledger.routeable_candidate_count_before),
    routeable_candidate_count_after: normalizeNumber(ledger.routeable_candidate_count_after),
    measured_delta: normalizeNumber(ledger.measured_delta),
    no_delta_release_key: normalizeNonEmpty(ledger.no_delta_release_key),
    launch_decision: normalizeReason(ledger.launch_decision),
    required_recorder_schema: normalizeNonEmpty(ledger.required_recorder_schema),
    validation_command: normalizeNonEmpty(ledger.validation_command),
    enforcement_mode: normalizeReason(ledger.enforcement_mode),
    max_notional: normalizeNonEmpty(ledger.max_notional),
    capital_rule: normalizeReason(ledger.capital_rule),
    rollback_target: normalizeNonEmpty(ledger.rollback_target),
  }
}

export const alphaRepairDividendLedgerRefSchemaMismatch = (payload: Record<string, unknown> | null): string | null => {
  const ledger = asRecord(payload?.alpha_repair_dividend_ledger)
  if (!ledger) return null
  const schema = normalizeNonEmpty(ledger.schema_version)
  if (!schema || schema === ALPHA_REPAIR_DIVIDEND_LEDGER_REF_SCHEMA_VERSION) return null
  return `alpha_repair_dividend_ledger:${schema}`
}
