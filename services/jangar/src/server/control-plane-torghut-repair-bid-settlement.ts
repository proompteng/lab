import type { TorghutRepairBidSettlementLot } from '~/server/control-plane-status-types'
import {
  normalizeBoolean,
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
  stringValues,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '@proompteng/agent-contracts'

export const normalizeRepairBidSettlementLot = (value: unknown): TorghutRepairBidSettlementLot | null => {
  const lot = asRecord(value)
  const lotId = normalizeNonEmpty(lot?.lot_id)
  if (!lot || !lotId) return null
  return {
    lot_id: lotId,
    lot_class: normalizeReason(lot.lot_class) ?? 'unknown',
    target_value_gate: normalizeReason(lot.target_value_gate) ?? '',
    priority: normalizeNumber(lot.priority),
    expected_gate_delta: normalizeReason(lot.expected_gate_delta),
    raw_reason_codes: stringList(lot.raw_reason_codes),
    root_cause_hypothesis: normalizeNonEmpty(lot.root_cause_hypothesis),
    required_input_refs: stringValues(lot.required_input_refs),
    required_output_receipt: normalizeNonEmpty(lot.required_output_receipt),
    required_output_receipt_count: normalizeNumber(lot.required_output_receipt_count),
    validation_commands: stringValues(lot.validation_commands),
    dedupe_key: normalizeNonEmpty(lot.dedupe_key),
    ttl_seconds: normalizeNumber(lot.ttl_seconds),
    max_runtime_seconds: normalizeNumber(lot.max_runtime_seconds),
    max_parallelism: normalizeNumber(lot.max_parallelism),
    max_notional: normalizeNonEmpty(lot.max_notional),
    state: normalizeReason(lot.state),
    dispatchable: normalizeBoolean(lot.dispatchable),
    hold_reason_codes: stringList(lot.hold_reason_codes),
    source_bid_ids: stringValues(lot.source_bid_ids),
  }
}
