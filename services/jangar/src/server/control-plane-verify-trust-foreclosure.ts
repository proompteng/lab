import { createHash } from 'node:crypto'
import process from 'node:process'

import type {
  ActionSloBudgetActionClass,
  AlphaRepairReentryAdmission,
  AlphaRepairReentryAdmissionDecision,
  AlphaRepairReentryReleaseKeyState,
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  ReadyTruthArbiterMode,
  ReadyTruthServingReadiness,
  RevenueRepairSettlementCustody,
  RouteStabilityEscrow,
  SourceServingContractVerdictExchange,
  TorghutConsumerEvidenceStatus,
  VerifyTrustForeclosureActionDecision,
  VerifyTrustForeclosureBoard,
  VerifyTrustForeclosureTicket,
} from '~/server/control-plane-status-types'
import type { ControlPlaneRolloutHealth, DatabaseStatus } from '~/server/control-plane-status-types'

export const VERIFY_TRUST_FORECLOSURE_DESIGN_ARTIFACT =
  'docs/agents/designs/201-jangar-verify-trust-foreclosure-and-alpha-repair-reentry-2026-05-14.md'

const TORGHUT_NO_DELTA_REENTRY_DESIGN_ARTIFACT =
  'docs/torghut/design-system/v6/206-torghut-no-delta-repair-reentry-auction-and-verification-carry-2026-05-14.md'

const SCHEMA_VERSION = 'jangar.verify-trust-foreclosure-board.v1' as const
const ADMISSION_SCHEMA_VERSION = 'jangar.alpha-repair-reentry-admission.v1' as const
const DEFAULT_TTL_SECONDS = 60
const FORECLOSURE_TICKET_TTL_SECONDS = 900
const FORECLOSURE_TICKET_MAX_RUNTIME_SECONDS = 20 * 60
const ROLLBACK_TARGET =
  'JANGAR_VERIFY_TRUST_FORECLOSURE_MODE=observe and keep ready truth plus revenue repair custody as authorities'
const ZERO_NOTIONAL_VALUES = new Set(['0', '0.0', '0.00', '0.0000'])

const MATERIAL_ACTION_CLASSES: ActionSloBudgetActionClass[] = [
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'paper_canary',
  'live_micro_canary',
  'live_scale',
]

export type VerifyTrustForeclosureInput = {
  now: Date
  namespace: string
  executionTrust: ExecutionTrustStatus
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  revenueRepairSettlementCustody: RevenueRepairSettlementCustody
  rolloutHealth: ControlPlaneRolloutHealth
  controllerWitness?: ControlPlaneControllerWitnessQuorum | null
  database?: DatabaseStatus | null
  routeStabilityEscrow?: RouteStabilityEscrow | null
  serviceHealth?: ReadyTruthServingReadiness | null
}

export const resolveVerifyTrustForeclosureMode = (env: NodeJS.ProcessEnv = process.env): ReadyTruthArbiterMode => {
  const normalized = env.JANGAR_VERIFY_TRUST_FORECLOSURE_MODE?.trim().toLowerCase()
  if (normalized === 'shadow' || normalized === 'hold' || normalized === 'enforce') return normalized
  return 'observe'
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeReason = (value: string | null | undefined) =>
  value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_') ?? null

const uniqueStrings = (values: Array<string | null | undefined>) => [...new Set(values.filter(Boolean) as string[])]

const parseTimestampMs = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const freshUntilFor = (input: VerifyTrustForeclosureInput) => {
  const times = [
    input.sourceServingContractVerdictExchange.fresh_until,
    input.torghutConsumerEvidence.fresh_until,
    input.torghutConsumerEvidence.alpha_repair_closure_board?.fresh_until,
    input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.fresh_until,
    input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor?.fresh_until,
    input.torghutConsumerEvidence.alpha_repair_dividend_ledger?.fresh_until,
    input.revenueRepairSettlementCustody.fresh_until,
    input.routeStabilityEscrow?.fresh_until,
    input.controllerWitness?.expires_at,
  ]
    .map((value) => parseTimestampMs(value))
    .filter((value): value is number => Boolean(value && value > input.now.getTime()))

  if (times.length > 0) return new Date(Math.min(...times)).toISOString()
  return addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString()
}

const executionTrustRef = (trust: ExecutionTrustStatus) =>
  `execution-trust:${trust.status}:${hashJson({
    evaluated_at: trust.last_evaluated_at,
    blocking_windows: trust.blocking_windows,
    evidence_summary: trust.evidence_summary,
  })}`

const isZeroNotional = (value: string | null | undefined) => {
  if (!value) return false
  if (ZERO_NOTIONAL_VALUES.has(value)) return true
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed === 0
}

const topRepairQueueItem = (status: TorghutConsumerEvidenceStatus) => status.revenue_repair_queue?.[0] ?? null

const topRepairQueueItemIsAlpha = (status: TorghutConsumerEvidenceStatus) => {
  const item = topRepairQueueItem(status)
  return item?.code === 'repair_alpha_readiness'
}

const alphaClosureBoard = (status: TorghutConsumerEvidenceStatus) => status.alpha_repair_closure_board ?? null

const noDeltaReentryAuction = (status: TorghutConsumerEvidenceStatus) => status.no_delta_repair_reentry_auction ?? null

const selectedValueGate = (status: TorghutConsumerEvidenceStatus) =>
  noDeltaReentryAuction(status)?.selected_value_gate ??
  alphaClosureBoard(status)?.selected_value_gate ??
  status.alpha_repair_dividend_ledger?.selected_value_gate ??
  status.alpha_readiness_settlement_conveyor?.selected_value_gate ??
  topRepairQueueItem(status)?.value_gate ??
  null

const selectedHypothesisId = (status: TorghutConsumerEvidenceStatus) =>
  noDeltaReentryAuction(status)?.selected_hypothesis_id ??
  alphaClosureBoard(status)?.selected_hypothesis_id ??
  status.alpha_repair_dividend_ledger?.selected_hypothesis_id ??
  status.alpha_readiness_settlement_conveyor?.selected_hypothesis_id ??
  null

const requiredOutputReceipt = (status: TorghutConsumerEvidenceStatus) =>
  noDeltaReentryAuction(status)?.required_output_receipt ??
  alphaClosureBoard(status)?.required_settlement_receipt ??
  alphaClosureBoard(status)?.required_output_receipt ??
  status.alpha_readiness_settlement_conveyor?.required_receipt ??
  topRepairQueueItem(status)?.required_output_receipt ??
  status.executable_alpha_repair_receipts?.selected_receipt?.required_output_receipts[0] ??
  null

const validationCommand = (status: TorghutConsumerEvidenceStatus) =>
  noDeltaReentryAuction(status)?.validation_command ??
  (noDeltaReentryAuction(status) ? `curl -fsS ${status.endpoint} | jq '.no_delta_repair_reentry_auction'` : null) ??
  alphaClosureBoard(status)?.validation_commands[0] ??
  (alphaClosureBoard(status) ? `curl -fsS ${status.endpoint} | jq '.alpha_repair_closure_board'` : null) ??
  status.alpha_repair_dividend_ledger?.validation_command ??
  status.alpha_readiness_settlement_conveyor?.validation_command ??
  status.executable_alpha_repair_receipts?.selected_receipt?.validation_commands[0] ??
  null

const alphaRollbackTarget = (status: TorghutConsumerEvidenceStatus) =>
  noDeltaReentryAuction(status)?.rollback_target ??
  alphaClosureBoard(status)?.rollback_target ??
  status.alpha_repair_dividend_ledger?.rollback_target ??
  status.alpha_readiness_settlement_conveyor?.rollback_target ??
  status.executable_alpha_repair_receipts?.selected_receipt?.rollback_target ??
  ROLLBACK_TARGET

const alphaClosureNoDeltaActive = (status: TorghutConsumerEvidenceStatus) => {
  const board = alphaClosureBoard(status)
  if (!board) return false
  const noDeltaState = normalizeReason(board.no_delta_budget_state)
  const marketStatus = normalizeReason(board.settlement_market_status)
  return (
    noDeltaState === 'consumed' ||
    marketStatus === 'pending_no_delta' ||
    marketStatus === 'no_delta' ||
    (board.no_delta_debt_count ?? 0) > 0
  )
}

const alphaClosureReleaseKey = (status: TorghutConsumerEvidenceStatus) => {
  const board = alphaClosureBoard(status)
  if (!board || !alphaClosureNoDeltaActive(status)) return null
  return board.active_dedupe_key ?? board.settlement_market_id ?? board.board_id
}

const activeNoDeltaReleaseKey = (status: TorghutConsumerEvidenceStatus) => {
  const auction = noDeltaReentryAuction(status)
  if (
    auction?.active_no_delta_release_key &&
    (auction.reentry_decision === 'deny' || auction.reason_codes.includes('active_no_delta_release_key'))
  ) {
    return auction.active_no_delta_release_key
  }

  const closureKey = alphaClosureReleaseKey(status)
  if (closureKey) return closureKey

  const dividend = status.alpha_repair_dividend_ledger ?? null
  const conveyor = status.alpha_readiness_settlement_conveyor ?? null
  const releaseKey = dividend?.no_delta_release_key ?? conveyor?.no_delta_release_key ?? null
  const dividendDeny = dividend?.launch_decision === 'deny'
  const conveyorDeny = conveyor?.repeat_launch_decision === 'deny' || (conveyor?.active_no_delta_lease_count ?? 0) > 0
  return dividendDeny || conveyorDeny ? releaseKey : null
}

const releaseKeyState = (status: TorghutConsumerEvidenceStatus): AlphaRepairReentryReleaseKeyState => {
  const auction = noDeltaReentryAuction(status)
  if (auction?.active_no_delta_release_key) {
    if (auction.reentry_decision === 'allow' || auction.selected_ticket_id) return 'changed'
    if (activeNoDeltaReleaseKey(status)) return 'active'
    return 'clear'
  }

  const dividend = status.alpha_repair_dividend_ledger ?? null
  const conveyor = status.alpha_readiness_settlement_conveyor ?? null
  if (activeNoDeltaReleaseKey(status)) return 'active'
  if (
    !(alphaClosureBoard(status)?.active_dedupe_key ?? dividend?.no_delta_release_key ?? conveyor?.no_delta_release_key)
  ) {
    return 'missing'
  }
  return 'clear'
}

const sourceRolloutTruthSplit = (exchange: SourceServingContractVerdictExchange) =>
  exchange.status === 'hold' ||
  exchange.status === 'block' ||
  exchange.held_action_classes.length > 0 ||
  exchange.blocked_action_classes.length > 0 ||
  exchange.reason_codes.length > 0

const sourceRolloutTruthState = (exchange: SourceServingContractVerdictExchange) => {
  const deployerVerdict =
    exchange.verdicts.find((verdict) => verdict.action_class === 'merge_ready') ??
    exchange.verdicts.find((verdict) => verdict.action_class === 'deploy_widen') ??
    exchange.verdicts[0] ??
    null
  return deployerVerdict?.source_serving_state ?? exchange.status
}

const debtClasses = (input: VerifyTrustForeclosureInput) => {
  const debts: string[] = []
  if (input.executionTrust.status !== 'healthy') {
    debts.push(`execution_trust_${input.executionTrust.status}`)
    debts.push('stage_trust_degraded')
    for (const window of input.executionTrust.blocking_windows) {
      const name = normalizeReason(window.name)
      if (name?.includes('verify')) debts.push('verify_trust_degraded')
      if (name?.includes('plan')) debts.push('plan_trust_degraded')
      if (name?.includes('implement')) debts.push('implement_trust_degraded')
      if (name?.includes('discover')) debts.push('discover_trust_degraded')
    }
  }
  if (sourceRolloutTruthSplit(input.sourceServingContractVerdictExchange)) debts.push('source_rollout_truth_split')
  if (!input.controllerWitness) {
    debts.push('controller_witness_unavailable_on_hot_path')
  } else if (input.controllerWitness.decision !== 'allow') {
    debts.push('controller_witness_stale')
  }
  if (!input.database) {
    debts.push('database_projection_unavailable_on_hot_path')
  } else if (input.database.status !== 'healthy' || input.database.migration_consistency.status !== 'healthy') {
    debts.push('database_projection_not_current')
  }
  if (input.routeStabilityEscrow && input.routeStabilityEscrow.route_stability_window.held_action_classes.length > 0) {
    debts.push('route_stability_hold')
  }
  if (input.torghutConsumerEvidence.status !== 'current') {
    debts.push(`torghut_consumer_evidence_${input.torghutConsumerEvidence.status}`)
  }
  if (
    input.torghutConsumerEvidence.revenue_repair_ready === false ||
    input.torghutConsumerEvidence.revenue_repair_business_state === 'repair_only'
  ) {
    debts.push('torghut_business_repair_only')
  }
  if (activeNoDeltaReleaseKey(input.torghutConsumerEvidence)) debts.push('torghut_no_delta_active')
  if (!isZeroNotional(input.torghutConsumerEvidence.max_notional)) debts.push('capital_gate_hold')
  if (input.revenueRepairSettlementCustody.decision !== 'allow') {
    debts.push(`revenue_repair_settlement_custody_${input.revenueRepairSettlementCustody.decision}`)
  }
  return uniqueStrings(debts)
}

const alphaClosureNoDeltaReasons = (status: TorghutConsumerEvidenceStatus) => {
  const board = alphaClosureBoard(status)
  if (!board || !alphaClosureNoDeltaActive(status)) return []
  const noDeltaState = normalizeReason(board.no_delta_budget_state)
  const marketStatus = normalizeReason(board.settlement_market_status)
  return uniqueStrings([
    noDeltaState === 'consumed' ? 'alpha_closure_no_delta_budget_consumed' : null,
    marketStatus === 'pending_no_delta' || marketStatus === 'no_delta'
      ? `alpha_closure_settlement_market_${marketStatus}`
      : null,
    (board.no_delta_debt_count ?? 0) > 0 ? 'alpha_closure_no_delta_debt_active' : null,
  ])
}

const noDeltaReentryAuctionReasons = (status: TorghutConsumerEvidenceStatus) => {
  const auction = noDeltaReentryAuction(status)
  if (!auction) return []

  return uniqueStrings([
    auction.reentry_decision === 'deny' ? 'no_delta_reentry_auction_denied' : null,
    auction.reentry_decision === 'hold' ? 'no_delta_reentry_auction_hold' : null,
    auction.reentry_decision === 'allow' ? null : `no_delta_reentry_decision_${auction.reentry_decision ?? 'missing'}`,
    auction.active_no_delta_release_key && auction.reentry_decision !== 'allow' ? 'active_no_delta_release_key' : null,
    auction.selected_ticket_id ? null : 'zero_notional_reentry_ticket_not_selected',
    isZeroNotional(auction.max_notional) ? null : 'capital_notional_nonzero',
    auction.capital_rule && auction.capital_rule !== 'zero_notional_repair_only'
      ? 'capital_rule_not_zero_notional_repair_only'
      : null,
    ...auction.reason_codes,
  ])
}

const alphaAdmissionReasons = (input: VerifyTrustForeclosureInput, debts: string[]) => {
  const status = input.torghutConsumerEvidence
  const reasons = [
    ...debts.filter((debt) =>
      [
        'controller_witness_stale',
        'database_projection_not_current',
        'execution_trust_blocked',
        'execution_trust_degraded',
        'plan_trust_degraded',
        'source_rollout_truth_split',
        'stage_trust_degraded',
        'torghut_consumer_evidence_stale',
        'torghut_consumer_evidence_missing',
        'torghut_consumer_evidence_unavailable',
        'torghut_no_delta_active',
        'verify_trust_degraded',
      ].includes(debt),
    ),
    releaseKeyState(status) === 'missing' ? 'no_delta_release_key_missing' : null,
    topRepairQueueItemIsAlpha(status) ? null : 'top_repair_queue_item_not_alpha_readiness',
    selectedValueGate(status) === 'routeable_candidate_count'
      ? null
      : `selected_value_gate_${selectedValueGate(status) ?? 'missing'}`,
    requiredOutputReceipt(status) ? null : 'required_output_receipt_missing',
    validationCommand(status) ? null : 'validation_command_missing',
    isZeroNotional(status.max_notional) ? null : 'capital_notional_nonzero',
    status.alpha_repair_dividend_ledger?.launch_decision === 'deny' ? 'alpha_repair_dividend_launch_denied' : null,
    status.alpha_readiness_settlement_conveyor?.repeat_launch_decision === 'deny'
      ? 'alpha_readiness_repeat_launch_denied'
      : null,
    ...noDeltaReentryAuctionReasons(status),
    ...alphaClosureNoDeltaReasons(status),
    input.revenueRepairSettlementCustody.decision === 'deny' ? 'revenue_repair_settlement_custody_deny' : null,
    input.revenueRepairSettlementCustody.decision === 'hold' ? 'revenue_repair_settlement_custody_hold' : null,
  ]
  return uniqueStrings(reasons).map((reason) => normalizeReason(reason) ?? reason)
}

const alphaAdmissionDecision = (reasons: string[]): AlphaRepairReentryAdmissionDecision => {
  if (
    reasons.some((reason) =>
      [
        'alpha_readiness_repeat_launch_denied',
        'alpha_repair_dividend_launch_denied',
        'alpha_closure_no_delta_budget_consumed',
        'alpha_closure_no_delta_debt_active',
        'capital_notional_nonzero',
        'duplicate_no_delta_reentry_denied',
        'no_delta_reentry_auction_denied',
        'revenue_repair_settlement_custody_deny',
        'torghut_no_delta_active',
        'zero_notional_reentry_ticket_not_selected',
      ].includes(reason),
    )
  ) {
    return 'deny'
  }
  return reasons.length > 0 ? 'hold' : 'allow'
}

const buildAlphaRepairReentryAdmission = (
  input: VerifyTrustForeclosureInput,
  debts: string[],
  mode: ReadyTruthArbiterMode,
): AlphaRepairReentryAdmission => {
  const reasons = alphaAdmissionReasons(input, debts)
  const decision = alphaAdmissionDecision(reasons)
  const releaseState = releaseKeyState(input.torghutConsumerEvidence)
  const validation = validationCommand(input.torghutConsumerEvidence)
  const rollback = alphaRollbackTarget(input.torghutConsumerEvidence)
  const admissionId = `alpha-repair-reentry-admission:${input.namespace}:${hashJson({
    selected_hypothesis_id: selectedHypothesisId(input.torghutConsumerEvidence),
    selected_value_gate: selectedValueGate(input.torghutConsumerEvidence),
    release_key_state: releaseState,
    decision,
    reasons,
  })}`

  return {
    schema_version: ADMISSION_SCHEMA_VERSION,
    mode,
    admission_id: admissionId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input),
    selected_value_gate: selectedValueGate(input.torghutConsumerEvidence),
    selected_hypothesis_id: selectedHypothesisId(input.torghutConsumerEvidence),
    release_key_state: releaseState,
    material_action_class: 'dispatch_repair',
    decision,
    reason_codes: reasons,
    required_output_receipt: requiredOutputReceipt(input.torghutConsumerEvidence),
    validation_command: validation,
    rollback_target: rollback,
  }
}

const ticketState = (debtClass: string): VerifyTrustForeclosureTicket['state'] =>
  debtClass === 'torghut_no_delta_active' ? 'denied' : 'open'

const ticketForDebt = (
  input: VerifyTrustForeclosureInput,
  debtClass: string,
  admission: AlphaRepairReentryAdmission,
): VerifyTrustForeclosureTicket => {
  const sourceRef =
    debtClass.startsWith('torghut') || debtClass.startsWith('revenue')
      ? (input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.auction_id ??
        input.torghutConsumerEvidence.alpha_repair_closure_board?.board_id ??
        input.torghutConsumerEvidence.alpha_repair_dividend_ledger?.ledger_id ??
        input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor?.conveyor_id ??
        input.torghutConsumerEvidence.receipt_id)
      : debtClass.includes('source')
        ? input.sourceServingContractVerdictExchange.exchange_id
        : debtClass.includes('controller')
          ? (input.controllerWitness?.quorum_id ?? null)
          : executionTrustRef(input.executionTrust)
  const dedupeKey = `${debtClass}:${activeNoDeltaReleaseKey(input.torghutConsumerEvidence) ?? sourceRef ?? input.namespace}`
  return {
    ticket_id: `verify-trust-foreclosure-ticket:${hashJson({
      namespace: input.namespace,
      debt_class: debtClass,
      source_ref: sourceRef,
      required_output_receipt: admission.required_output_receipt,
      dedupe_key: dedupeKey,
    })}`,
    debt_class: debtClass,
    source_ref: sourceRef,
    expected_delta:
      debtClass === 'torghut_no_delta_active'
        ? 'deny duplicate alpha repair until release condition changes'
        : `retire ${debtClass}`,
    required_output_receipt: admission.required_output_receipt,
    validation_commands: uniqueStrings([admission.validation_command]),
    max_runtime_seconds: FORECLOSURE_TICKET_MAX_RUNTIME_SECONDS,
    max_parallelism: 1,
    ttl_seconds: FORECLOSURE_TICKET_TTL_SECONDS,
    dedupe_key: dedupeKey,
    state: ticketState(debtClass),
  }
}

const actionDecisionFor = (
  actionClass: ActionSloBudgetActionClass,
  input: VerifyTrustForeclosureInput,
  debts: string[],
  admission: AlphaRepairReentryAdmission,
): VerifyTrustForeclosureActionDecision => {
  if (actionClass === 'serve_readonly') {
    const down = input.serviceHealth === 'down'
    return {
      action_class: actionClass,
      decision: down ? 'block' : 'allow',
      reason_codes: down ? ['serving_readiness_down'] : [],
      evidence_refs: [],
    }
  }
  if (actionClass === 'torghut_observe') {
    const current = input.torghutConsumerEvidence.status === 'current'
    return {
      action_class: actionClass,
      decision: current ? 'allow' : 'hold',
      reason_codes: current ? [] : [`torghut_consumer_evidence_${input.torghutConsumerEvidence.status}`],
      evidence_refs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
    }
  }
  if (actionClass === 'dispatch_repair') {
    return {
      action_class: actionClass,
      decision:
        admission.decision === 'deny' ? 'block' : admission.decision === 'allow' ? 'repair_only' : ('hold' as const),
      reason_codes: admission.reason_codes,
      evidence_refs: uniqueStrings([
        admission.admission_id,
        input.revenueRepairSettlementCustody.custody_id,
        input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.auction_id,
        input.torghutConsumerEvidence.alpha_repair_closure_board?.board_id,
        input.torghutConsumerEvidence.alpha_repair_dividend_ledger?.ledger_id,
        input.torghutConsumerEvidence.alpha_readiness_settlement_conveyor?.conveyor_id,
      ]),
    }
  }
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') {
    const reasons = uniqueStrings([
      ...(debts.includes('torghut_business_repair_only') ? ['torghut_business_repair_only'] : []),
      ...(debts.includes('capital_gate_hold') ? ['capital_gate_hold'] : []),
      ...(debts.includes('torghut_no_delta_active') ? ['torghut_no_delta_active'] : []),
    ])
    return {
      action_class: actionClass,
      decision: reasons.length > 0 ? 'block' : 'hold',
      reason_codes: reasons.length > 0 ? reasons : ['capital_gate_not_released'],
      evidence_refs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
    }
  }
  const mergeOrDeploy = actionClass === 'merge_ready' || actionClass === 'deploy_widen'
  const reasons = uniqueStrings([
    ...(input.executionTrust.status === 'healthy' ? [] : [`execution_trust_${input.executionTrust.status}`]),
    ...(sourceRolloutTruthSplit(input.sourceServingContractVerdictExchange) ? ['source_rollout_truth_split'] : []),
    ...(mergeOrDeploy && input.rolloutHealth.status !== 'healthy'
      ? [`rollout_health_${input.rolloutHealth.status}`]
      : []),
  ])
  return {
    action_class: actionClass,
    decision: reasons.length > 0 ? 'hold' : 'allow',
    reason_codes: reasons,
    evidence_refs: uniqueStrings([
      executionTrustRef(input.executionTrust),
      input.sourceServingContractVerdictExchange.exchange_id,
    ]),
  }
}

const actionDecisions = (input: VerifyTrustForeclosureInput, debts: string[], admission: AlphaRepairReentryAdmission) =>
  (['serve_readonly', 'torghut_observe', ...MATERIAL_ACTION_CLASSES] as ActionSloBudgetActionClass[]).map(
    (actionClass) => actionDecisionFor(actionClass, input, debts, admission),
  )

export const buildVerifyTrustForeclosureBoard = (
  input: VerifyTrustForeclosureInput,
  mode = resolveVerifyTrustForeclosureMode(),
): VerifyTrustForeclosureBoard => {
  const debts = debtClasses(input)
  const admission = buildAlphaRepairReentryAdmission(input, debts, mode)
  const tickets = debts.map((debtClass) => ticketForDebt(input, debtClass, admission))
  const decisions = actionDecisions(input, debts, admission)
  const activeReleaseKey = activeNoDeltaReleaseKey(input.torghutConsumerEvidence)
  const deployerPacket = {
    source_head_sha: input.sourceServingContractVerdictExchange.source_sha,
    serving_build_commit: input.sourceServingContractVerdictExchange.serving_build_commit,
    manifest_image_digest: input.sourceServingContractVerdictExchange.manifest_image_digest,
    serving_image_digest: input.sourceServingContractVerdictExchange.serving_image_digest,
    argo_sync_revision: input.sourceServingContractVerdictExchange.verdicts[0]?.argo_sync_revision ?? null,
    argo_health: input.rolloutHealth.status,
    workload_ready: input.rolloutHealth.status === 'healthy',
    service_health: input.serviceHealth ?? null,
    torghut_business_state: input.torghutConsumerEvidence.revenue_repair_business_state ?? null,
    revenue_ready: input.torghutConsumerEvidence.revenue_repair_ready ?? null,
    top_repair_queue_item_code: topRepairQueueItem(input.torghutConsumerEvidence)?.code ?? null,
    selected_value_gate: admission.selected_value_gate,
    validation_command: admission.validation_command,
    rollback_target: admission.rollback_target,
  }
  const boardId = `verify-trust-foreclosure-board:${input.namespace}:${hashJson({
    execution_trust_ref: executionTrustRef(input.executionTrust),
    source_rollout_truth_ref: input.sourceServingContractVerdictExchange.exchange_id,
    torghut_consumer_evidence_ref: input.torghutConsumerEvidence.receipt_id,
    active_no_delta_release_key: activeReleaseKey,
    debt_classes: debts,
    admission_decision: admission.decision,
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    mode,
    board_id: boardId,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input),
    namespace: input.namespace,
    governing_design_refs: [
      VERIFY_TRUST_FORECLOSURE_DESIGN_ARTIFACT,
      TORGHUT_NO_DELTA_REENTRY_DESIGN_ARTIFACT,
      'swarm-validation-contract:every-run-cites-governing-requirement',
    ],
    execution_trust_ref: executionTrustRef(input.executionTrust),
    execution_trust_status: input.executionTrust.status,
    source_rollout_truth_ref: input.sourceServingContractVerdictExchange.exchange_id,
    source_rollout_truth_state: sourceRolloutTruthState(input.sourceServingContractVerdictExchange),
    controller_witness_ref: input.controllerWitness?.quorum_id ?? null,
    database_projection_ref: input.database?.migration_consistency.latest_applied ?? null,
    route_stability_ref: input.routeStabilityEscrow?.escrow_id ?? null,
    torghut_consumer_evidence_ref: input.torghutConsumerEvidence.receipt_id,
    torghut_alpha_repair_closure_board_ref: input.torghutConsumerEvidence.alpha_repair_closure_board?.board_id ?? null,
    torghut_alpha_repair_dividend_ref: input.torghutConsumerEvidence.alpha_repair_dividend_ledger?.ledger_id ?? null,
    torghut_no_delta_repair_reentry_auction_ref:
      input.torghutConsumerEvidence.no_delta_repair_reentry_auction?.auction_id ?? null,
    active_no_delta_release_key: activeReleaseKey,
    debt_classes: debts,
    foreclosure_tickets: tickets,
    action_decisions: decisions,
    alpha_repair_reentry_admission: admission,
    deployer_packet: deployerPacket,
    rollback_target: ROLLBACK_TARGET,
  }
}
