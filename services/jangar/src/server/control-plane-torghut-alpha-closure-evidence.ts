import type {
  TorghutAlphaEvidenceFoundryRef,
  TorghutAlphaRepairClosureBoardRef,
} from '~/server/control-plane-status-types'
import {
  normalizeNonEmpty,
  normalizeNumber,
  normalizeReason,
  stringList,
  stringValues,
  uniqueStrings,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '@proompteng/agent-contracts'

const ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION = 'torghut.alpha-repair-closure-board-ref.v1'
const ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION = 'torghut.alpha-repair-closure-board.v1'
const ALPHA_EVIDENCE_FOUNDRY_REF_SCHEMA_VERSION = 'torghut.alpha-evidence-foundry-ref.v1'
const ALPHA_EVIDENCE_FOUNDRY_SCHEMA_VERSION = 'torghut.alpha-evidence-foundry.v1'

export const readAlphaRepairClosureBoard = (
  payload: Record<string, unknown> | null,
): TorghutAlphaRepairClosureBoardRef | null => {
  const board = asRecord(payload?.alpha_repair_closure_board)
  if (!board) return null
  const schema = normalizeNonEmpty(board.schema_version)
  if (
    schema !== ALPHA_REPAIR_CLOSURE_BOARD_REF_SCHEMA_VERSION &&
    schema !== ALPHA_REPAIR_CLOSURE_BOARD_SCHEMA_VERSION
  ) {
    return null
  }

  const market = asRecord(board.alpha_closure_settlement_market)
  const noDeltaBudget = asRecord(market?.no_delta_budget)
  const pendingReceipt = asRecord(market?.pending_settlement_receipt)
  const closures = Array.isArray(board.repair_closures)
    ? board.repair_closures
        .map((closure) => asRecord(closure))
        .filter((closure): closure is Record<string, unknown> => Boolean(closure))
    : []
  const topClosure = closures[0]
  const noDeltaDebt = Array.isArray(board.no_delta_debt) ? board.no_delta_debt : []

  const boardId = normalizeNonEmpty(board.board_id)
  if (!boardId) return null

  return {
    schema_version: schema,
    board_id: boardId,
    generated_at: normalizeNonEmpty(board.generated_at),
    fresh_until: normalizeNonEmpty(board.fresh_until),
    status: normalizeReason(board.status),
    reason_codes: uniqueStrings([
      ...stringList(board.reason_codes),
      ...stringList(market?.reason_codes),
      ...stringList(topClosure?.reason_codes),
    ]),
    top_closure_id: normalizeNonEmpty(board.top_closure_id ?? topClosure?.closure_id),
    selected_value_gate: normalizeReason(
      board.selected_value_gate ?? market?.selected_value_gate ?? topClosure?.value_gate,
    ),
    required_output_receipt: normalizeNonEmpty(
      board.required_output_receipt ?? market?.required_output_receipt ?? topClosure?.required_output_receipt,
    ),
    settlement_market_id: normalizeNonEmpty(board.settlement_market_id ?? market?.market_id),
    settlement_market_status: normalizeReason(board.settlement_market_status ?? market?.status),
    selected_hypothesis_id: normalizeNonEmpty(
      board.selected_hypothesis_id ?? market?.selected_hypothesis_id ?? topClosure?.hypothesis_id,
    ),
    selected_repair_class: normalizeReason(
      board.selected_repair_class ?? market?.selected_repair_class ?? topClosure?.repair_class,
    ),
    required_settlement_receipt: normalizeNonEmpty(
      board.required_settlement_receipt ?? market?.required_output_receipt,
    ),
    active_dedupe_key: normalizeNonEmpty(
      board.active_dedupe_key ?? market?.active_dedupe_key ?? topClosure?.dedupe_key,
    ),
    no_delta_budget_state: normalizeReason(board.no_delta_budget_state ?? noDeltaBudget?.state),
    no_delta_debt_count:
      normalizeNumber(board.no_delta_debt_count) ?? normalizeNumber(noDeltaBudget?.used_attempts) ?? noDeltaDebt.length,
    next_allowed_attempt_after: normalizeNonEmpty(
      board.next_allowed_attempt_after ?? pendingReceipt?.next_allowed_attempt_after,
    ),
    max_notional: normalizeNonEmpty(board.max_notional ?? market?.max_notional ?? topClosure?.max_notional),
    capital_rule: normalizeReason(board.capital_rule ?? market?.capital_rule ?? topClosure?.capital_rule),
    release_conditions: uniqueStrings([
      ...stringValues(board.release_conditions),
      ...stringValues(noDeltaBudget?.release_conditions),
      ...noDeltaDebt.flatMap((debt) => stringValues(asRecord(debt)?.release_conditions)),
    ]),
    validation_commands: uniqueStrings([
      ...stringValues(board.validation_commands),
      ...stringValues(topClosure?.validation_commands),
      ...stringValues(pendingReceipt?.validation_commands),
    ]),
    rollback_target: normalizeNonEmpty(board.rollback_target ?? market?.rollback_target ?? topClosure?.rollback_target),
  }
}

export const readAlphaEvidenceFoundry = (
  payload: Record<string, unknown> | null,
): TorghutAlphaEvidenceFoundryRef | null => {
  const foundry = asRecord(payload?.alpha_evidence_foundry)
  if (!foundry) return null
  const schema = normalizeNonEmpty(foundry.schema_version)
  if (schema !== ALPHA_EVIDENCE_FOUNDRY_REF_SCHEMA_VERSION && schema !== ALPHA_EVIDENCE_FOUNDRY_SCHEMA_VERSION) {
    return null
  }

  const foundryId = normalizeNonEmpty(foundry.foundry_id)
  if (!foundryId) return null

  return {
    schema_version: schema,
    foundry_id: foundryId,
    generated_at: normalizeNonEmpty(foundry.generated_at),
    fresh_until: normalizeNonEmpty(foundry.fresh_until),
    status: normalizeReason(foundry.status),
    reason_codes: stringList(foundry.reason_codes),
    selected_queue_code: normalizeReason(foundry.selected_queue_code),
    selected_value_gate: normalizeReason(foundry.selected_value_gate),
    required_output_receipt: normalizeNonEmpty(foundry.required_output_receipt),
    receipt_count: normalizeNumber(foundry.receipt_count),
    selected_receipt_id: normalizeNonEmpty(foundry.selected_receipt_id),
    selected_hypothesis_id: normalizeNonEmpty(foundry.selected_hypothesis_id),
    hypothesis_ids: stringValues(foundry.hypothesis_ids),
    no_delta_debt_count: normalizeNumber(foundry.no_delta_debt_count),
    routeable_candidate_count_before: normalizeNumber(foundry.routeable_candidate_count_before),
    max_notional: normalizeNonEmpty(foundry.max_notional),
    capital_state: normalizeReason(foundry.capital_state),
    capital_rule: normalizeReason(foundry.capital_rule),
    rollback_target: normalizeNonEmpty(foundry.rollback_target),
  }
}
