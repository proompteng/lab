import type {
  TorghutExecutableAlphaRepairReceipt,
  TorghutExecutableAlphaRepairReceiptSet,
} from '~/server/control-plane-status-types'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
  stringValues,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '~/server/primitives-http'

const EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION = 'torghut.executable-alpha-repair-receipt.v1'
const EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION = 'torghut.executable-alpha-repair-receipts.v1'

const readExecutableAlphaRepairReceipt = (rawReceipt: unknown): TorghutExecutableAlphaRepairReceipt | null => {
  const receipt = asRecord(rawReceipt)
  if (!receipt) return null
  const schema = normalizeNonEmpty(receipt.schema_version)
  if (schema !== EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION) return null
  const receiptId = normalizeNonEmpty(receipt.receipt_id)
  if (!receiptId) return null
  const jangarReentry = asRecord(receipt.jangar_reentry)
  return {
    schema_version: EXECUTABLE_ALPHA_REPAIR_RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    generated_at: normalizeNonEmpty(receipt.generated_at),
    fresh_until: normalizeNonEmpty(receipt.fresh_until),
    source_revenue_repair_ref: normalizeNonEmpty(receipt.source_revenue_repair_ref),
    hypothesis_id: normalizeNonEmpty(receipt.hypothesis_id),
    repair_class: normalizeReason(receipt.repair_class),
    target_value_gate: normalizeReason(receipt.target_value_gate),
    reason_codes: stringList(receipt.reason_codes),
    account_id: normalizeNonEmpty(receipt.account_id),
    window: normalizeNonEmpty(receipt.window),
    trading_mode: normalizeReason(receipt.trading_mode),
    candidate_id: normalizeNonEmpty(receipt.candidate_id),
    strategy_id: normalizeNonEmpty(receipt.strategy_id),
    lineage_status: normalizeReason(receipt.lineage_status),
    evidence_window_status: normalizeReason(receipt.evidence_window_status),
    alpha_readiness_state: normalizeReason(receipt.alpha_readiness_state),
    expected_unblock_value: normalizeNumber(receipt.expected_unblock_value),
    expected_gate_delta: normalizeReason(receipt.expected_gate_delta),
    required_input_refs: stringValues(receipt.required_input_refs),
    required_output_receipts: stringValues(receipt.required_output_receipts),
    validation_commands: stringValues(receipt.validation_commands),
    max_notional: normalizeNonEmpty(receipt.max_notional),
    capital_rule: normalizeReason(receipt.capital_rule),
    no_delta_settlement_required: receipt.no_delta_settlement_required === true,
    jangar_reentry: jangarReentry
      ? {
          required_material_reentry_receipt: normalizeNonEmpty(jangarReentry.required_material_reentry_receipt),
          action_class: normalizeReason(jangarReentry.action_class),
          max_parallelism: normalizeNumber(jangarReentry.max_parallelism),
          max_runtime_seconds: normalizeNumber(jangarReentry.max_runtime_seconds),
          value_gates: stringValues(jangarReentry.value_gates),
          rollback_target: normalizeNonEmpty(jangarReentry.rollback_target),
        }
      : null,
    rollback_target: normalizeNonEmpty(receipt.rollback_target),
  }
}

export const readExecutableAlphaRepairReceipts = (
  payload: Record<string, unknown> | null,
): TorghutExecutableAlphaRepairReceiptSet | null => {
  const set = asRecord(payload?.executable_alpha_repair_receipts)
  if (!set) return null
  const schema = normalizeNonEmpty(set.schema_version)
  if (schema !== EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION) return null
  const receipts = Array.isArray(set.receipts)
    ? set.receipts
        .map(readExecutableAlphaRepairReceipt)
        .filter((receipt): receipt is TorghutExecutableAlphaRepairReceipt => Boolean(receipt))
    : []
  const selectedReceipt =
    readExecutableAlphaRepairReceipt(set.selected_receipt) ??
    receipts.find((receipt) => receipt.receipt_id === normalizeNonEmpty(set.selected_receipt_id)) ??
    null
  return {
    schema_version: EXECUTABLE_ALPHA_REPAIR_RECEIPTS_SCHEMA_VERSION,
    generated_at: normalizeNonEmpty(set.generated_at),
    fresh_until: normalizeNonEmpty(set.fresh_until),
    source_revenue_repair_ref: normalizeNonEmpty(set.source_revenue_repair_ref),
    status: normalizeReason(set.status),
    governing_design_ref: normalizeNonEmpty(set.governing_design_ref),
    selected_receipt_id: normalizeNonEmpty(set.selected_receipt_id) ?? selectedReceipt?.receipt_id ?? null,
    selected_receipt: selectedReceipt,
    receipt_count: normalizeNumber(set.receipt_count) ?? receipts.length,
    receipts,
    target_value_gate: normalizeReason(set.target_value_gate),
    routeable_candidate_count_before: normalizeNumber(set.routeable_candidate_count_before),
    max_notional: normalizeNonEmpty(set.max_notional),
    capital_rule: normalizeReason(set.capital_rule),
    reason_codes: stringList(set.reason_codes),
    rollback_target: normalizeNonEmpty(set.rollback_target),
  }
}
