import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  MaterialReentryImplementerDispatch,
  TorghutAlphaRepairClosureBoardRef,
  TorghutConsumerEvidenceStatus,
} from '~/data/agents-control-plane'

const ZERO_NOTIONAL_TEXT = new Set(['0', '0.0', '0.00', '0.0000'])
const AVAILABLE_NO_DELTA_STATES = new Set(['available', 'open', 'ready', 'remaining', 'unused'])
const HEALTHY_ALPHA_CLOSURE_STATUSES = new Set(['selected', 'current', 'ready'])

export type AlphaClosureRepairPlanParts = {
  requiredOutputReceipt: string | null
  validationCommands: string[]
  valueGates: string[]
  expectedGateDelta: string
  maxParallelism: number
  maxRuntimeSeconds: number
  maxNotional: number
  sourceHoldRefs: Array<string | null | undefined>
  evidenceRefs: Array<string | null | undefined>
  reasonCodes: string[]
  rollbackTarget: string
  implementerDispatch: MaterialReentryImplementerDispatch | null
}

const hashJson = (value: unknown, length = 18) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const stableKeyPart = (value: string | null | undefined, fallback = 'unknown') => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

const normalizeReason = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const parseFutureTime = (value: string | null | undefined, nowMs: number) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null
}

const isZeroNotional = (value: string | null | undefined) => {
  if (!value) return false
  if (ZERO_NOTIONAL_TEXT.has(value)) return true
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

const isTorghutRepairAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'dispatch_repair' || actionClass === 'torghut_observe'

const isCapitalAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'

const alphaClosureBoardReasons = (board: TorghutAlphaRepairClosureBoardRef, now: Date, valueGate: string) => {
  const reasons: string[] = []
  const status = normalizeReason(board.status)
  const noDeltaState = normalizeReason(board.no_delta_budget_state)
  const noDeltaDebtCount = board.no_delta_debt_count ?? 0

  if (!parseFutureTime(board.fresh_until, now.getTime())) reasons.push('alpha_closure_carry_stale')
  if (status && !HEALTHY_ALPHA_CLOSURE_STATUSES.has(status)) reasons.push(`alpha_closure_status_${status}`)
  if (valueGate !== 'routeable_candidate_count') reasons.push('alpha_closure_wrong_value_gate')
  if (!board.required_settlement_receipt && !board.required_output_receipt) {
    reasons.push('alpha_closure_settlement_receipt_missing')
  }
  if (!isZeroNotional(board.max_notional)) reasons.push('alpha_closure_notional_nonzero')
  if (board.capital_rule && normalizeReason(board.capital_rule) !== 'zero_notional_repair_only') {
    reasons.push('alpha_closure_capital_rule_not_zero_notional')
  }
  if (!board.active_dedupe_key) reasons.push('alpha_closure_active_dedupe_key_missing')
  if (!noDeltaState) {
    reasons.push('alpha_closure_no_delta_budget_missing')
  } else if (noDeltaState === 'consumed') {
    reasons.push('alpha_closure_no_delta_budget_consumed')
  } else if (!AVAILABLE_NO_DELTA_STATES.has(noDeltaState)) {
    reasons.push(`alpha_closure_no_delta_budget_${noDeltaState}`)
  }
  if (noDeltaDebtCount > 0) reasons.push('alpha_closure_no_delta_debt_active')

  return uniqueStrings([...reasons, ...board.reason_codes])
}

const topTorghutValueGate = (torghut: TorghutConsumerEvidenceStatus) =>
  torghut.alpha_readiness_strike_ledger?.selected_business_blocker?.value_gate ?? null

const topTorghutRequiredOutput = (torghut: TorghutConsumerEvidenceStatus) =>
  torghut.alpha_readiness_strike_ledger?.selected_business_blocker?.required_output_receipt ?? null

const torghutAlphaClosureRepairLane = (input: {
  actionClass: ActionSloBudgetActionClass
  board: TorghutAlphaRepairClosureBoardRef
  requiredOutputReceipt: string | null
  valueGate: string
}) => ({
  source: 'torghut.alpha-closure-repair',
  actionClass: input.actionClass,
  repairClass: stableKeyPart(input.board.selected_repair_class),
  hypothesisId: stableKeyPart(input.board.selected_hypothesis_id),
  activeDedupeKey: stableKeyPart(input.board.active_dedupe_key),
  valueGate: stableKeyPart(input.valueGate),
  requiredOutputReceipt: stableKeyPart(input.requiredOutputReceipt),
})

const buildTorghutAlphaClosureImplementerDispatch = (input: {
  actionClass: ActionSloBudgetActionClass
  board: TorghutAlphaRepairClosureBoardRef
  requiredOutputReceipt: string | null
  validationCommands: string[]
  valueGate: string
  maxRuntimeSeconds: number
  rollbackTarget: string
  reasonCodes: string[]
}): MaterialReentryImplementerDispatch | null => {
  if (!isTorghutRepairAction(input.actionClass)) return null
  if (input.reasonCodes.length > 0) return null

  const laneHash = hashJson(
    torghutAlphaClosureRepairLane({
      actionClass: input.actionClass,
      board: input.board,
      requiredOutputReceipt: input.requiredOutputReceipt,
      valueGate: input.valueGate,
    }),
    12,
  )
  const signalName = `material-reentry-torghut-alpha-closure-${laneHash}`
  const dedupeKey = `material-reentry:torghut-alpha-closure:${laneHash}:${input.valueGate}`
  const description =
    `Implement Torghut zero-notional alpha-closure settlement for ${input.valueGate}; ` +
    'produce the settlement receipt and keep live capital disabled.'

  return {
    schema_version: 'jangar.material-reentry-implementer-dispatch.v1',
    dispatch_kind: 'swarm_requirement_signal',
    source_swarm: 'jangar-control-plane',
    target_swarm: 'torghut-quant',
    target_stage: 'implement',
    target_role: 'engineer',
    signal_name: signalName,
    channel: 'workflow.general.requirement',
    description,
    priority: 'critical',
    dedupe_key: dedupeKey,
    payload: {
      type: 'material_reentry_requirement',
      source: 'jangar.material_reentry_clearinghouse',
      source_receipt_id: input.board.board_id,
      board_id: input.board.board_id,
      settlement_market_id: input.board.settlement_market_id,
      top_closure_id: input.board.top_closure_id,
      repair_class: input.board.selected_repair_class,
      hypothesis_id: input.board.selected_hypothesis_id,
      target_value_gate: input.valueGate,
      value_gates: [input.valueGate],
      required_output_receipt: input.requiredOutputReceipt,
      validation_commands: input.validationCommands,
      no_delta_budget_state: input.board.no_delta_budget_state,
      no_delta_debt_count: input.board.no_delta_debt_count,
      next_allowed_attempt_after: input.board.next_allowed_attempt_after,
      release_conditions: input.board.release_conditions,
      max_notional: 0,
      max_runtime_seconds: input.maxRuntimeSeconds,
      business_metric: input.valueGate,
      acceptance: [
        `settle ${input.valueGate} by producing ${input.requiredOutputReceipt ?? 'the required alpha closure receipt'}`,
        'keep Torghut max_notional=0 and live submit disabled during repair',
        'do not request automatic Codex review or post @codex review',
      ],
      review_policy: 'no_automatic_codex_review',
      no_codex_review: true,
      rollback_target: input.rollbackTarget,
    },
  }
}

export const buildTorghutAlphaClosureRepairPlanParts = (input: {
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  actionClass: ActionSloBudgetActionClass
  board: TorghutAlphaRepairClosureBoardRef
  now: Date
  defaultMaxRuntimeSeconds: number
}): AlphaClosureRepairPlanParts => {
  const foundry = input.torghutConsumerEvidence.alpha_evidence_foundry
  const valueGate =
    input.board.selected_value_gate ??
    foundry?.selected_value_gate ??
    topTorghutValueGate(input.torghutConsumerEvidence) ??
    'routeable_candidate_count'
  const requiredOutputReceipt =
    input.board.required_settlement_receipt ??
    input.board.required_output_receipt ??
    foundry?.required_output_receipt ??
    topTorghutRequiredOutput(input.torghutConsumerEvidence) ??
    null
  const validationCommands = uniqueStrings([
    ...input.board.validation_commands,
    "curl -fsS http://torghut.torghut.svc.cluster.local/trading/consumer-evidence | jq '.alpha_repair_closure_board'",
    "curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.alpha_repair_closure_board.alpha_closure_settlement_market'",
  ])
  const maxRuntimeSeconds = isTorghutRepairAction(input.actionClass) ? input.defaultMaxRuntimeSeconds : 0
  const rollbackTarget =
    input.board.rollback_target ??
    foundry?.rollback_target ??
    'disable alpha repair closure board emission and keep Torghut max_notional=0'
  const reasonCodes = uniqueStrings([
    ...alphaClosureBoardReasons(input.board, input.now, valueGate),
    ...(isCapitalAction(input.actionClass) ? ['torghut_alpha_closure_blocks_capital_reentry'] : []),
  ])
  const allowLaunch = isTorghutRepairAction(input.actionClass) && reasonCodes.length === 0

  return {
    requiredOutputReceipt,
    validationCommands,
    valueGates: [valueGate],
    expectedGateDelta: 'increase_routeable_candidate_count_or_record_alpha_closure_no_delta',
    maxParallelism: allowLaunch ? 1 : 0,
    maxRuntimeSeconds,
    maxNotional: 0,
    sourceHoldRefs: [
      input.board.board_id,
      input.board.settlement_market_id,
      input.board.active_dedupe_key,
      foundry?.foundry_id,
    ],
    evidenceRefs: [
      input.torghutConsumerEvidence.receipt_id,
      input.board.board_id,
      input.board.settlement_market_id,
      foundry?.foundry_id,
    ],
    reasonCodes,
    rollbackTarget,
    implementerDispatch: buildTorghutAlphaClosureImplementerDispatch({
      actionClass: input.actionClass,
      board: input.board,
      requiredOutputReceipt,
      validationCommands,
      valueGate,
      maxRuntimeSeconds,
      rollbackTarget,
      reasonCodes,
    }),
  }
}
