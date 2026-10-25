import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ClearanceMarketDecision,
  ClearanceMarketLedger,
  ClearanceMarketRepairLot,
  ClearanceMarketStageAdmission,
  ControlPlaneControllerWitnessQuorum,
  DatabaseStatus,
  ProjectionForeclosureNotary,
  StageClearancePacket,
  StageCreditAccount,
  StageCreditDecision,
  StageCreditEvidenceMode,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
  WorkflowsReliabilityStatus,
} from '~/server/control-plane-status-types'
import { isProjectionForeclosureConsumptionEnabled } from '~/server/control-plane-projection-foreclosure-notary'
import type { AgentRunIngestionStatus } from '~/server/control-plane-status-types'

export const STAGE_CREDIT_LEDGER_DESIGN_ARTIFACT =
  'docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md'
const RUNNER_CAPACITY_FUTURES_DESIGN_ARTIFACT =
  'docs/agents/designs/191-jangar-rollout-proof-passports-and-runner-capacity-futures-2026-05-13.md'

const STAGE_CREDIT_SCHEMA_VERSION = 'jangar.stage-credit-ledger.v1' as const
const LEDGER_TTL_SECONDS = 120
const DEFAULT_ROLLBACK_TARGET = 'JANGAR_STAGE_CREDIT_LEDGER_ENABLED=false'

const GOVERNING_DESIGN_REFS = [
  STAGE_CREDIT_LEDGER_DESIGN_ARTIFACT,
  RUNNER_CAPACITY_FUTURES_DESIGN_ARTIFACT,
  'docs/agents/designs/185-jangar-clearance-market-and-rollout-truth-settlement-2026-05-12.md',
  'docs/agents/designs/184-jangar-stage-clearance-packets-and-freeze-aware-launch-governor-2026-05-12.md',
  'swarm-validation-contract:every-run-cites-governing-requirement',
]

type AccountPolicy = {
  baseCredit: number
  minimumSpend: number
  maxConcurrentRuns: number
  maxRuntimeSeconds: number | null
  maxNotional: number
}

export type StageCreditLedgerInput = {
  now: Date
  namespace: string
  database: DatabaseStatus
  workflows: WorkflowsReliabilityStatus
  agentRunIngestion: AgentRunIngestionStatus
  controllerWitness: ControlPlaneControllerWitnessQuorum
  stageClearancePackets: StageClearancePacket[]
  clearanceMarketLedger: ClearanceMarketLedger | null
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  projectionForeclosureNotary?: ProjectionForeclosureNotary | null
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const normalizeReasons = (values: Array<string | null | undefined>) => uniqueStrings(values).map(normalizeReason)

const capped = (value: number, max = 100) => Math.max(0, Math.min(max, value))

const numericNotional = (value: string | null | undefined) => {
  if (!value) return 0
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const isCapitalAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'

const isLiveCapitalAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'live_micro_canary' || actionClass === 'live_scale'

const policyForAction = (actionClass: ActionSloBudgetActionClass): AccountPolicy => {
  switch (actionClass) {
    case 'serve_readonly':
      return {
        baseCredit: 100,
        minimumSpend: 0,
        maxConcurrentRuns: 0,
        maxRuntimeSeconds: null,
        maxNotional: 0,
      }
    case 'torghut_observe':
      return {
        baseCredit: 80,
        minimumSpend: 0,
        maxConcurrentRuns: 0,
        maxRuntimeSeconds: null,
        maxNotional: 0,
      }
    case 'dispatch_repair':
      return {
        baseCredit: 40,
        minimumSpend: 25,
        maxConcurrentRuns: 1,
        maxRuntimeSeconds: 1800,
        maxNotional: 0,
      }
    case 'dispatch_normal':
      return {
        baseCredit: 50,
        minimumSpend: 50,
        maxConcurrentRuns: 1,
        maxRuntimeSeconds: 1800,
        maxNotional: 0,
      }
    case 'deploy_widen':
    case 'merge_ready':
      return {
        baseCredit: 60,
        minimumSpend: 60,
        maxConcurrentRuns: 1,
        maxRuntimeSeconds: 1200,
        maxNotional: 0,
      }
    case 'paper_canary':
      return {
        baseCredit: 50,
        minimumSpend: 75,
        maxConcurrentRuns: 1,
        maxRuntimeSeconds: 1800,
        maxNotional: 0,
      }
    case 'live_micro_canary':
    case 'live_scale':
      return {
        baseCredit: 0,
        minimumSpend: 100,
        maxConcurrentRuns: 0,
        maxRuntimeSeconds: 0,
        maxNotional: 0,
      }
  }
}

export const resolveStageCreditEvidenceMode = (env: NodeJS.ProcessEnv = process.env): StageCreditEvidenceMode => {
  const normalized = env.JANGAR_STAGE_CREDIT_LEDGER_MODE?.trim().toLowerCase()
  if (normalized === 'shadow' || normalized === 'hold' || normalized === 'enforce') return normalized
  return 'observe'
}

export const isStageCreditLedgerEnabled = (env: NodeJS.ProcessEnv = process.env) => {
  const normalized = env.JANGAR_STAGE_CREDIT_LEDGER_ENABLED?.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'off' || normalized === 'no')
}

const decisionRank = (decision: ClearanceMarketDecision) => {
  if (decision === 'block') return 4
  if (decision === 'hold') return 3
  if (decision === 'repair_only') return 2
  return 1
}

const strictestDecision = (decisions: ClearanceMarketDecision[]): ClearanceMarketDecision => {
  let strictest: ClearanceMarketDecision = 'allow'
  for (const decision of decisions) {
    if (decisionRank(decision) > decisionRank(strictest)) strictest = decision
  }
  return strictest
}

const creditDecision = (input: {
  actionClass: ActionSloBudgetActionClass
  availableCredit: number
  minimumSpend: number
  clearanceDecision: ClearanceMarketDecision
  selectedRepairLot: ClearanceMarketRepairLot | null
  nonWaivableBlock: boolean
}): StageCreditDecision => {
  if (input.nonWaivableBlock || input.clearanceDecision === 'block') return 'block'
  if (input.availableCredit >= input.minimumSpend && input.clearanceDecision === 'allow') return 'allow'
  if (
    input.actionClass === 'dispatch_repair' &&
    input.selectedRepairLot &&
    input.selectedRepairLot.decision === 'repair_only' &&
    input.availableCredit >= input.minimumSpend
  ) {
    return 'repair_only'
  }
  return 'hold'
}

const failureDebtTax = (input: StageCreditLedgerInput, actionClass: ActionSloBudgetActionClass) => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return 0

  const fromClearanceMarket = input.clearanceMarketLedger?.retained_failure_debt.reduce((total, debt) => {
    if (debt.window === '15m' && debt.state === 'active') return total + 40
    if (debt.window === '6h' && debt.state === 'active') return total + 25
    if (debt.window === '7d' && debt.state === 'projection_limited') return total + 10
    if (debt.state === 'unknown') return total + 10
    return total
  }, 0)

  if (fromClearanceMarket !== undefined) return capped(fromClearanceMarket)

  return capped(
    (input.workflows.recent_failed_jobs > 0 ? 40 : 0) +
      (input.workflows.backoff_limit_exceeded_jobs > 0 ? 25 : 0) +
      (input.workflows.data_confidence === 'high' ? 0 : 10),
  )
}

const controllerWitnessTax = (input: StageCreditLedgerInput, actionClass: ActionSloBudgetActionClass) => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return 0

  return capped(
    (input.agentRunIngestion.status === 'healthy' ? 0 : 40) +
      (input.controllerWitness.decision === 'allow' ? 0 : 35) +
      (input.controllerWitness.controller_self_report_current ? 0 : 40),
  )
}

const sourceRolloutTax = (
  clearanceDecision: ClearanceMarketDecision,
  stageAdmission: ClearanceMarketStageAdmission | null,
  actionClass: ActionSloBudgetActionClass,
  packetReasonCodes: string[],
) => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return 0

  const reasons = [...(stageAdmission?.reason_codes ?? []), ...packetReasonCodes]
  const sourceHold = reasons.some((reason) => reason.includes('source_rollout_truth_hold'))
  const sourceBlock = reasons.some((reason) => reason.includes('source_rollout_truth_block'))
  return capped((sourceHold ? 35 : 0) + (sourceBlock ? 50 : 0) + (clearanceDecision === 'hold' ? 10 : 0))
}

const capitalSafetyTax = (input: StageCreditLedgerInput, actionClass: ActionSloBudgetActionClass) => {
  const reasons = normalizeReasons(input.torghutConsumerEvidence.reason_codes)
  const staleProof = reasons.some(
    (reason) =>
      reason.includes('empirical') ||
      reason.includes('forecast') ||
      reason.includes('proof') ||
      reason.includes('tca') ||
      reason.includes('routeability') ||
      reason.includes('evidence_clock'),
  )
  const zeroNotional = numericNotional(input.torghutConsumerEvidence.max_notional) <= 0
  const repairOnly =
    input.torghutConsumerEvidence.decision === 'repair' || input.torghutConsumerEvidence.status !== 'current'

  if (isLiveCapitalAction(actionClass)) return capped(100 + (staleProof ? 25 : 0))
  if (actionClass === 'paper_canary') return capped((zeroNotional || repairOnly ? 50 : 0) + (staleProof ? 25 : 0))
  if (actionClass === 'dispatch_normal') return capped(staleProof ? 25 : 0)
  return 0
}

const projectionAuthorityTax = (
  input: StageCreditLedgerInput,
  actionClass: ActionSloBudgetActionClass,
  consumeProjectionForeclosure: boolean,
) => {
  if (!consumeProjectionForeclosure || !input.projectionForeclosureNotary) return 0
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return 0

  const totals = input.projectionForeclosureNotary.claim_totals_by_state
  const hardHold = totals.unknown + totals.contradictory
  const missingReceipt = totals.missing_receipt

  if (hardHold > 0) return 50
  if (missingReceipt > 0 && actionClass !== 'dispatch_repair') return 30
  return 0
}

const projectionAuthorityReasons = (
  input: StageCreditLedgerInput,
  actionClass: ActionSloBudgetActionClass,
  consumeProjectionForeclosure: boolean,
) => {
  if (!consumeProjectionForeclosure || !input.projectionForeclosureNotary) return []
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') return []

  const totals = input.projectionForeclosureNotary.claim_totals_by_state
  return [
    ...(totals.unknown > 0 ? ['projection_foreclosure_unknown'] : []),
    ...(totals.contradictory > 0 ? ['projection_foreclosure_contradictory'] : []),
    ...(totals.missing_receipt > 0 && actionClass !== 'dispatch_repair'
      ? ['projection_foreclosure_missing_receipt']
      : []),
  ]
}

const runnerCapacityReason = (reason: string) => {
  const normalized = normalizeReason(reason)
  if (
    normalized.includes('failedscheduling') ||
    normalized.includes('unschedulable') ||
    normalized.includes('providercapacityexhausted')
  ) {
    return 'runner_capacity_scheduling_unavailable'
  }
  if (
    normalized.includes('failedmount') ||
    normalized.includes('mount') ||
    normalized.includes('pvc') ||
    normalized.includes('configmap')
  ) {
    return 'runner_capacity_mount_unavailable'
  }
  if (
    normalized.includes('imagepull') ||
    normalized.includes('errimagepull') ||
    normalized.includes('invalidimagename')
  ) {
    return 'runner_capacity_image_unavailable'
  }
  if (
    normalized.includes('workflowsteptimedout') ||
    normalized.includes('timedout') ||
    normalized.includes('timeout')
  ) {
    return 'runner_capacity_runtime_timeout'
  }
  return null
}

const runnerCapacityDebt = (input: StageCreditLedgerInput, actionClass: ActionSloBudgetActionClass) => {
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') {
    return { tax: 0, reasonCodes: [], requiredRepairActions: [], evidenceRefs: [] }
  }

  const reasonCodes = normalizeReasons(
    input.workflows.top_failure_reasons.map((entry) => runnerCapacityReason(entry.reason)),
  )
  if (reasonCodes.length === 0) {
    return { tax: 0, reasonCodes, requiredRepairActions: [], evidenceRefs: [] }
  }

  const tax = actionClass === 'dispatch_repair' ? 20 : 45
  return {
    tax,
    reasonCodes,
    requiredRepairActions: reasonCodes.map((reason) => `clear ${reason.replaceAll('_', ' ')} for ${actionClass}`),
    evidenceRefs: ['workflows:top_failure_reasons'],
  }
}

const evidenceFreshnessBonus = (
  input: StageCreditLedgerInput,
  packet: StageClearancePacket,
  actionClass: ActionSloBudgetActionClass,
) =>
  capped(
    (input.database.status === 'healthy' ? 5 : 0) +
      (packet.decision === 'allow' ? 5 : 0) +
      (input.controllerWitness.controller_self_report_current ? 10 : 0) +
      (actionClass === 'serve_readonly' || actionClass === 'torghut_observe' ? 10 : 0),
    20,
  )

const rolloutTruthDeposit = (input: StageCreditLedgerInput, actionClass: ActionSloBudgetActionClass) => {
  if (actionClass !== 'deploy_widen' && actionClass !== 'merge_ready') return 0
  return input.clearanceMarketLedger?.rollout_truth_settlement.decision === 'allow' ? 30 : 0
}

const repairValueCredit = (
  input: StageCreditLedgerInput,
  actionClass: ActionSloBudgetActionClass,
  selectedRepairLot: ClearanceMarketRepairLot | null,
) => {
  if (actionClass !== 'dispatch_repair' || !selectedRepairLot || selectedRepairLot.decision !== 'repair_only') return 0
  return (
    capped(Math.max(10, selectedRepairLot.expected_unblock_value * 10), 30) +
    capped(input.torghutConsumerEvidence.route_repair_value ?? 0, 20)
  )
}

const stageAdmissionForPacket = (
  ledger: ClearanceMarketLedger | null,
  packet: StageClearancePacket,
): ClearanceMarketStageAdmission | null =>
  ledger?.stage_admission.find(
    (admission) => admission.stage === packet.stage && admission.action_class === packet.action_class,
  ) ?? null

const repairLotForAdmission = (
  ledger: ClearanceMarketLedger | null,
  stageAdmission: ClearanceMarketStageAdmission | null,
): ClearanceMarketRepairLot | null => {
  const selectedRef = stageAdmission?.selected_repair_lot_ref
  if (!selectedRef) return null
  return ledger?.repair_lots.find((lot) => lot.lot_id === selectedRef) ?? null
}

const requiredReceipts = (input: StageCreditLedgerInput, account: StageCreditAccount) =>
  uniqueStrings([
    account.selected_repair_lot_ref,
    input.controllerWitness.quorum_id,
    input.clearanceMarketLedger?.ledger_id,
    input.torghutConsumerEvidence.route_warrant_id,
    input.torghutConsumerEvidence.receipt_id,
  ])

const buildAccount = (
  input: StageCreditLedgerInput,
  packet: StageClearancePacket,
  consumeProjectionForeclosure: boolean,
): StageCreditAccount => {
  const policy = policyForAction(packet.action_class)
  const stageAdmission = stageAdmissionForPacket(input.clearanceMarketLedger, packet)
  const clearanceDecision = stageAdmission?.decision ?? packet.decision
  const selectedRepairLot = repairLotForAdmission(input.clearanceMarketLedger, stageAdmission)
  const failureTax = failureDebtTax(input, packet.action_class)
  const controllerTax = controllerWitnessTax(input, packet.action_class)
  const sourceTax = sourceRolloutTax(clearanceDecision, stageAdmission, packet.action_class, packet.reason_codes)
  const capitalTax = capitalSafetyTax(input, packet.action_class)
  const projectionTax = projectionAuthorityTax(input, packet.action_class, consumeProjectionForeclosure)
  const runnerDebt = runnerCapacityDebt(input, packet.action_class)
  const freshnessBonus = evidenceFreshnessBonus(input, packet, packet.action_class)
  const repairCredit = repairValueCredit(input, packet.action_class, selectedRepairLot)
  const rolloutDeposit = rolloutTruthDeposit(input, packet.action_class)
  const totalCredit = policy.baseCredit + freshnessBonus + repairCredit + rolloutDeposit
  const availableCredit = capped(
    totalCredit - failureTax - controllerTax - sourceTax - capitalTax - projectionTax - runnerDebt.tax,
  )
  const nonWaivableBlock =
    isLiveCapitalAction(packet.action_class) ||
    packet.reason_codes.some((reason) => normalizeReason(reason).includes('source_rollout_truth_block'))
  const decision = creditDecision({
    actionClass: packet.action_class,
    availableCredit,
    minimumSpend: policy.minimumSpend,
    clearanceDecision,
    selectedRepairLot,
    nonWaivableBlock,
  })
  const reasonCodes = normalizeReasons([
    ...packet.reason_codes,
    ...(stageAdmission?.reason_codes ?? []),
    ...projectionAuthorityReasons(input, packet.action_class, consumeProjectionForeclosure),
    ...runnerDebt.reasonCodes,
    ...(availableCredit < policy.minimumSpend ? ['stage_credit_insufficient'] : []),
    ...(selectedRepairLot && decision === 'repair_only' ? ['stage_credit_repair_future_open'] : []),
  ])

  return {
    account_id: `stage-credit-account:${packet.stage}:${packet.action_class}:${hashJson(
      [packet.packet_id, stageAdmission?.admission_id, availableCredit, decision],
      10,
    )}`,
    stage: packet.stage,
    action_class: packet.action_class,
    opening_credit: policy.baseCredit,
    base_credit: policy.baseCredit,
    evidence_freshness_bonus: freshnessBonus,
    torghut_repair_value_credit: repairCredit,
    rollout_truth_deposit: rolloutDeposit,
    failure_debt_tax: failureTax,
    controller_witness_tax: controllerTax,
    source_rollout_tax: sourceTax,
    capital_safety_tax: capitalTax,
    runner_capacity_tax: runnerDebt.tax,
    available_credit: availableCredit,
    minimum_spend: policy.minimumSpend,
    max_concurrent_runs: decision === 'allow' || decision === 'repair_only' ? policy.maxConcurrentRuns : 0,
    max_runtime_seconds: decision === 'allow' || decision === 'repair_only' ? policy.maxRuntimeSeconds : 0,
    max_notional: isCapitalAction(packet.action_class) ? 0 : policy.maxNotional,
    decision,
    reason_codes: reasonCodes,
    required_repair_actions: uniqueStrings([
      ...(packet.required_repair_action ? [packet.required_repair_action] : []),
      ...runnerDebt.requiredRepairActions,
      ...(selectedRepairLot && decision === 'repair_only' ? [`execute repair lot ${selectedRepairLot.lot_id}`] : []),
    ]),
    evidence_refs: uniqueStrings([
      packet.packet_id,
      stageAdmission?.admission_id,
      input.clearanceMarketLedger?.ledger_id,
      input.controllerWitness.quorum_id,
      input.torghutConsumerEvidence.receipt_id,
      input.projectionForeclosureNotary?.notary_id,
      ...runnerDebt.evidenceRefs,
      selectedRepairLot?.lot_id,
    ]),
    selected_repair_lot_ref: selectedRepairLot?.lot_id ?? null,
    rollback_target: packet.rollback_target || DEFAULT_ROLLBACK_TARGET,
  }
}

const buildFuture = (input: StageCreditLedgerInput, account: StageCreditAccount) => {
  if (account.decision !== 'allow' && account.decision !== 'repair_only') return null
  if (account.max_concurrent_runs <= 0) return null

  const reservedCredit = Math.min(account.available_credit, Math.max(account.minimum_spend, 1))
  return {
    future_id: `runner-slot-future:${hashJson([account.account_id, reservedCredit, input.now.toISOString()], 16)}`,
    account_id: account.account_id,
    stage: account.stage,
    action_class: account.action_class,
    reserved_credit: reservedCredit,
    expires_at: addSeconds(input.now, LEDGER_TTL_SECONDS).toISOString(),
    max_dispatches: account.max_concurrent_runs,
    max_runtime_seconds: account.max_runtime_seconds,
    max_notional: account.max_notional,
    spend_reason:
      account.decision === 'repair_only'
        ? `bounded repair: ${account.selected_repair_lot_ref ?? account.reason_codes[0] ?? 'repair'}`
        : `stage credit allow: ${account.action_class}`,
    required_receipts: requiredReceipts(input, account),
    settlement_state: 'open' as const,
    settlement_ref: null,
  }
}

const handoffStatus = (accounts: StageCreditAccount[]): StageCreditDecision =>
  strictestDecision(
    (accounts.some((account) => account.action_class === 'deploy_widen' || account.action_class === 'merge_ready')
      ? accounts.filter((account) => account.action_class === 'deploy_widen' || account.action_class === 'merge_ready')
      : accounts
    ).map((account) => account.decision),
  )

export const buildStageCreditLedger = (
  input: StageCreditLedgerInput,
  evidenceMode = resolveStageCreditEvidenceMode(),
): StageCreditLedger => {
  const consumeProjectionForeclosure = isProjectionForeclosureConsumptionEnabled()
  const accounts = input.stageClearancePackets.map((packet) =>
    buildAccount(input, packet, consumeProjectionForeclosure),
  )
  const futures = accounts
    .map((account) => buildFuture(input, account))
    .filter((future): future is NonNullable<typeof future> => Boolean(future))
  const freshUntil = addSeconds(input.now, LEDGER_TTL_SECONDS).toISOString()
  const creditEpochId = `stage-credit-epoch:${hashJson([
    input.namespace,
    input.clearanceMarketLedger?.ledger_id,
    accounts.map((account) => [account.account_id, account.decision, account.available_credit]),
  ])}`
  const ledgerDigest = hashJson({
    creditEpochId,
    accounts: accounts.map((account) => [account.account_id, account.decision, account.available_credit]),
    futures: futures.map((future) => future.future_id),
  })

  return {
    schema_version: STAGE_CREDIT_SCHEMA_VERSION,
    ledger_id: `stage-credit-ledger:${input.namespace}:${ledgerDigest}`,
    namespace: input.namespace,
    generated_at: input.now.toISOString(),
    fresh_until: freshUntil,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    observed_revision: {
      source_head_sha: input.clearanceMarketLedger?.observed_revision.source_head_sha ?? null,
      gitops_revision: input.clearanceMarketLedger?.observed_revision.gitops_revision ?? null,
    },
    evidence_mode: evidenceMode,
    credit_epoch_id: creditEpochId,
    stage_accounts: accounts,
    runner_slot_futures: futures,
    retained_failure_debt_refs: uniqueStrings(
      input.clearanceMarketLedger?.retained_failure_debt.map((debt) => debt.debt_id) ?? [],
    ),
    settlement_policy: {
      mode: 'read_model_only',
      refund_condition: 'terminal AgentRun succeeds and emits the required stage-credit receipts',
      burn_condition:
        'terminal AgentRun fails for a stage-owned reason or exhausts backoff without superseding success',
      conversion_condition: 'repair-only run closes the selected repair lot and unlocks normal stage credit',
      rollback_target: DEFAULT_ROLLBACK_TARGET,
    },
    handoff_contract: {
      value_gates: [
        'failed_agentrun_rate',
        'pr_to_rollout_latency',
        'ready_status_truth',
        'manual_intervention_count',
        'handoff_evidence_quality',
      ],
      status: handoffStatus(accounts),
      next_implementation_milestone: 'stamp swarmStageCredit* fields on launches admitted by stage clearance',
      rollback_target: DEFAULT_ROLLBACK_TARGET,
    },
  }
}
