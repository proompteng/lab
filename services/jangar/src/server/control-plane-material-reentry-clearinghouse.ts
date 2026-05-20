import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  MaterialReentryClearinghouse,
  MaterialReentryImplementerDispatch,
  MaterialReentryReceipt,
  MaterialReentryReceiptClass,
  MaterialReentryReceiptStatus,
  ReadyTruthMaterialReadiness,
  ReadyTruthArbiter,
  RepairBidAdmissionReceipt,
  RepairBidAdmissionState,
  RepairLotDispatchTicket,
  SourceServingContractActionClass,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
  TorghutExecutableAlphaRepairReceipt,
} from '~/data/agents-control-plane'
import { buildTorghutAlphaClosureRepairPlanParts } from '~/server/control-plane-material-reentry-alpha-closure'
import type { ControlPlaneWatchReliability, DatabaseStatus } from '~/server/control-plane-status-types'

export const MATERIAL_REENTRY_CLEARINGHOUSE_DESIGN_ARTIFACT =
  'docs/agents/designs/192-jangar-material-readiness-reentry-clearinghouse-and-source-rollout-receipts-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.material-reentry-clearinghouse.v1' as const
const RECEIPT_SCHEMA_VERSION = 'jangar.material-reentry-receipt.v1' as const
const DEFAULT_FRESHNESS_MS = 60 * 1000
const DEFAULT_MAX_RUNTIME_SECONDS = 20 * 60

const hashJson = (value: unknown, length = 18) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const uniqueActionClasses = (values: ActionSloBudgetActionClass[]) => [...new Set(values)]

const stableKeyPart = (value: string | null | undefined, fallback = 'unknown') => {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

const parseFutureTime = (value: string | null | undefined, nowMs: number) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > nowMs ? parsed : null
}

const freshUntilFor = (now: Date, values: Array<string | null | undefined>) => {
  const nowMs = now.getTime()
  const candidates = values
    .map((value) => parseFutureTime(value, nowMs))
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return new Date(candidates[0] ?? nowMs + DEFAULT_FRESHNESS_MS).toISOString()
}

const statusForDecision = (decision: ReadyTruthMaterialReadiness): MaterialReentryReceiptStatus => {
  if (decision === 'block') return 'blocked'
  if (decision === 'allow') return 'open'
  return 'repair_required'
}

const actionDecision = (
  readyTruthArbiter: ReadyTruthArbiter,
  actionClass: ActionSloBudgetActionClass,
): ReadyTruthMaterialReadiness => {
  if (readyTruthArbiter.blocked_action_classes.includes(actionClass)) return 'block'
  if (readyTruthArbiter.held_action_classes.includes(actionClass)) return 'hold'
  if (readyTruthArbiter.repair_only_action_classes.includes(actionClass)) return 'repair_only'
  return 'allow'
}

const sourceActionFor = (actionClass: ActionSloBudgetActionClass): SourceServingContractActionClass | null => {
  if (actionClass === 'paper_canary') return 'paper_support'
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') return 'live_support'
  if (
    actionClass === 'serve_readonly' ||
    actionClass === 'dispatch_repair' ||
    actionClass === 'dispatch_normal' ||
    actionClass === 'deploy_widen' ||
    actionClass === 'merge_ready'
  ) {
    return actionClass
  }
  return null
}

const sourceVerdictFor = (
  exchange: SourceServingContractVerdictExchange,
  actionClass: ActionSloBudgetActionClass,
): SourceServingContractVerdict | null => {
  const sourceAction = sourceActionFor(actionClass)
  if (!sourceAction) return null
  return exchange.verdicts.find((verdict) => verdict.action_class === sourceAction) ?? null
}

const repairReceiptFor = (
  admission: RepairBidAdmissionState,
  actionClass: ActionSloBudgetActionClass,
): RepairBidAdmissionReceipt | null =>
  admission.receipts.find((receipt) => receipt.action_class === actionClass) ?? null

const stageCreditAccountFor = (ledger: StageCreditLedger | null, actionClass: ActionSloBudgetActionClass) =>
  ledger?.stage_accounts.find((account) => account.action_class === actionClass) ?? null

const topAlphaDispatchTicket = (admission: RepairBidAdmissionState): RepairLotDispatchTicket | null =>
  admission.dispatch_tickets.find(
    (ticket) =>
      ticket.launch_allowed &&
      ticket.lot_class === 'promotion_custody' &&
      ticket.target_value_gate === 'routeable_candidate_count',
  ) ?? null

const dispatchRepairTicket = (admission: RepairBidAdmissionState): RepairLotDispatchTicket | null =>
  topAlphaDispatchTicket(admission) ??
  admission.dispatch_tickets.find((ticket) => ticket.launch_allowed) ??
  admission.dispatch_tickets[0] ??
  null

const topTorghutValueGate = (torghut: TorghutConsumerEvidenceStatus) =>
  torghut.alpha_readiness_strike_ledger?.selected_business_blocker?.value_gate ?? null

const topTorghutRequiredOutput = (torghut: TorghutConsumerEvidenceStatus) =>
  torghut.alpha_readiness_strike_ledger?.selected_business_blocker?.required_output_receipt ?? null

const selectedExecutableAlphaReceipt = (torghut: TorghutConsumerEvidenceStatus) =>
  torghut.executable_alpha_repair_receipts?.selected_receipt ?? null

const executableAlphaReceiptIsFresh = (receipt: TorghutExecutableAlphaRepairReceipt | null, now: Date) => {
  const freshUntilMs = parseFutureTime(receipt?.fresh_until, now.getTime())
  return Boolean(receipt && freshUntilMs)
}

const isTorghutRepairAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'dispatch_repair' || actionClass === 'torghut_observe'

const isCapitalAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'

type ReceiptPlan = {
  receiptClass: MaterialReentryReceiptClass
  requiredOutputReceipt: string | null
  validationCommands: string[]
  valueGates: string[]
  expectedGateDelta: string | null
  maxParallelism: number
  maxRuntimeSeconds: number | null
  maxNotional: number
  sourceHoldRefs: string[]
  evidenceRefs: string[]
  reasonCodes: string[]
  rollbackTarget: string
  implementerDispatch: MaterialReentryImplementerDispatch | null
}

const basePlan = (input: {
  receiptClass: MaterialReentryReceiptClass
  requiredOutputReceipt: string | null
  validationCommands?: string[]
  valueGates: string[]
  expectedGateDelta?: string | null
  maxParallelism?: number
  maxRuntimeSeconds?: number | null
  maxNotional?: number
  sourceHoldRefs?: Array<string | null | undefined>
  evidenceRefs?: Array<string | null | undefined>
  reasonCodes?: Array<string | null | undefined>
  rollbackTarget: string
  implementerDispatch?: MaterialReentryImplementerDispatch | null
}): ReceiptPlan => ({
  receiptClass: input.receiptClass,
  requiredOutputReceipt: input.requiredOutputReceipt,
  validationCommands: uniqueStrings(input.validationCommands ?? []),
  valueGates: uniqueStrings(input.valueGates),
  expectedGateDelta: input.expectedGateDelta ?? null,
  maxParallelism: input.maxParallelism ?? 0,
  maxRuntimeSeconds: input.maxRuntimeSeconds ?? null,
  maxNotional: input.maxNotional ?? 0,
  sourceHoldRefs: uniqueStrings(input.sourceHoldRefs ?? []),
  evidenceRefs: uniqueStrings(input.evidenceRefs ?? []),
  reasonCodes: uniqueStrings(input.reasonCodes ?? []),
  rollbackTarget: input.rollbackTarget,
  implementerDispatch: input.implementerDispatch ?? null,
})

const torghutExecutableAlphaRepairLane = (input: {
  actionClass: ActionSloBudgetActionClass
  selectedReceipt: TorghutExecutableAlphaRepairReceipt
  requiredOutputReceipt: string | null
  valueGate: string
}) => ({
  source: 'torghut.executable-alpha-repair',
  actionClass: input.actionClass,
  repairClass: stableKeyPart(input.selectedReceipt.repair_class),
  hypothesisId: stableKeyPart(input.selectedReceipt.hypothesis_id),
  accountId: stableKeyPart(input.selectedReceipt.account_id),
  window: stableKeyPart(input.selectedReceipt.window),
  tradingMode: stableKeyPart(input.selectedReceipt.trading_mode),
  valueGate: stableKeyPart(input.valueGate),
  requiredOutputReceipt: stableKeyPart(input.requiredOutputReceipt),
})

const buildTorghutExecutableAlphaImplementerDispatch = (input: {
  actionClass: ActionSloBudgetActionClass
  selectedReceipt: TorghutExecutableAlphaRepairReceipt
  requiredOutputReceipt: string | null
  validationCommands: string[]
  valueGates: string[]
  expectedGateDelta: string | null
  maxRuntimeSeconds: number
  rollbackTarget: string
}): MaterialReentryImplementerDispatch | null => {
  if (!isTorghutRepairAction(input.actionClass)) return null

  const valueGate = input.selectedReceipt.target_value_gate || input.valueGates[0] || 'routeable_candidate_count'
  const laneHash = hashJson(
    torghutExecutableAlphaRepairLane({
      actionClass: input.actionClass,
      selectedReceipt: input.selectedReceipt,
      requiredOutputReceipt: input.requiredOutputReceipt,
      valueGate,
    }),
    12,
  )
  const signalName = `material-reentry-torghut-alpha-${laneHash}`
  const dedupeKey = `material-reentry:torghut-executable-alpha:${laneHash}:${valueGate}`
  const description =
    `Implement Torghut zero-notional executable-alpha repair for ${valueGate}; ` +
    'produce the required receipt and keep live capital disabled.'

  return {
    schema_version: 'jangar.material-reentry-implementer-dispatch.v1',
    dispatch_kind: 'swarm_requirement_signal',
    source_swarm: 'jangar-control-plane',
    target_swarm: 'torghut-quant',
    target_stage: 'implement',
    target_role: 'engineer',
    signal_name: signalName,
    channel: 'agentrun.general.requirement',
    description,
    priority: 'critical',
    dedupe_key: dedupeKey,
    payload: {
      type: 'material_reentry_requirement',
      source: 'jangar.material_reentry_clearinghouse',
      source_receipt_id: input.selectedReceipt.receipt_id,
      repair_class: input.selectedReceipt.repair_class,
      target_value_gate: valueGate,
      value_gates: input.valueGates,
      expected_gate_delta: input.expectedGateDelta,
      expected_unblock_value: input.selectedReceipt.expected_unblock_value,
      required_output_receipt: input.requiredOutputReceipt,
      required_output_receipts: input.selectedReceipt.required_output_receipts,
      validation_commands: input.validationCommands,
      hypothesis_id: input.selectedReceipt.hypothesis_id,
      candidate_id: input.selectedReceipt.candidate_id,
      strategy_id: input.selectedReceipt.strategy_id,
      account_id: input.selectedReceipt.account_id,
      window: input.selectedReceipt.window,
      trading_mode: input.selectedReceipt.trading_mode,
      reason_codes: input.selectedReceipt.reason_codes,
      max_notional: 0,
      max_runtime_seconds: input.maxRuntimeSeconds,
      business_metric: valueGate,
      acceptance: [
        `retire ${valueGate} blocker or emit a no-delta receipt explaining the remaining blocker`,
        'keep Torghut max_notional=0 and live submit disabled during repair',
        'do not request automatic Codex review or post @codex review',
      ],
      review_policy: 'no_automatic_codex_review',
      no_codex_review: true,
      rollback_target: input.rollbackTarget,
    },
  }
}

const buildTorghutAlphaClosureRepairPlan = (input: {
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  actionClass: ActionSloBudgetActionClass
  now: Date
}): ReceiptPlan => {
  const board = input.torghutConsumerEvidence.alpha_repair_closure_board
  if (!board) {
    return basePlan({
      receiptClass: 'torghut_alpha_closure_repair',
      requiredOutputReceipt: topTorghutRequiredOutput(input.torghutConsumerEvidence),
      valueGates: [topTorghutValueGate(input.torghutConsumerEvidence) ?? 'routeable_candidate_count'],
      reasonCodes: ['alpha_closure_carry_missing'],
      rollbackTarget: 'disable alpha repair closure board requirement and keep Torghut max_notional=0',
    })
  }
  const parts = buildTorghutAlphaClosureRepairPlanParts({
    torghutConsumerEvidence: input.torghutConsumerEvidence,
    actionClass: input.actionClass,
    board,
    now: input.now,
    defaultMaxRuntimeSeconds: DEFAULT_MAX_RUNTIME_SECONDS,
  })

  return basePlan({
    receiptClass: 'torghut_alpha_closure_repair',
    ...parts,
  })
}

const buildTorghutRepairPlan = (input: {
  repairBidAdmission: RepairBidAdmissionState
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  actionClass: ActionSloBudgetActionClass
  receipt?: RepairBidAdmissionReceipt | null
}): ReceiptPlan => {
  const ticket = dispatchRepairTicket(input.repairBidAdmission)
  const valueGate =
    ticket?.target_value_gate || topTorghutValueGate(input.torghutConsumerEvidence) || 'capital_gate_safety'
  const topOutputReceipt = topTorghutRequiredOutput(input.torghutConsumerEvidence)
  const requiredOutputReceipt = ticket?.required_output_receipt || topOutputReceipt || 'torghut.repair-receipt.v1'
  const receiptClass: MaterialReentryReceiptClass =
    valueGate === 'fill_tca_or_slippage_quality' ? 'torghut_execution_tca_repair' : 'torghut_executable_alpha_repair'
  return basePlan({
    receiptClass,
    requiredOutputReceipt,
    validationCommands: input.receipt?.validation_commands ?? [],
    valueGates: [valueGate],
    expectedGateDelta: ticket?.expected_gate_delta ?? null,
    maxParallelism: ticket?.launch_allowed ? 1 : 0,
    maxRuntimeSeconds: ticket?.max_runtime_seconds ?? DEFAULT_MAX_RUNTIME_SECONDS,
    maxNotional: 0,
    sourceHoldRefs: [
      input.repairBidAdmission.torghut_settlement_ledger_ref,
      input.repairBidAdmission.dispatch_tickets[0]?.ticket_id,
      ticket?.ticket_id,
    ],
    evidenceRefs: [
      input.torghutConsumerEvidence.receipt_id,
      input.torghutConsumerEvidence.alpha_readiness_strike_ledger?.ledger_id,
      input.torghutConsumerEvidence.alpha_readiness_strike_ledger?.revenue_repair_digest_ref,
      ticket?.admission_receipt_id,
    ],
    reasonCodes: [
      ...(input.receipt?.denied_reason_codes ?? []),
      ...(input.torghutConsumerEvidence.alpha_readiness_strike_ledger?.reason_codes ?? []),
      ...(topOutputReceipt ? [`top_revenue_required_output:${topOutputReceipt}`] : []),
    ],
    rollbackTarget:
      input.torghutConsumerEvidence.alpha_readiness_strike_ledger?.rollback_target ??
      input.repairBidAdmission.rollback_target,
  })
}

const buildTorghutExecutableAlphaRepairPlan = (input: {
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  actionClass: ActionSloBudgetActionClass
  selectedReceipt: TorghutExecutableAlphaRepairReceipt
}): ReceiptPlan => {
  const set = input.torghutConsumerEvidence.executable_alpha_repair_receipts
  const jangarReentry = input.selectedReceipt.jangar_reentry
  const allowsRepairAction = isTorghutRepairAction(input.actionClass)
  const requiredOutputReceipt =
    input.selectedReceipt.required_output_receipts.find(
      (receipt) => receipt === 'torghut.executable-alpha-receipts.v1',
    ) ??
    input.selectedReceipt.required_output_receipts[0] ??
    topTorghutRequiredOutput(input.torghutConsumerEvidence) ??
    null
  const validationCommands = uniqueStrings([
    ...input.selectedReceipt.validation_commands,
    "curl -fsS http://torghut.torghut.svc.cluster.local/trading/revenue-repair | jq '.executable_alpha_repair_receipts.selected_receipt'",
    'uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py',
  ])
  const valueGates = uniqueStrings([
    ...(jangarReentry?.value_gates ?? []),
    input.selectedReceipt.target_value_gate,
    set?.target_value_gate,
  ])
  const maxRuntimeSeconds = allowsRepairAction ? (jangarReentry?.max_runtime_seconds ?? DEFAULT_MAX_RUNTIME_SECONDS) : 0
  const rollbackTarget =
    jangarReentry?.rollback_target ??
    input.selectedReceipt.rollback_target ??
    'keep Torghut max_notional=0 and live submit disabled'

  return basePlan({
    receiptClass: 'torghut_executable_alpha_repair',
    requiredOutputReceipt,
    validationCommands,
    valueGates,
    expectedGateDelta: input.selectedReceipt.expected_gate_delta,
    maxParallelism: allowsRepairAction ? (jangarReentry?.max_parallelism ?? 1) : 0,
    maxRuntimeSeconds,
    maxNotional: 0,
    sourceHoldRefs: [
      set?.source_revenue_repair_ref,
      set?.selected_receipt_id,
      input.selectedReceipt.receipt_id,
      input.torghutConsumerEvidence.alpha_readiness_strike_ledger?.ledger_id,
    ],
    evidenceRefs: [
      input.torghutConsumerEvidence.receipt_id,
      input.selectedReceipt.receipt_id,
      set?.source_revenue_repair_ref,
      input.torghutConsumerEvidence.alpha_readiness_strike_ledger?.revenue_repair_digest_ref,
    ],
    reasonCodes: [
      ...input.selectedReceipt.reason_codes,
      ...(allowsRepairAction ? [] : ['torghut_alpha_repair_blocks_capital_reentry']),
    ],
    rollbackTarget,
    implementerDispatch: buildTorghutExecutableAlphaImplementerDispatch({
      actionClass: input.actionClass,
      selectedReceipt: input.selectedReceipt,
      requiredOutputReceipt,
      validationCommands,
      valueGates,
      expectedGateDelta: input.selectedReceipt.expected_gate_delta,
      maxRuntimeSeconds,
      rollbackTarget,
    }),
  })
}

const chooseReceiptPlan = (input: {
  now: Date
  actionClass: ActionSloBudgetActionClass
  decision: ReadyTruthMaterialReadiness
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliability
  readyTruthArbiter: ReadyTruthArbiter
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  stageCreditLedger: StageCreditLedger | null
  repairBidAdmission: RepairBidAdmissionState
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}): ReceiptPlan => {
  const sourceVerdict = sourceVerdictFor(input.sourceServingContractVerdictExchange, input.actionClass)
  const stageCreditAccount = stageCreditAccountFor(input.stageCreditLedger, input.actionClass)
  const repairReceipt = repairReceiptFor(input.repairBidAdmission, input.actionClass)
  const alphaTicket = topAlphaDispatchTicket(input.repairBidAdmission)
  const alphaClosureBoard = input.torghutConsumerEvidence.alpha_repair_closure_board
  const selectedAlphaReceipt = selectedExecutableAlphaReceipt(input.torghutConsumerEvidence)

  if (alphaClosureBoard && (isTorghutRepairAction(input.actionClass) || isCapitalAction(input.actionClass))) {
    return buildTorghutAlphaClosureRepairPlan({
      torghutConsumerEvidence: input.torghutConsumerEvidence,
      actionClass: input.actionClass,
      now: input.now,
    })
  }

  if (
    selectedAlphaReceipt &&
    executableAlphaReceiptIsFresh(selectedAlphaReceipt, input.now) &&
    (isTorghutRepairAction(input.actionClass) || isCapitalAction(input.actionClass))
  ) {
    return buildTorghutExecutableAlphaRepairPlan({
      torghutConsumerEvidence: input.torghutConsumerEvidence,
      actionClass: input.actionClass,
      selectedReceipt: selectedAlphaReceipt,
    })
  }

  if (input.actionClass === 'torghut_observe' && alphaTicket) {
    return buildTorghutRepairPlan({
      repairBidAdmission: input.repairBidAdmission,
      torghutConsumerEvidence: input.torghutConsumerEvidence,
      actionClass: input.actionClass,
      receipt: repairReceipt,
    })
  }

  if (input.decision === 'allow') {
    return basePlan({
      receiptClass: 'stage_credit_reentry',
      requiredOutputReceipt: null,
      valueGates: ['ready_status_truth'],
      maxParallelism: 0,
      maxRuntimeSeconds: null,
      sourceHoldRefs: [input.readyTruthArbiter.verdict_id],
      evidenceRefs: [input.readyTruthArbiter.verdict_id],
      rollbackTarget: input.readyTruthArbiter.rollback_target,
    })
  }

  if (input.database.status !== 'healthy') {
    return basePlan({
      receiptClass: 'controller_ingestion_repair',
      requiredOutputReceipt: 'jangar.database-current-receipt.v1',
      valueGates: ['ready_status_truth', 'pr_to_rollout_latency'],
      sourceHoldRefs: [input.readyTruthArbiter.verdict_id],
      evidenceRefs: [input.database.migration_consistency.latest_applied ?? input.database.message],
      reasonCodes: [`database_${input.database.status}`],
      rollbackTarget: 'restore the prior Jangar revision or disable material reentry clearinghouse emission',
    })
  }

  if (input.watchReliability.status !== 'healthy') {
    return basePlan({
      receiptClass: 'watch_reliability_repair',
      requiredOutputReceipt: 'jangar.watch-reliability-repair-receipt.v1',
      valueGates: ['failed_agentrun_rate', 'manual_intervention_count'],
      maxRuntimeSeconds: DEFAULT_MAX_RUNTIME_SECONDS,
      sourceHoldRefs: [input.readyTruthArbiter.verdict_id],
      evidenceRefs: input.watchReliability.streams.map((stream) => `${stream.namespace}/${stream.resource}`),
      reasonCodes: [`watch_reliability_${input.watchReliability.status}`],
      rollbackTarget: 'disable material reentry clearinghouse emission and fall back to ready truth reasons',
    })
  }

  if (
    sourceVerdict &&
    sourceVerdict.decision !== 'allow' &&
    !(input.actionClass === 'dispatch_repair' && sourceVerdict.decision === 'repair_only')
  ) {
    return basePlan({
      receiptClass: input.actionClass === 'merge_ready' ? 'merge_ready_source_receipt' : 'source_rollout_receipt',
      requiredOutputReceipt: 'jangar.source-rollout-receipt.v1',
      validationCommands: sourceVerdict.required_repair_receipts,
      valueGates: ['pr_to_rollout_latency', 'ready_status_truth'],
      maxRuntimeSeconds: DEFAULT_MAX_RUNTIME_SECONDS,
      sourceHoldRefs: [input.sourceServingContractVerdictExchange.exchange_id, sourceVerdict.verdict_id],
      evidenceRefs: sourceVerdict.evidence_refs,
      reasonCodes: sourceVerdict.blocking_reason_codes,
      rollbackTarget: sourceVerdict.rollback_gate,
    })
  }

  if (
    stageCreditAccount &&
    stageCreditAccount.decision !== 'allow' &&
    !(input.actionClass === 'dispatch_repair' && stageCreditAccount.decision === 'repair_only')
  ) {
    return basePlan({
      receiptClass: 'stage_credit_reentry',
      requiredOutputReceipt: 'jangar.stage-credit-reentry-receipt.v1',
      valueGates: ['failed_agentrun_rate', 'manual_intervention_count', 'ready_status_truth'],
      maxRuntimeSeconds: stageCreditAccount.max_runtime_seconds,
      sourceHoldRefs: [input.stageCreditLedger?.ledger_id, stageCreditAccount.account_id],
      evidenceRefs: stageCreditAccount.evidence_refs,
      reasonCodes: stageCreditAccount.reason_codes,
      rollbackTarget: stageCreditAccount.rollback_target,
    })
  }

  if (
    repairReceipt &&
    repairReceipt.decision !== 'allow' &&
    !(input.actionClass === 'dispatch_repair' && repairReceipt.decision === 'repair_only')
  ) {
    return buildTorghutRepairPlan({
      repairBidAdmission: input.repairBidAdmission,
      torghutConsumerEvidence: input.torghutConsumerEvidence,
      actionClass: input.actionClass,
      receipt: repairReceipt,
    })
  }

  if (input.actionClass === 'dispatch_repair' && alphaTicket) {
    return buildTorghutRepairPlan({
      repairBidAdmission: input.repairBidAdmission,
      torghutConsumerEvidence: input.torghutConsumerEvidence,
      actionClass: input.actionClass,
      receipt: repairReceipt,
    })
  }

  return basePlan({
    receiptClass:
      input.actionClass === 'deploy_widen' || input.actionClass === 'merge_ready'
        ? 'deployer_rollout_proof'
        : 'controller_ingestion_repair',
    requiredOutputReceipt:
      input.actionClass === 'deploy_widen' || input.actionClass === 'merge_ready'
        ? 'jangar.deployer-rollout-proof-receipt.v1'
        : 'jangar.controller-ingestion-repair-receipt.v1',
    valueGates: ['ready_status_truth', 'handoff_evidence_quality'],
    sourceHoldRefs: [input.readyTruthArbiter.verdict_id],
    evidenceRefs: input.readyTruthArbiter.ready_status_truth_reasons,
    reasonCodes: input.readyTruthArbiter.ready_status_truth_reasons,
    rollbackTarget: input.readyTruthArbiter.rollback_target,
  })
}

const buildReceipt = (input: {
  now: Date
  namespace: string
  actionClass: ActionSloBudgetActionClass
  decision: ReadyTruthMaterialReadiness
  plan: ReceiptPlan
}): MaterialReentryReceipt => {
  const receiptDecision =
    input.actionClass === 'torghut_observe' && input.plan.requiredOutputReceipt ? 'repair_only' : input.decision
  const status = statusForDecision(receiptDecision)
  const receiptId = `material-reentry-receipt:${hashJson({
    namespace: input.namespace,
    actionClass: input.actionClass,
    decision: receiptDecision,
    receiptClass: input.plan.receiptClass,
    requiredOutputReceipt: input.plan.requiredOutputReceipt,
    sourceHoldRefs: input.plan.sourceHoldRefs,
  })}`
  const implementerDispatch = input.plan.implementerDispatch
    ? {
        ...input.plan.implementerDispatch,
        payload: {
          ...input.plan.implementerDispatch.payload,
          material_reentry_receipt_id: receiptId,
        },
      }
    : null

  return {
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    generated_at: input.now.toISOString(),
    fresh_until: new Date(input.now.getTime() + DEFAULT_FRESHNESS_MS).toISOString(),
    namespace: input.namespace,
    action_class: input.actionClass,
    stage:
      input.actionClass === 'deploy_widen' || input.actionClass === 'merge_ready'
        ? 'verify'
        : input.actionClass === 'serve_readonly'
          ? 'serve'
          : 'implement',
    decision: receiptDecision,
    status,
    receipt_class: input.plan.receiptClass,
    source_hold_refs: input.plan.sourceHoldRefs,
    required_output_receipt: input.plan.requiredOutputReceipt,
    required_validation_commands: input.plan.validationCommands,
    value_gates: input.plan.valueGates,
    expected_gate_delta: input.plan.expectedGateDelta,
    max_parallelism: input.plan.maxParallelism,
    max_runtime_seconds: input.plan.maxRuntimeSeconds,
    max_notional: input.plan.maxNotional,
    evidence_refs: input.plan.evidenceRefs,
    reason_codes: input.plan.reasonCodes,
    rollback_target: input.plan.rollbackTarget,
    implementer_dispatch: implementerDispatch,
  }
}

export const buildMaterialReentryClearinghouse = (input: {
  now: Date
  namespace: string
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliability
  readyTruthArbiter: ReadyTruthArbiter
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  stageCreditLedger: StageCreditLedger | null
  repairBidAdmission: RepairBidAdmissionState
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
}): MaterialReentryClearinghouse => {
  const actionClasses = uniqueActionClasses([
    ...input.readyTruthArbiter.allowed_action_classes,
    ...input.readyTruthArbiter.repair_only_action_classes,
    ...input.readyTruthArbiter.held_action_classes,
    ...input.readyTruthArbiter.blocked_action_classes,
  ])
  const actionReceipts = actionClasses.map((actionClass) => {
    const decision = actionDecision(input.readyTruthArbiter, actionClass)
    return buildReceipt({
      now: input.now,
      namespace: input.namespace,
      actionClass,
      decision,
      plan: chooseReceiptPlan({
        actionClass,
        decision,
        now: input.now,
        database: input.database,
        watchReliability: input.watchReliability,
        readyTruthArbiter: input.readyTruthArbiter,
        sourceServingContractVerdictExchange: input.sourceServingContractVerdictExchange,
        stageCreditLedger: input.stageCreditLedger,
        repairBidAdmission: input.repairBidAdmission,
        torghutConsumerEvidence: input.torghutConsumerEvidence,
      }),
    })
  })
  const repairRequiredActionClasses = actionReceipts
    .filter((receipt) => receipt.status === 'repair_required')
    .map((receipt) => receipt.action_class)
  const blockedActionClasses = actionReceipts
    .filter((receipt) => receipt.status === 'blocked')
    .map((receipt) => receipt.action_class)
  const openActionClasses = actionReceipts
    .filter((receipt) => receipt.status === 'open')
    .map((receipt) => receipt.action_class)
  const topRepairReceipt =
    actionReceipts.find(
      (receipt) =>
        (receipt.receipt_class === 'torghut_alpha_closure_repair' ||
          receipt.receipt_class === 'torghut_executable_alpha_repair') &&
        receipt.value_gates.includes('routeable_candidate_count'),
    ) ?? null
  const implementerDispatches = actionReceipts
    .map((receipt) => receipt.implementer_dispatch)
    .filter((dispatch): dispatch is MaterialReentryImplementerDispatch => dispatch !== null)
  const status = statusForDecision(input.readyTruthArbiter.material_readiness)

  return {
    schema_version: SCHEMA_VERSION,
    mode: 'observe',
    design_artifact: MATERIAL_REENTRY_CLEARINGHOUSE_DESIGN_ARTIFACT,
    clearinghouse_id: `material-reentry-clearinghouse:${hashJson({
      namespace: input.namespace,
      materialReadiness: input.readyTruthArbiter.material_readiness,
      receiptIds: actionReceipts.map((receipt) => receipt.receipt_id),
    })}`,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntilFor(input.now, [
      input.readyTruthArbiter.fresh_until,
      input.repairBidAdmission.fresh_until,
      input.stageCreditLedger?.fresh_until,
      input.sourceServingContractVerdictExchange.fresh_until,
      input.torghutConsumerEvidence.fresh_until,
      input.torghutConsumerEvidence.alpha_repair_closure_board?.fresh_until,
      input.torghutConsumerEvidence.alpha_evidence_foundry?.fresh_until,
      input.torghutConsumerEvidence.executable_alpha_repair_receipts?.fresh_until,
    ]),
    namespace: input.namespace,
    status,
    material_readiness: input.readyTruthArbiter.material_readiness,
    action_receipts: actionReceipts,
    open_action_classes: openActionClasses,
    repair_required_action_classes: repairRequiredActionClasses,
    blocked_action_classes: blockedActionClasses,
    primary_reentry_receipt_refs: actionReceipts
      .filter((receipt) => receipt.status !== 'open')
      .map((receipt) => receipt.receipt_id),
    top_repair_receipt_id: topRepairReceipt?.receipt_id ?? null,
    implementer_dispatches: implementerDispatches,
    top_implementer_dispatch: topRepairReceipt?.implementer_dispatch ?? implementerDispatches[0] ?? null,
    rollback_target: 'disable material reentry clearinghouse emission and use ready truth plus repair-bid admission',
  }
}
