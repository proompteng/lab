import type { TorghutRepairOutcomeEscrow } from '~/data/agents-control-plane'
import {
  normalizeNonEmpty,
  normalizeReason,
  stringList,
  stringValues,
  uniqueStrings,
} from '~/server/control-plane-torghut-evidence-normalizers'
import { asRecord } from '~/server/primitives-http'

export const REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION = 'torghut.repair-outcome-dividend-ledger.v1'

export type TorghutRepairOutcomeEvidence = {
  present: boolean
  ledgerId: string | null
  receiptIds: string[]
  openEscrowIds: string[]
  noDeltaLotIds: string[]
  retiredReasonCodes: string[]
  preservedReasonCodes: string[]
  escrows: TorghutRepairOutcomeEscrow[]
  contractSchemaMismatch: string | null
}

const normalizeRepairOutcomeTerminalState = (value: unknown): TorghutRepairOutcomeEscrow['terminal_state'] => {
  const normalized = normalizeReason(value)
  if (
    normalized === 'succeeded' ||
    normalized === 'failed' ||
    normalized === 'timed_out' ||
    normalized === 'superseded'
  ) {
    return normalized
  }
  if (normalized === 'complete' || normalized === 'completed' || normalized === 'success') return 'succeeded'
  if (normalized === 'timeout') return 'timed_out'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'superseded'
  return 'pending'
}

const normalizeRepairOutcome = (value: unknown): TorghutRepairOutcomeEscrow['outcome'] => {
  const normalized = normalizeReason(value)
  if (
    normalized === 'retired_reason_codes' ||
    normalized === 'no_delta' ||
    normalized === 'degraded' ||
    normalized === 'invalid_receipt'
  ) {
    return normalized
  }
  return 'pending'
}

const normalizeRepairOutcomeNextAction = (value: unknown): TorghutRepairOutcomeEscrow['next_action'] => {
  const normalized = normalizeReason(value)
  if (normalized === 'release_credit' || normalized === 'burn_credit' || normalized === 'roll_forward') {
    return normalized
  }
  return 'hold'
}

const normalizeRepairOutcomeEscrow = (value: unknown): TorghutRepairOutcomeEscrow | null => {
  const escrow = asRecord(value)
  const escrowId = normalizeNonEmpty(escrow?.escrow_id)
  if (!escrow || !escrowId) return null
  return {
    escrow_id: escrowId,
    dispatch_ticket_id: normalizeNonEmpty(escrow.dispatch_ticket_id),
    repair_lot_id: normalizeNonEmpty(escrow.repair_lot_id),
    expected_output_receipt: normalizeNonEmpty(escrow.expected_output_receipt),
    expected_reason_code_delta: stringList(escrow.expected_reason_code_delta),
    launched_agentrun_ref: normalizeNonEmpty(escrow.launched_agentrun_ref),
    terminal_state: normalizeRepairOutcomeTerminalState(escrow.terminal_state),
    outcome: normalizeRepairOutcome(escrow.outcome),
    retired_reason_codes: stringList(escrow.retired_reason_codes),
    preserved_reason_codes: stringList(escrow.preserved_reason_codes),
    next_action: normalizeRepairOutcomeNextAction(escrow.next_action),
  }
}

export const readTorghutRepairOutcomeEvidence = (payload: Record<string, unknown>): TorghutRepairOutcomeEvidence => {
  const ledger = asRecord(payload.repair_outcome_dividend_ledger)
  const schema = normalizeNonEmpty(ledger?.schema_version)
  const receipts = Array.isArray(ledger?.outcome_receipts)
    ? ledger.outcome_receipts
        .map((receipt) => asRecord(receipt))
        .filter((receipt): receipt is Record<string, unknown> => Boolean(receipt))
    : []
  const escrows = Array.isArray(ledger?.open_escrows)
    ? ledger.open_escrows
        .map((escrow) => normalizeRepairOutcomeEscrow(escrow))
        .filter((escrow): escrow is TorghutRepairOutcomeEscrow => Boolean(escrow))
    : []
  return {
    present: Boolean(ledger),
    ledgerId: normalizeNonEmpty(ledger?.ledger_id),
    receiptIds: uniqueStrings(receipts.map((receipt) => normalizeNonEmpty(receipt.receipt_id))),
    openEscrowIds: uniqueStrings(escrows.map((escrow) => escrow.escrow_id)),
    noDeltaLotIds: stringValues(ledger?.no_delta_lots),
    retiredReasonCodes: stringList(ledger?.retired_reason_codes),
    preservedReasonCodes: stringList(ledger?.preserved_reason_codes),
    escrows,
    contractSchemaMismatch:
      ledger && schema && schema !== REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION
        ? `repair_outcome_dividend_ledger:${schema}`
        : null,
  }
}
