import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  RepairBidAdmissionDecision,
  RepairBidAdmissionReceipt,
  RepairBidAdmissionState,
  RepairLotDispatchTicket,
  TorghutAlphaReadinessStrikeLedger,
  TorghutAlphaReadinessStrikeSlot,
  TorghutRepairBidSettlementLot,
} from '~/server/control-plane-status-types'
import type { TorghutConsumerEvidenceStatus } from '~/server/control-plane-torghut-consumer-evidence'

export const REPAIR_BID_ADMISSION_DESIGN_ARTIFACT =
  'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md'

const DEFAULT_REPOSITORY = 'proompteng/lab'
const DEFAULT_BRANCH = 'main'
const DEFAULT_SWARM_NAME = 'torghut-quant'
const DEFAULT_STAGE = 'implement'
const DEFAULT_FRESHNESS_SECONDS = 60
const DEFAULT_MAX_RUNTIME_SECONDS = 20 * 60
const ZERO_NOTIONAL_TEXT = new Set(['0', '0.0', '0.00', '0.0000'])
const ALPHA_STRIKE_RECEIPT = 'torghut.promotion-custody-decision-receipt.v1'
const REQUIRED_ALPHA_STRIKE_GUARDED_ACTION_CLASSES = new Set<ActionSloBudgetActionClass>([
  'paper_canary',
  'live_micro_canary',
  'live_scale',
])

const ACTION_CLASSES: ActionSloBudgetActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
]

const MATERIAL_ACTION_CLASSES = new Set<ActionSloBudgetActionClass>([
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
])

export type RepairBidAdmissionInput = {
  now: Date
  namespace: string
  repository?: string | null
  branch?: string | null
  swarmName?: string | null
  stage?: string | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}

export const buildDefaultRepairBidAdmissionState = (
  now: Date,
  namespace: string,
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus,
) =>
  buildRepairBidAdmissionState({
    now,
    namespace,
    torghutConsumerEvidence,
    repository: process.env.CODEX_REPOSITORY ?? process.env.CODEX_REPO_SLUG,
    branch: process.env.CODEX_BRANCH,
    swarmName: process.env.SWARM_NAME,
    stage: process.env.SWARM_STAGE ?? process.env.CODEX_STAGE,
  })

const hashJson = (value: unknown, length = 18) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const normalizeNonEmpty = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
  return normalized.length > 0 ? normalized : null
}

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const normalizeNumber = (value: unknown, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : fallback
}

const isZeroNotional = (value: unknown) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return false
  if (ZERO_NOTIONAL_TEXT.has(normalized)) return true
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed === 0
}

const isLotSelected = (lot: TorghutRepairBidSettlementLot, selectedLotIds: Set<string>) =>
  selectedLotIds.has(lot.lot_id) || lot.state === 'selected'

const isLotDispatchable = (lot: TorghutRepairBidSettlementLot, dispatchableLotIds: Set<string>) =>
  dispatchableLotIds.has(lot.lot_id) || lot.dispatchable === true

const isProfitFreshnessRepairLot = (lot: TorghutRepairBidSettlementLot) =>
  lot.lot_id.startsWith('profit-freshness-repair-lot:') &&
  lot.target_value_gate === 'zero_notional_or_stale_evidence_rate'

const uniqueLots = (lots: TorghutRepairBidSettlementLot[]) => {
  const result: TorghutRepairBidSettlementLot[] = []
  const seen = new Set<string>()
  for (const lot of lots) {
    if (seen.has(lot.lot_id)) continue
    seen.add(lot.lot_id)
    result.push(lot)
  }
  return result
}

const alphaStrikeFresh = (ledger: TorghutAlphaReadinessStrikeLedger, now: Date) => {
  const parsed = parseTimestampMs(ledger.fresh_until)
  return Boolean(parsed && parsed > now.getTime())
}

const alphaStrikeSlot = (
  ledger: TorghutAlphaReadinessStrikeLedger | null | undefined,
  now: Date,
): TorghutAlphaReadinessStrikeSlot | null => {
  if (!ledger) return null
  const topGate = ledger.selected_business_blocker?.value_gate
  if (topGate !== 'routeable_candidate_count') return null
  if (ledger.status !== 'dispatchable') return null
  if (!alphaStrikeFresh(ledger, now)) return null
  if (!isZeroNotional(ledger.max_notional)) return null
  if (!ledger.rollback_target) return null
  const guardedActions = new Set(ledger.guarded_action_classes)
  if (![...REQUIRED_ALPHA_STRIKE_GUARDED_ACTION_CLASSES].every((actionClass) => guardedActions.has(actionClass))) {
    return null
  }
  return (
    ledger.strike_slots.find(
      (slot) =>
        slot.lot_class === 'promotion_custody' &&
        slot.target_value_gate === 'routeable_candidate_count' &&
        slot.state === 'dispatchable' &&
        slot.required_output_receipt === ALPHA_STRIKE_RECEIPT &&
        isZeroNotional(slot.max_notional),
    ) ?? null
  )
}

const lotForAlphaStrike = (
  ledger: TorghutAlphaReadinessStrikeLedger,
  slot: TorghutAlphaReadinessStrikeSlot,
): TorghutRepairBidSettlementLot => ({
  lot_id: slot.lot_id ?? slot.slot_id,
  lot_class: 'promotion_custody',
  target_value_gate: 'routeable_candidate_count',
  priority: 98,
  expected_gate_delta: 'retire_hypothesis_not_promotion_eligible',
  raw_reason_codes: uniqueStrings([
    ledger.selected_business_blocker?.reason,
    ...ledger.reason_codes,
    ...slot.hold_reason_codes,
  ]),
  root_cause_hypothesis: 'revenue repair ranked alpha readiness as the top routeable-candidate blocker',
  required_input_refs: uniqueStrings([
    ledger.ledger_id,
    ledger.revenue_repair_digest_ref,
    ledger.promotion_custody_lot_ref,
  ]),
  required_output_receipt: ALPHA_STRIKE_RECEIPT,
  required_output_receipt_count: 1,
  validation_commands: ['pytest services/torghut/tests/test_repair_bid_settlement.py -k promotion_custody'],
  dedupe_key: slot.dedupe_key,
  ttl_seconds: slot.ttl_seconds,
  max_runtime_seconds: slot.max_runtime_seconds,
  max_parallelism: 1,
  max_notional: '0',
  state: 'selected',
  dispatchable: true,
  hold_reason_codes: [],
  source_bid_ids: slot.source_repair_bid_ids,
})

const lotDeniedReasons = (input: {
  lot: TorghutRepairBidSettlementLot
  ledgerCurrent: boolean
  activeDedupeKeys: Set<string>
}) => {
  const reasons: string[] = []
  if (!input.ledgerCurrent) reasons.push('torghut_repair_bid_settlement_not_current')
  if (!isZeroNotional(input.lot.max_notional)) reasons.push('repair_lot_notional_nonzero')
  if (!input.lot.dedupe_key) reasons.push('repair_lot_dedupe_key_missing')
  if (input.lot.dedupe_key && input.activeDedupeKeys.has(input.lot.dedupe_key)) {
    reasons.push('repair_lot_dedupe_key_active')
  }
  if (!input.lot.target_value_gate) reasons.push('repair_lot_value_gate_missing')
  if (!input.lot.required_output_receipt) reasons.push('repair_lot_output_receipt_missing')
  if (input.lot.required_output_receipt_count !== 1) reasons.push('repair_lot_output_receipt_count_invalid')
  if (input.lot.hold_reason_codes.length > 0) reasons.push(...input.lot.hold_reason_codes)
  return uniqueStrings(reasons)
}

const launchReason = (deniedReasons: string[]) =>
  deniedReasons.length === 0 ? 'current_zero_notional_compacted_lot' : deniedReasons.join(',')

const buildDispatchTicket = (input: {
  receiptId: string
  lot: TorghutRepairBidSettlementLot
  deniedReasons: string[]
}): RepairLotDispatchTicket => {
  const maxRuntimeSeconds = normalizeNumber(input.lot.max_runtime_seconds, DEFAULT_MAX_RUNTIME_SECONDS)
  const launchAllowed = input.deniedReasons.length === 0
  return {
    schema_version: 'jangar.repair-lot-dispatch-ticket.v1',
    ticket_id: `repair-lot-dispatch-ticket:${hashJson({
      receipt_id: input.receiptId,
      lot_id: input.lot.lot_id,
      launch_allowed: launchAllowed,
      denied_reasons: input.deniedReasons,
    })}`,
    admission_receipt_id: input.receiptId,
    torghut_lot_id: input.lot.lot_id,
    lot_class: input.lot.lot_class,
    target_value_gate: input.lot.target_value_gate,
    dedupe_key: input.lot.dedupe_key ?? '',
    required_output_receipt: input.lot.required_output_receipt ?? '',
    launch_allowed: launchAllowed,
    launch_reason: launchReason(input.deniedReasons),
    stop_conditions: uniqueStrings([
      'fresh_until_expired',
      'dedupe_key_became_active',
      'required_output_receipt_malformed',
      ...input.deniedReasons,
    ]),
    max_runtime_seconds: maxRuntimeSeconds,
    max_notional: 0,
    expected_gate_delta: input.lot.expected_gate_delta,
    rollback_target: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
  }
}

const decisionForAction = (input: {
  actionClass: ActionSloBudgetActionClass
  ledgerCurrent: boolean
  ledgerCapitalDecision: string | null
  hasAdmittedTickets: boolean
  hasUnsettledLots: boolean
  baseReasons: string[]
}) => {
  const actionClass = input.actionClass
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') {
    return { decision: 'allow' as RepairBidAdmissionDecision, deniedReasons: [] }
  }

  if (actionClass === 'dispatch_repair') {
    if (input.ledgerCurrent && input.hasAdmittedTickets) {
      return { decision: 'allow' as RepairBidAdmissionDecision, deniedReasons: [] }
    }
    return {
      decision: 'hold' as RepairBidAdmissionDecision,
      deniedReasons: uniqueStrings([
        ...input.baseReasons,
        input.ledgerCurrent ? 'no_admissible_compacted_repair_lot' : 'torghut_repair_bid_settlement_not_current',
      ]),
    }
  }

  if (MATERIAL_ACTION_CLASSES.has(actionClass)) {
    const materialReasons = uniqueStrings([
      ...input.baseReasons,
      ...(input.hasUnsettledLots ? ['torghut_repair_lots_unsettled'] : []),
      ...(input.ledgerCapitalDecision === 'repair_only' ? ['torghut_repair_bid_settlement_repair_only'] : []),
    ])
    if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') {
      return {
        decision: materialReasons.length > 0 ? 'block' : ('allow' as RepairBidAdmissionDecision),
        deniedReasons: materialReasons,
      }
    }
    return {
      decision: materialReasons.length > 0 ? 'hold' : ('allow' as RepairBidAdmissionDecision),
      deniedReasons: materialReasons,
    }
  }

  return { decision: 'hold' as RepairBidAdmissionDecision, deniedReasons: input.baseReasons }
}

const freshUntilFor = (input: { now: Date; ledgerFreshUntil: string | null }) => {
  const parsed = parseTimestampMs(input.ledgerFreshUntil)
  if (parsed && parsed > input.now.getTime()) return new Date(parsed).toISOString()
  return new Date(input.now.getTime() + DEFAULT_FRESHNESS_SECONDS * 1000).toISOString()
}

export const buildRepairBidAdmissionState = (input: RepairBidAdmissionInput): RepairBidAdmissionState => {
  const torghut = input.torghutConsumerEvidence
  const generatedAt = input.now.toISOString()
  const freshUntil = freshUntilFor({
    now: input.now,
    ledgerFreshUntil: torghut.repair_bid_settlement_fresh_until ?? null,
  })
  const ledgerStatus = torghut.repair_bid_settlement_status ?? 'missing'
  const ledgerFreshUntilMs = parseTimestampMs(torghut.repair_bid_settlement_fresh_until ?? null)
  const ledgerCurrent =
    ledgerStatus === 'current' && Boolean(ledgerFreshUntilMs && ledgerFreshUntilMs > input.now.getTime())
  const activeDedupeKeys = new Set(torghut.repair_bid_settlement_active_dedupe_keys ?? [])
  const selectedLotIds = new Set(torghut.repair_bid_settlement_selected_lot_ids ?? [])
  const dispatchableLotIds = new Set(torghut.repair_bid_settlement_dispatchable_lot_ids ?? [])
  const compactedLots = torghut.repair_bid_settlement_compacted_lots ?? []
  const selectedLots = compactedLots.filter((lot) => isLotSelected(lot, selectedLotIds))
  const dispatchableSelectedLots = selectedLots.filter((lot) => isLotDispatchable(lot, dispatchableLotIds))
  const profitFreshnessTicketLots = dispatchableSelectedLots.filter(isProfitFreshnessRepairLot)
  const strikeSlot = alphaStrikeSlot(torghut.alpha_readiness_strike_ledger, input.now)
  const strikeLot =
    strikeSlot && torghut.alpha_readiness_strike_ledger
      ? lotForAlphaStrike(torghut.alpha_readiness_strike_ledger, strikeSlot)
      : null
  const alphaStrikeRequired =
    torghut.alpha_readiness_strike_ledger?.selected_business_blocker?.value_gate === 'routeable_candidate_count'
  const ticketLots = strikeLot
    ? uniqueLots([strikeLot, ...profitFreshnessTicketLots])
    : alphaStrikeRequired
      ? profitFreshnessTicketLots
      : dispatchableSelectedLots
  const receiptLotRefs = uniqueStrings([
    ...(strikeLot ? [strikeLot.lot_id] : []),
    ...selectedLots.map((lot) => lot.lot_id),
  ])
  const ledgerMaxNotional = torghut.repair_bid_settlement_max_notional
  const baseReasons = uniqueStrings([
    ...(ledgerCurrent ? [] : [`torghut_repair_bid_settlement_${ledgerStatus}`]),
    ...(ledgerMaxNotional && !isZeroNotional(ledgerMaxNotional)
      ? ['torghut_repair_bid_settlement_notional_nonzero']
      : []),
    ...(torghut.repair_bid_settlement_reason_codes ?? []),
    ...(alphaStrikeRequired && !strikeLot
      ? ['alpha_readiness_strike_unavailable', ...(torghut.alpha_readiness_strike_ledger?.reason_codes ?? [])]
      : []),
  ])
  const repository = normalizeNonEmpty(input.repository) ?? DEFAULT_REPOSITORY
  const branch = normalizeNonEmpty(input.branch) ?? DEFAULT_BRANCH
  const swarmName = normalizeNonEmpty(input.swarmName) ?? DEFAULT_SWARM_NAME
  const stage = normalizeNonEmpty(input.stage) ?? DEFAULT_STAGE
  const receiptBase = {
    generated_at: generatedAt,
    repository,
    branch,
    swarm_name: swarmName,
    stage,
    torghut_settlement_ledger_ref: torghut.repair_bid_settlement_ledger_id ?? null,
  }

  const firstReceiptId = `repair-bid-admission:${hashJson({
    ...receiptBase,
    action_class: 'dispatch_repair',
    selected_lot_ids: selectedLots.map((lot) => lot.lot_id),
    base_reasons: baseReasons,
  })}`
  const tickets = ticketLots.map((lot) =>
    buildDispatchTicket({
      receiptId: firstReceiptId,
      lot,
      deniedReasons: lotDeniedReasons({ lot, ledgerCurrent, activeDedupeKeys }),
    }),
  )
  const admittedLotIds = tickets.filter((ticket) => ticket.launch_allowed).map((ticket) => ticket.torghut_lot_id)
  const heldLotIds = uniqueStrings([
    ...(torghut.repair_bid_settlement_held_lot_ids ?? []),
    ...tickets.filter((ticket) => !ticket.launch_allowed).map((ticket) => ticket.torghut_lot_id),
  ])
  const hasUnsettledLots = selectedLots.length > 0 || heldLotIds.length > 0
  const hasAdmittedTickets = admittedLotIds.length > 0
  const validationCommands = uniqueStrings(
    tickets.flatMap((ticket) => {
      const lot = ticketLots.find((entry) => entry.lot_id === ticket.torghut_lot_id)
      return lot?.validation_commands ?? []
    }),
  )

  const receipts: RepairBidAdmissionReceipt[] = ACTION_CLASSES.map((actionClass) => {
    const actionDecision = decisionForAction({
      actionClass,
      ledgerCurrent,
      ledgerCapitalDecision: torghut.repair_bid_settlement_capital_decision ?? null,
      hasAdmittedTickets,
      hasUnsettledLots,
      baseReasons,
    })
    const receiptId =
      actionClass === 'dispatch_repair'
        ? firstReceiptId
        : `repair-bid-admission:${hashJson({
            ...receiptBase,
            action_class: actionClass,
            decision: actionDecision.decision,
            reasons: actionDecision.deniedReasons,
          })}`
    return {
      schema_version: 'jangar.repair-bid-admission-receipt.v1',
      receipt_id: receiptId,
      generated_at: generatedAt,
      fresh_until: freshUntil,
      repository,
      branch,
      swarm_name: swarmName,
      stage,
      action_class: actionClass,
      decision: actionDecision.decision,
      torghut_settlement_ledger_ref: torghut.repair_bid_settlement_ledger_id ?? null,
      torghut_compacted_lot_refs: receiptLotRefs,
      active_dedupe_keys: [...activeDedupeKeys].sort(),
      admitted_lot_ids: actionClass === 'dispatch_repair' ? admittedLotIds : [],
      held_lot_ids: heldLotIds,
      denied_reason_codes: actionDecision.deniedReasons,
      max_parallelism: actionClass === 'dispatch_repair' ? admittedLotIds.length : 0,
      max_runtime_seconds:
        actionClass === 'dispatch_repair' && admittedLotIds.length > 0
          ? Math.max(...tickets.filter((ticket) => ticket.launch_allowed).map((ticket) => ticket.max_runtime_seconds))
          : 0,
      max_notional: 0,
      validation_commands: actionClass === 'dispatch_repair' ? validationCommands : [],
      rollback_gate: 'disable repair-bid admission enforcement and keep Torghut max_notional=0',
    }
  })
  const status = receipts.some((receipt) => receipt.decision === 'block')
    ? 'block'
    : receipts.some((receipt) => receipt.decision === 'hold')
      ? 'hold'
      : receipts.some((receipt) => receipt.decision === 'repair_only')
        ? 'repair_only'
        : 'allow'

  return {
    schema_version: 'jangar.repair-bid-admission-state.v1',
    mode: 'observe',
    design_artifact: REPAIR_BID_ADMISSION_DESIGN_ARTIFACT,
    generated_at: generatedAt,
    fresh_until: freshUntil,
    status,
    torghut_settlement_ledger_ref: torghut.repair_bid_settlement_ledger_id ?? null,
    receipts,
    dispatch_tickets: tickets,
    admitted_lot_ids: admittedLotIds,
    held_lot_ids: heldLotIds,
    active_dedupe_keys: [...activeDedupeKeys].sort(),
    reason_codes: uniqueStrings(receipts.flatMap((receipt) => receipt.denied_reason_codes)),
    rollback_target: 'disable repair-bid admission enforcement and fall back to route-evidence clearinghouse summaries',
  }
}
