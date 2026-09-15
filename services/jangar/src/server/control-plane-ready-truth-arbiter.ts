import { createHash } from 'node:crypto'
import process from 'node:process'

import type {
  ActionSloBudgetActionClass,
  AdmissionPassportStatus,
  ControlPlaneControllerWitnessQuorum,
  ExecutionTrustStatus,
  ProjectionForeclosureNotary,
  ReadyTruthActionDecision,
  ReadyTruthArbiter,
  ReadyTruthArbiterMode,
  ReadyTruthGateReceipt,
  ReadyTruthMaterialReadiness,
  ReadyTruthServingReadiness,
  RepairBidAdmissionState,
  RevenueRepairSettlementCustody,
  RepairBidAdmissionReceipt,
  SourceServingContractActionClass,
  SourceServingContractVerdict,
  SourceServingContractVerdictExchange,
  StageCreditAccount,
  StageCreditLedger,
  TorghutConsumerEvidenceStatus,
} from '~/server/control-plane-status-types'
import { isProjectionForeclosureConsumptionEnabled } from '~/server/control-plane-projection-foreclosure-notary'
import type {
  ControlPlaneRolloutHealth,
  DatabaseStatus,
  RuntimeAdapterStatus,
} from '~/server/control-plane-status-types'

export const READY_TRUTH_ARBITER_DESIGN_ARTIFACT =
  'docs/agents/designs/188-jangar-ready-truth-arbiter-and-stage-credit-cutover-2026-05-13.md'

const SCHEMA_VERSION = 'jangar.ready-truth-arbiter.v1' as const
const DEFAULT_TTL_SECONDS = 60
const ROLLBACK_TARGET = 'JANGAR_READY_TRUTH_ARBITER_MODE=observe'

const GOVERNING_DESIGN_REFS = [
  READY_TRUTH_ARBITER_DESIGN_ARTIFACT,
  'docs/agents/designs/187-jangar-stage-credit-ledger-and-runner-slot-futures-2026-05-13.md',
  'docs/agents/designs/187-jangar-main-source-ci-retention-and-source-serving-verdicts-2026-05-13.md',
  'docs/agents/designs/186-jangar-repair-bid-admission-and-settlement-custody-2026-05-13.md',
  'swarm-validation-contract:every-run-cites-governing-requirement',
]

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

const MATERIAL_GATE_ACTIONS: ActionSloBudgetActionClass[] = ['dispatch_normal', 'deploy_widen', 'merge_ready']

const DECISION_RANK: Record<ReadyTruthActionDecision, number> = {
  allow: 0,
  repair_only: 1,
  hold: 2,
  block: 3,
}

export type ReadyTruthArbiterInput = {
  now: Date
  namespace: string
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  runtimeAdapters: RuntimeAdapterStatus[]
  admissionPassports: AdmissionPassportStatus[]
  controllerWitness: ControlPlaneControllerWitnessQuorum
  executionTrust: ExecutionTrustStatus
  stageCreditLedger: StageCreditLedger | null
  sourceServingContractVerdictExchange: SourceServingContractVerdictExchange
  repairBidAdmission: RepairBidAdmissionState
  torghutConsumerEvidence: TorghutConsumerEvidenceStatus
  projectionForeclosureNotary?: ProjectionForeclosureNotary | null
  revenueRepairSettlementCustody?: RevenueRepairSettlementCustody | null
}

type ActionAssessment = {
  actionClass: ActionSloBudgetActionClass
  decision: ReadyTruthActionDecision
  reasonCodes: string[]
  evidenceRefs: string[]
}

export const resolveReadyTruthArbiterMode = (env: NodeJS.ProcessEnv = process.env): ReadyTruthArbiterMode => {
  const normalized = env.JANGAR_READY_TRUTH_ARBITER_MODE?.trim().toLowerCase()
  if (normalized === 'observe' || normalized === 'hold' || normalized === 'enforce') return normalized
  return 'shadow'
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (value: Date, seconds: number) => new Date(value.getTime() + seconds * 1000)

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const strictestDecision = (decisions: ReadyTruthActionDecision[]): ReadyTruthActionDecision => {
  let strictest: ReadyTruthActionDecision = 'allow'
  for (const decision of decisions) {
    if (DECISION_RANK[decision] > DECISION_RANK[strictest]) strictest = decision
  }
  return strictest
}

const servingPassport = (passports: AdmissionPassportStatus[]) =>
  passports.find((passport) => passport.consumer_class === 'serving') ?? null

const buildServingReadiness = (input: ReadyTruthArbiterInput): ReadyTruthServingReadiness => {
  const passport = servingPassport(input.admissionPassports)
  if (!passport || passport.decision === 'block' || passport.decision === 'hold') return 'down'
  if (input.database.status === 'disabled' || !input.database.connected) return 'down'
  if (
    input.database.status !== 'healthy' ||
    input.database.migration_consistency.status !== 'healthy' ||
    input.rolloutHealth.status !== 'healthy'
  ) {
    return 'degraded'
  }
  return 'ok'
}

const workloadRolloutRef = (rolloutHealth: ControlPlaneRolloutHealth) =>
  `rollout:${rolloutHealth.status}:${rolloutHealth.observed_deployments}:${rolloutHealth.degraded_deployments}`

const runtimeAdapterRef = (adapter: RuntimeAdapterStatus) =>
  `runtime-adapter:${adapter.name}:${adapter.status}:${adapter.available ? 'available' : 'unavailable'}`

const sourceActionFor = (actionClass: ActionSloBudgetActionClass): SourceServingContractActionClass | null => {
  if (
    actionClass === 'serve_readonly' ||
    actionClass === 'dispatch_repair' ||
    actionClass === 'dispatch_normal' ||
    actionClass === 'deploy_widen' ||
    actionClass === 'merge_ready'
  ) {
    return actionClass
  }
  if (actionClass === 'paper_canary') return 'paper_support'
  if (actionClass === 'live_micro_canary' || actionClass === 'live_scale') return 'live_support'
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
  repairBidAdmission: RepairBidAdmissionState,
  actionClass: ActionSloBudgetActionClass,
): RepairBidAdmissionReceipt | null =>
  repairBidAdmission.receipts.find((receipt) => receipt.action_class === actionClass) ?? null

const stageAccountsFor = (stageCreditLedger: StageCreditLedger | null, actionClass: ActionSloBudgetActionClass) =>
  stageCreditLedger?.stage_accounts.filter((account) => account.action_class === actionClass) ?? []

const stageCreditDecisionFor = (
  stageCreditLedger: StageCreditLedger | null,
  actionClass: ActionSloBudgetActionClass,
) => {
  if (!stageCreditLedger) {
    return {
      decision: 'hold' as ReadyTruthActionDecision,
      reasonCodes: ['stage_credit_ledger_missing'],
      evidenceRefs: [],
    }
  }

  const accounts = stageAccountsFor(stageCreditLedger, actionClass)
  if (accounts.length === 0) {
    return {
      decision: 'hold' as ReadyTruthActionDecision,
      reasonCodes: ['stage_credit_account_missing'],
      evidenceRefs: [stageCreditLedger.ledger_id],
    }
  }

  return {
    decision: strictestDecision(accounts.map((account) => account.decision)),
    reasonCodes: accounts.flatMap((account) => account.reason_codes),
    evidenceRefs: [stageCreditLedger.ledger_id, ...accounts.map((account) => account.account_id)],
  }
}

const coreRuntimeReasons = (input: ReadyTruthArbiterInput) => {
  const reasons: string[] = []
  const evidenceRefs: string[] = []

  if (input.database.status !== 'healthy') reasons.push(`database_${input.database.status}`)
  if (input.database.migration_consistency.status !== 'healthy') {
    reasons.push(`database_migrations_${input.database.migration_consistency.status}`)
  }
  if (input.rolloutHealth.status !== 'healthy') reasons.push(`rollout_health_${input.rolloutHealth.status}`)
  if (input.controllerWitness.decision !== 'allow')
    reasons.push(`controller_witness_${input.controllerWitness.decision}`)
  evidenceRefs.push(input.controllerWitness.quorum_id)

  for (const adapter of input.runtimeAdapters) {
    if (adapter.name !== 'workflow' && adapter.name !== 'job') continue
    if (!adapter.available || (adapter.status !== 'healthy' && adapter.status !== 'configured')) {
      reasons.push(`runtime_adapter_${normalizeReason(adapter.name)}_${adapter.status}`)
    }
    evidenceRefs.push(runtimeAdapterRef(adapter))
  }

  if (input.executionTrust.status !== 'healthy') reasons.push(`execution_trust_${input.executionTrust.status}`)

  return { reasons: uniqueStrings(reasons), evidenceRefs: uniqueStrings(evidenceRefs) }
}

const sourceReasons = (
  input: ReadyTruthArbiterInput,
  actionClass: ActionSloBudgetActionClass,
  allowRepairOnly: boolean,
) => {
  const verdict = sourceVerdictFor(input.sourceServingContractVerdictExchange, actionClass)
  if (!verdict) return { reasons: [] as string[], evidenceRefs: [] as string[] }
  const acceptable = verdict.decision === 'allow' || (allowRepairOnly && verdict.decision === 'repair_only')
  return {
    reasons: acceptable ? [] : uniqueStrings([`source_serving_${verdict.decision}`, ...verdict.blocking_reason_codes]),
    evidenceRefs: [input.sourceServingContractVerdictExchange.exchange_id, verdict.verdict_id],
  }
}

const repairBidReasons = (
  input: ReadyTruthArbiterInput,
  actionClass: ActionSloBudgetActionClass,
  allowRepairOnly: boolean,
) => {
  const receipt = repairReceiptFor(input.repairBidAdmission, actionClass)
  if (!receipt) return { reasons: ['repair_bid_admission_receipt_missing'], evidenceRefs: [] as string[] }
  const acceptable = receipt.decision === 'allow' || (allowRepairOnly && receipt.decision === 'repair_only')
  return {
    reasons: acceptable ? [] : uniqueStrings([`repair_bid_${receipt.decision}`, ...receipt.denied_reason_codes]),
    evidenceRefs: uniqueStrings([input.repairBidAdmission.torghut_settlement_ledger_ref, receipt.receipt_id]),
  }
}

const projectionAuthorityReasons = (
  input: ReadyTruthArbiterInput,
  actionClass: ActionSloBudgetActionClass,
  allowRepairOnly: boolean,
) => {
  const notary = input.projectionForeclosureNotary
  if (!notary || !isProjectionForeclosureConsumptionEnabled())
    return { reasons: [] as string[], evidenceRefs: [] as string[] }
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe') {
    return { reasons: [] as string[], evidenceRefs: [notary.notary_id] }
  }

  const totals = notary.claim_totals_by_state
  const hardHold = totals.unknown + totals.contradictory
  const missingReceipt = totals.missing_receipt
  const reasons = [
    ...(hardHold > 0 ? ['projection_foreclosure_authority_hold'] : []),
    ...(totals.unknown > 0 ? ['projection_foreclosure_unknown'] : []),
    ...(totals.contradictory > 0 ? ['projection_foreclosure_contradictory'] : []),
    ...(missingReceipt > 0 && !allowRepairOnly ? ['projection_foreclosure_missing_receipt'] : []),
  ]

  return { reasons, evidenceRefs: [notary.notary_id] }
}

const revenueRepairCustodyReasons = (input: ReadyTruthArbiterInput, actionClass: ActionSloBudgetActionClass) => {
  const custody = input.revenueRepairSettlementCustody
  if (!custody || actionClass !== 'dispatch_repair') {
    return { reasons: [] as string[], evidenceRefs: [] as string[] }
  }
  if (custody.decision === 'allow') {
    return { reasons: [] as string[], evidenceRefs: [custody.custody_id] }
  }
  return {
    reasons: uniqueStrings([`revenue_repair_settlement_custody_${custody.decision}`, ...custody.reason_codes]),
    evidenceRefs: uniqueStrings([custody.custody_id, ...custody.evidence_refs]),
  }
}

const assessServeReadonly = (
  input: ReadyTruthArbiterInput,
  servingReadiness: ReadyTruthServingReadiness,
): ActionAssessment => ({
  actionClass: 'serve_readonly',
  decision: servingReadiness === 'down' ? 'block' : 'allow',
  reasonCodes: servingReadiness === 'down' ? ['serving_readiness_down'] : [],
  evidenceRefs: uniqueStrings([servingPassport(input.admissionPassports)?.admission_passport_id]),
})

const assessTorghutObserve = (input: ReadyTruthArbiterInput): ActionAssessment => {
  const unavailable = input.torghutConsumerEvidence.status === 'unavailable'
  return {
    actionClass: 'torghut_observe',
    decision: unavailable ? 'hold' : 'allow',
    reasonCodes: unavailable ? ['torghut_consumer_evidence_unavailable'] : [],
    evidenceRefs: uniqueStrings([input.torghutConsumerEvidence.receipt_id]),
  }
}

const actionDecision = (input: {
  actionClass: ActionSloBudgetActionClass
  reasons: string[]
  stageDecision: ReadyTruthActionDecision
  repairAvailable: boolean
  revenueRepairCustodyDecision?: RevenueRepairSettlementCustody['decision'] | null
}) => {
  if (input.reasons.includes('execution_trust_blocked') || input.reasons.includes('database_disabled')) return 'block'
  if (input.actionClass === 'live_micro_canary' || input.actionClass === 'live_scale') {
    return input.reasons.length > 0 ? 'block' : ('allow' as ReadyTruthActionDecision)
  }
  if (input.actionClass === 'dispatch_repair') {
    if (input.revenueRepairCustodyDecision === 'deny') return 'block'
    if (input.revenueRepairCustodyDecision === 'hold') return 'hold'
    return input.repairAvailable && input.reasons.length === 0 ? 'repair_only' : ('hold' as ReadyTruthActionDecision)
  }
  if (input.stageDecision === 'block') return 'block'
  return input.reasons.length > 0 ? 'hold' : ('allow' as ReadyTruthActionDecision)
}

const assessMaterialAction = (
  input: ReadyTruthArbiterInput,
  actionClass: ActionSloBudgetActionClass,
): ActionAssessment => {
  const allowRepairOnly = actionClass === 'dispatch_repair'
  const core = coreRuntimeReasons(input)
  const source = sourceReasons(input, actionClass, allowRepairOnly)
  const repairBid = repairBidReasons(input, actionClass, allowRepairOnly)
  const stageCredit = stageCreditDecisionFor(input.stageCreditLedger, actionClass)
  const projectionAuthority = projectionAuthorityReasons(input, actionClass, allowRepairOnly)
  const revenueRepairCustody = revenueRepairCustodyReasons(input, actionClass)
  const reasons = uniqueStrings([
    ...core.reasons,
    ...source.reasons,
    ...repairBid.reasons,
    ...projectionAuthority.reasons,
    ...revenueRepairCustody.reasons,
    ...(stageCredit.decision === 'allow' || (allowRepairOnly && stageCredit.decision === 'repair_only')
      ? []
      : [`stage_credit_${stageCredit.decision}`, ...stageCredit.reasonCodes]),
  ]).map(normalizeReason)
  const repairAvailable =
    actionClass === 'dispatch_repair' &&
    repairReceiptFor(input.repairBidAdmission, actionClass)?.decision === 'allow' &&
    (stageCredit.decision === 'allow' || stageCredit.decision === 'repair_only')

  return {
    actionClass,
    decision: actionDecision({
      actionClass,
      reasons,
      stageDecision: stageCredit.decision,
      repairAvailable,
      revenueRepairCustodyDecision:
        actionClass === 'dispatch_repair' ? input.revenueRepairSettlementCustody?.decision : null,
    }),
    reasonCodes: reasons,
    evidenceRefs: uniqueStrings([
      ...core.evidenceRefs,
      ...source.evidenceRefs,
      ...repairBid.evidenceRefs,
      ...projectionAuthority.evidenceRefs,
      ...revenueRepairCustody.evidenceRefs,
      ...stageCredit.evidenceRefs,
    ]),
  }
}

const assessActions = (
  input: ReadyTruthArbiterInput,
  servingReadiness: ReadyTruthServingReadiness,
): ActionAssessment[] =>
  ACTION_CLASSES.map((actionClass) => {
    if (actionClass === 'serve_readonly') return assessServeReadonly(input, servingReadiness)
    if (actionClass === 'torghut_observe') return assessTorghutObserve(input)
    return assessMaterialAction(input, actionClass)
  })

const materialReadiness = (input: {
  servingReadiness: ReadyTruthServingReadiness
  assessments: ActionAssessment[]
}): ReadyTruthMaterialReadiness => {
  if (input.servingReadiness === 'down') return 'block'
  const byAction = new Map(input.assessments.map((assessment) => [assessment.actionClass, assessment]))
  const gateDecisions = MATERIAL_GATE_ACTIONS.map((action) => byAction.get(action)?.decision ?? 'hold')
  if (gateDecisions.some((decision) => decision === 'block')) return 'block'
  if (gateDecisions.every((decision) => decision === 'allow')) return 'allow'
  const repairDecision = byAction.get('dispatch_repair')?.decision
  return repairDecision === 'repair_only' || repairDecision === 'allow' ? 'repair_only' : 'hold'
}

const gateReceipt = (input: {
  now: Date
  namespace: string
  actionClass: ActionSloBudgetActionClass
  assessment: ActionAssessment
}) =>
  ({
    receipt_id: `ready-truth-gate:${input.actionClass}:${hashJson([
      input.namespace,
      input.actionClass,
      input.assessment.decision,
      input.assessment.evidenceRefs,
      input.now.toISOString(),
    ])}`,
    action_class: input.actionClass,
    decision: input.assessment.decision,
    required_evidence_refs: input.assessment.evidenceRefs,
    reason_codes: input.assessment.reasonCodes,
  }) satisfies ReadyTruthGateReceipt

export const buildReadyTruthArbiter = (
  input: ReadyTruthArbiterInput,
  mode = resolveReadyTruthArbiterMode(),
): ReadyTruthArbiter => {
  const servingReadiness = buildServingReadiness(input)
  const assessments = assessActions(input, servingReadiness)
  const material = materialReadiness({ servingReadiness, assessments })
  const byDecision = (decision: ReadyTruthActionDecision) =>
    assessments.filter((assessment) => assessment.decision === decision).map((assessment) => assessment.actionClass)
  const reasons = uniqueStrings(assessments.flatMap((assessment) => assessment.reasonCodes)).map(normalizeReason)
  const mergeAssessment =
    assessments.find((assessment) => assessment.actionClass === 'merge_ready') ??
    assessMaterialAction(input, 'merge_ready')
  const deployAssessment =
    assessments.find((assessment) => assessment.actionClass === 'deploy_widen') ??
    assessMaterialAction(input, 'deploy_widen')
  const retainedFailureDebtRefs =
    input.stageCreditLedger?.retained_failure_debt_refs ??
    input.stageCreditLedger?.stage_accounts.flatMap((account: StageCreditAccount) => account.evidence_refs) ??
    []
  const verdictId = `ready-truth-arbiter:${input.namespace}:${hashJson({
    serving_readiness: servingReadiness,
    material_readiness: material,
    action_decisions: assessments.map((assessment) => [assessment.actionClass, assessment.decision]),
    stage_credit_ledger_ref: input.stageCreditLedger?.ledger_id ?? null,
    source_serving_verdict_ref: input.sourceServingContractVerdictExchange.exchange_id,
    repair_bid_ref: input.repairBidAdmission.torghut_settlement_ledger_ref,
    projection_foreclosure_notary_ref: input.projectionForeclosureNotary?.notary_id ?? null,
    revenue_repair_settlement_custody_ref: input.revenueRepairSettlementCustody?.custody_id ?? null,
  })}`

  return {
    schema_version: SCHEMA_VERSION,
    mode,
    verdict_id: verdictId,
    generated_at: input.now.toISOString(),
    fresh_until: addSeconds(input.now, DEFAULT_TTL_SECONDS).toISOString(),
    namespace: input.namespace,
    governing_design_refs: GOVERNING_DESIGN_REFS,
    serving_readiness: servingReadiness,
    material_readiness: material,
    argo_revision: input.stageCreditLedger?.observed_revision.gitops_revision ?? null,
    argo_health: input.rolloutHealth.status,
    workload_rollout_ref: workloadRolloutRef(input.rolloutHealth),
    controller_witness_ref: input.controllerWitness.quorum_id,
    runtime_adapter_refs: input.runtimeAdapters.map(runtimeAdapterRef),
    stage_credit_ledger_ref: input.stageCreditLedger?.ledger_id ?? null,
    source_serving_verdict_ref: input.sourceServingContractVerdictExchange.exchange_id,
    torghut_repair_receipt_ref: input.repairBidAdmission.torghut_settlement_ledger_ref,
    retained_failure_debt_refs: uniqueStrings(retainedFailureDebtRefs),
    projection_foreclosure_notary_ref: input.projectionForeclosureNotary?.notary_id ?? null,
    projection_authority_decision: input.projectionForeclosureNotary?.decision ?? null,
    projection_claim_totals_by_state: input.projectionForeclosureNotary?.claim_totals_by_state ?? null,
    projection_required_repair_actions: input.projectionForeclosureNotary?.required_repair_actions ?? [],
    revenue_repair_settlement_custody_ref: input.revenueRepairSettlementCustody?.custody_id ?? null,
    revenue_repair_settlement_custody_decision: input.revenueRepairSettlementCustody?.decision ?? null,
    revenue_repair_settlement_custody_reasons: input.revenueRepairSettlementCustody?.reason_codes ?? [],
    ready_status_truth_reasons: reasons,
    allowed_action_classes: byDecision('allow'),
    repair_only_action_classes: byDecision('repair_only'),
    held_action_classes: byDecision('hold'),
    blocked_action_classes: byDecision('block'),
    merge_gate_receipt: gateReceipt({
      now: input.now,
      namespace: input.namespace,
      actionClass: 'merge_ready',
      assessment: mergeAssessment,
    }),
    deployer_receipt: gateReceipt({
      now: input.now,
      namespace: input.namespace,
      actionClass: 'deploy_widen',
      assessment: deployAssessment,
    }),
    rollback_target: ROLLBACK_TARGET,
  }
}
