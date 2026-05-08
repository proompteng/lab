import { createHash } from 'node:crypto'

import type {
  ActionSloBudget,
  ActionSloBudgetActionClass,
  ActionSloBudgetDecision,
  ControlPlaneControllerWitnessQuorum,
  DependencyQuorumStatus,
  EmpiricalServicesStatus,
  ExecutionTrustStatus,
  FailureDomainHoldbackDecision,
  FailureDomainLeaseSet,
  NegativeEvidenceKind,
  NegativeEvidenceRef,
  NegativeEvidenceRouterStatus,
  RuntimeKitStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import type {
  AgentRunIngestionStatus,
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const NEGATIVE_EVIDENCE_ROUTER_DESIGN_ARTIFACT =
  'docs/agents/designs/111-jangar-negative-evidence-router-and-action-slo-budgets-2026-05-06.md'

const DEFAULT_EVIDENCE_WINDOW_MINUTES = 15
const DEFAULT_REPAIR_MAX_RUNTIME_SECONDS = 20 * 60
const DEFAULT_DISPATCH_MAX_RUNTIME_SECONDS = 45 * 60
const DEFAULT_DEPLOY_MAX_RUNTIME_SECONDS = 30 * 60
const DEFAULT_OBSERVE_MAX_RUNTIME_SECONDS = 10 * 60

type BudgetConsumer = ActionSloBudget['consumer']

export type TorghutNegativeEvidenceInput = {
  readiness_status?: 'healthy' | 'degraded' | 'unknown'
  readyz_status_code?: number | null
  market_context_status?: 'healthy' | 'degraded' | 'stale' | 'unknown'
  market_context_stale_domains?: string[]
  open_quant_alerts?: number
  critical_quant_alerts?: number
  rollout_ambiguity_refs?: string[]
  paper_settlement_clean?: boolean
  consumer_evidence_receipt_id?: string | null
  consumer_evidence_status?: 'current' | 'stale' | 'missing' | 'unavailable' | 'route_missing' | 'schema_mismatch'
  consumer_evidence_fresh_until?: string | null
  consumer_evidence_reason_codes?: string[]
  capital_reentry_cohort_ledger_id?: string | null
  capital_reentry_aggregate_state?: string | null
  capital_reentry_cohort_ids?: string[]
  capital_reentry_blocking_reason_codes?: string[]
  profit_repair_settlement_ledger_id?: string | null
  profit_repair_aggregate_state?: string | null
  profit_repair_lot_ids?: string[]
  profit_repair_blocking_reason_codes?: string[]
  routeability_repair_acceptance_ledger_id?: string | null
  routeability_aggregate_state?: string | null
  routeability_lot_ids?: string[]
  routeability_blocking_reason_codes?: string[]
  accepted_routeable_candidate_count?: number | null
}

export type NegativeEvidenceRouterInput = {
  now: Date
  namespace: string
  service: string
  workflows: WorkflowsReliabilityStatus
  watchReliability: ControlPlaneWatchReliability
  agentRunIngestion: AgentRunIngestionStatus
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  dependencyQuorum: DependencyQuorumStatus
  failureDomainLeases: FailureDomainLeaseSet
  empiricalServices: EmpiricalServicesStatus
  executionTrust: ExecutionTrustStatus
  runtimeKits: RuntimeKitStatus[]
  controllerWitness?: ControlPlaneControllerWitnessQuorum
  retainedAuditFailureRefs?: string[]
  torghut?: TorghutNegativeEvidenceInput
}

export type NegativeEvidenceRouterResult = {
  router: NegativeEvidenceRouterStatus
  budgets: ActionSloBudget[]
  torghutBudgets: ActionSloBudget[]
}

type EvidenceMap = Map<NegativeEvidenceKind, Map<string, Set<string>>>

type BudgetSpec = {
  actionClass: ActionSloBudgetActionClass
  consumer: BudgetConsumer
  maxDispatches: number | null
  maxRuntimeSeconds: number | null
  maxNotional: number | null
  maxErrorBudgetSpend: number | null
}

const budgetSpecRows = [
  ['serve_readonly', 'jangar', 0, null, 0, 0.02],
  ['dispatch_repair', 'engineer', 1, DEFAULT_REPAIR_MAX_RUNTIME_SECONDS, 0, 0.1],
  ['dispatch_normal', 'agents', 5, DEFAULT_DISPATCH_MAX_RUNTIME_SECONDS, 0, 0.05],
  ['deploy_widen', 'deployer', 1, DEFAULT_DEPLOY_MAX_RUNTIME_SECONDS, 0, 0.01],
  ['merge_ready', 'deployer', 0, null, 0, 0],
  ['torghut_observe', 'torghut', 3, DEFAULT_OBSERVE_MAX_RUNTIME_SECONDS, 0, 0.05],
  ['paper_canary', 'torghut-sim', 1, DEFAULT_OBSERVE_MAX_RUNTIME_SECONDS, 0, 0.02],
  ['live_micro_canary', 'torghut', 0, null, 0, 0],
  ['live_scale', 'torghut', 0, null, 0, 0],
] satisfies readonly [
  ActionSloBudgetActionClass,
  BudgetConsumer,
  number | null,
  number | null,
  number | null,
  number | null,
][]

const budgetSpecs: BudgetSpec[] = budgetSpecRows.map(
  ([actionClass, consumer, maxDispatches, maxRuntimeSeconds, maxNotional, maxErrorBudgetSpend]) => ({
    actionClass,
    consumer,
    maxDispatches,
    maxRuntimeSeconds,
    maxNotional,
    maxErrorBudgetSpend,
  }),
)

const budgetActionClasses = new Set<ActionSloBudgetActionClass>(budgetSpecs.map((spec) => spec.actionClass))

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.trim().length > 0))]

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60 * 1000)

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const evidenceRef = (prefix: string, value: string | number | null | undefined) => `${prefix}:${value ?? 'unknown'}`

const addEvidence = (map: EvidenceMap, kind: NegativeEvidenceKind, reason: string, refs: string[] = []) => {
  const normalizedReason = normalizeReason(reason)
  const byReason = map.get(kind) ?? new Map<string, Set<string>>()
  const current = byReason.get(normalizedReason) ?? new Set<string>()
  for (const ref of refs) {
    if (ref.trim().length > 0) current.add(ref)
  }
  if (current.size === 0) current.add(`${kind}:${normalizedReason}`)
  byReason.set(normalizedReason, current)
  map.set(kind, byReason)
}

const flattenEvidence = (map: EvidenceMap): NegativeEvidenceRef[] => {
  const entries: NegativeEvidenceRef[] = []
  for (const [kind, byReason] of map) {
    for (const [reason, refs] of byReason) {
      entries.push({
        kind,
        reason,
        evidence_refs: [...refs].sort(),
      })
    }
  }
  return entries.sort((left, right) => `${left.kind}:${left.reason}`.localeCompare(`${right.kind}:${right.reason}`))
}

const collectReasons = (refs: NegativeEvidenceRef[], kinds: NegativeEvidenceKind[]) =>
  refs.filter((ref) => kinds.includes(ref.kind)).map((ref) => ref.reason)

const collectEvidenceRefs = (refs: NegativeEvidenceRef[], reasons: string[]) =>
  uniqueStrings(refs.filter((ref) => reasons.includes(ref.reason)).flatMap((ref) => ref.evidence_refs))

const holdbackByAction = (leases: FailureDomainLeaseSet) => {
  const byAction = new Map<ActionSloBudgetActionClass, FailureDomainHoldbackDecision>()
  for (const holdback of leases.holdbacks) {
    if (holdback.action_class === 'torghut_capital') {
      byAction.set('paper_canary', holdback)
      byAction.set('live_micro_canary', holdback)
      byAction.set('live_scale', holdback)
      continue
    }

    const actionClass = holdback.action_class as ActionSloBudgetActionClass
    if (budgetActionClasses.has(actionClass)) {
      byAction.set(actionClass, holdback)
    }
  }
  return byAction
}

const holdbackReasons = (
  holdbacks: Map<ActionSloBudgetActionClass, FailureDomainHoldbackDecision>,
  actionClass: ActionSloBudgetActionClass,
) => {
  const holdback = holdbacks.get(actionClass)
  if (!holdback || holdback.decision === 'allow') return []
  if (holdback.reason_codes.length > 0) return holdback.reason_codes
  return [`failure_domain_${holdback.decision}`]
}

const buildPositiveRefs = (input: NegativeEvidenceRouterInput) => {
  const refs: string[] = []
  if (input.database.status === 'healthy' && input.database.connected) {
    refs.push('database:projection:healthy')
  }
  if (input.rolloutHealth.status === 'healthy') {
    refs.push('rollout:healthy')
  }
  if (input.watchReliability.status === 'healthy') {
    refs.push('watch_reliability:healthy')
  }
  if (input.executionTrust.status === 'healthy') {
    refs.push('execution_trust:healthy')
  }
  if (input.torghut?.consumer_evidence_status === 'current' && input.torghut.consumer_evidence_receipt_id) {
    refs.push(input.torghut.consumer_evidence_receipt_id)
  }
  if (input.torghut?.capital_reentry_cohort_ledger_id) {
    refs.push(input.torghut.capital_reentry_cohort_ledger_id)
  }
  if (input.torghut?.profit_repair_settlement_ledger_id) {
    refs.push(input.torghut.profit_repair_settlement_ledger_id)
  }
  if (
    input.controllerWitness &&
    (input.controllerWitness.decision === 'allow' || input.controllerWitness.decision === 'allow_with_split')
  ) {
    refs.push(input.controllerWitness.quorum_id)
  }
  refs.push(...input.runtimeKits.filter((kit) => kit.decision === 'healthy').map((kit) => kit.runtime_kit_id))
  refs.push(
    ...input.failureDomainLeases.leases.filter((lease) => lease.status === 'valid').map((lease) => lease.lease_id),
  )
  return uniqueStrings(refs).sort()
}

const buildNegativeEvidenceRefs = (input: NegativeEvidenceRouterInput) => {
  const evidence: EvidenceMap = new Map()

  if (input.watchReliability.status === 'degraded') {
    const streamRefs = input.watchReliability.streams
      .filter((stream) => stream.errors > 0 || stream.restarts > 0)
      .map((stream) => `watch:${stream.namespace}:${stream.resource}`)
    addEvidence(evidence, 'current_runtime_negative', 'watch_reliability_degraded', streamRefs)
  }

  if (input.agentRunIngestion.status !== 'healthy') {
    if (input.controllerWitness?.reason_codes.includes('controller_witness_split')) {
      addEvidence(evidence, 'current_runtime_negative', 'controller_witness_split', [
        input.controllerWitness.quorum_id,
        ...input.controllerWitness.witness_refs,
      ])
    } else if (input.controllerWitness?.reason_codes.includes('controller_ingestion_stalled')) {
      addEvidence(evidence, 'current_runtime_negative', 'controller_ingestion_stalled', [
        input.controllerWitness.quorum_id,
        ...input.controllerWitness.witness_refs,
      ])
    } else if (
      input.controllerWitness &&
      (input.controllerWitness.decision === 'allow' || input.controllerWitness.decision === 'allow_with_split')
    ) {
      // The controller witness is authoritative for this split-topology process.
    } else {
      addEvidence(evidence, 'current_runtime_negative', `agentrun_ingestion_${input.agentRunIngestion.status}`, [
        `agentrun_ingestion:${input.agentRunIngestion.namespace}`,
      ])
    }
  }

  if (input.workflows.recent_failed_jobs > 0) {
    addEvidence(evidence, 'current_runtime_negative', 'workflow_recent_failures', [
      evidenceRef('workflows:recent_failed_jobs', input.workflows.recent_failed_jobs),
      ...input.workflows.top_failure_reasons.map((entry) => `workflow_reason:${entry.reason}`),
    ])
  }

  if (input.workflows.backoff_limit_exceeded_jobs > 0) {
    addEvidence(evidence, 'current_runtime_negative', 'workflow_backoff_limit_exceeded', [
      evidenceRef('workflows:backoff_limit_exceeded_jobs', input.workflows.backoff_limit_exceeded_jobs),
    ])
  }

  if (input.workflows.data_confidence !== 'high') {
    addEvidence(evidence, 'current_runtime_negative', `workflow_data_${input.workflows.data_confidence}`, [
      `workflows:data_confidence:${input.workflows.data_confidence}`,
    ])
  }

  if (input.executionTrust.status !== 'healthy') {
    addEvidence(evidence, 'current_runtime_negative', `execution_trust_${input.executionTrust.status}`, [
      ...input.executionTrust.evidence_summary,
      ...input.executionTrust.blocking_windows.map((window) => `execution_trust:${window.scope}:${window.reason}`),
    ])
  }

  for (const ref of input.retainedAuditFailureRefs ?? []) {
    addEvidence(evidence, 'retained_audit_negative', 'retained_historical_failures', [ref])
  }

  if (input.database.migration_consistency.status !== 'healthy') {
    addEvidence(evidence, 'source_schema_negative', `source_schema_${input.database.migration_consistency.status}`, [
      evidenceRef('source_schema:latest_registered', input.database.migration_consistency.latest_registered),
    ])
  }

  if (input.empiricalServices.jobs.status !== 'healthy') {
    addEvidence(evidence, 'data_freshness_negative', `empirical_jobs_${input.empiricalServices.jobs.status}`, [
      input.empiricalServices.jobs.endpoint || 'empirical_jobs:endpoint:unknown',
    ])
  }

  for (const job of input.empiricalServices.jobs.stale_jobs ?? []) {
    addEvidence(evidence, 'data_freshness_negative', 'empirical_jobs_stale', [`empirical_job:${job}`])
  }

  const torghut = input.torghut
  if (torghut) {
    const consumerEvidenceRef = torghut.consumer_evidence_receipt_id ?? 'torghut_consumer_evidence:missing'
    if (torghut.consumer_evidence_status && torghut.consumer_evidence_status !== 'current') {
      addEvidence(
        evidence,
        'data_freshness_negative',
        `torghut_consumer_evidence_${torghut.consumer_evidence_status}`,
        [consumerEvidenceRef],
      )
    }
    for (const reason of torghut.consumer_evidence_reason_codes ?? []) {
      addEvidence(evidence, 'data_freshness_negative', reason, [consumerEvidenceRef])
    }

    const cohortRefs = uniqueStrings([
      torghut.capital_reentry_cohort_ledger_id ?? '',
      ...(torghut.capital_reentry_cohort_ids ?? []),
    ])
    if (
      torghut.capital_reentry_aggregate_state &&
      !['observe', 'paper_candidate'].includes(torghut.capital_reentry_aggregate_state)
    ) {
      addEvidence(
        evidence,
        'data_freshness_negative',
        `capital_reentry_${torghut.capital_reentry_aggregate_state}`,
        cohortRefs.length > 0 ? cohortRefs : [consumerEvidenceRef],
      )
    }
    for (const reason of torghut.capital_reentry_blocking_reason_codes ?? []) {
      addEvidence(
        evidence,
        'data_freshness_negative',
        reason,
        cohortRefs.length > 0 ? cohortRefs : [consumerEvidenceRef],
      )
    }

    const profitRepairRefs = uniqueStrings([
      torghut.profit_repair_settlement_ledger_id ?? '',
      ...(torghut.profit_repair_lot_ids ?? []),
    ])
    if (
      torghut.profit_repair_aggregate_state &&
      !['observe', 'paper_candidate'].includes(torghut.profit_repair_aggregate_state)
    ) {
      addEvidence(
        evidence,
        'data_freshness_negative',
        `profit_repair_${torghut.profit_repair_aggregate_state}`,
        profitRepairRefs.length > 0 ? profitRepairRefs : [consumerEvidenceRef],
      )
    }
    for (const reason of torghut.profit_repair_blocking_reason_codes ?? []) {
      addEvidence(
        evidence,
        'data_freshness_negative',
        reason,
        profitRepairRefs.length > 0 ? profitRepairRefs : [consumerEvidenceRef],
      )
    }

    const routeabilityRefs = uniqueStrings([
      torghut.routeability_repair_acceptance_ledger_id ?? '',
      ...(torghut.routeability_lot_ids ?? []),
    ])
    if (torghut.routeability_aggregate_state && !['accepted'].includes(torghut.routeability_aggregate_state)) {
      addEvidence(
        evidence,
        'data_freshness_negative',
        `routeability_acceptance_${torghut.routeability_aggregate_state}`,
        routeabilityRefs.length > 0 ? routeabilityRefs : [consumerEvidenceRef],
      )
    }
    for (const reason of torghut.routeability_blocking_reason_codes ?? []) {
      addEvidence(
        evidence,
        'data_freshness_negative',
        reason,
        routeabilityRefs.length > 0 ? routeabilityRefs : [consumerEvidenceRef],
      )
    }

    if (torghut.readiness_status && torghut.readiness_status !== 'healthy') {
      addEvidence(evidence, 'data_freshness_negative', `torghut_readiness_${torghut.readiness_status}`, [
        evidenceRef('torghut:readyz', torghut.readyz_status_code),
      ])
    }

    if (torghut.market_context_status && torghut.market_context_status !== 'healthy') {
      const domains = torghut.market_context_stale_domains ?? []
      const refs = domains.length > 0 ? domains.map((domain) => `market_context:${domain}`) : ['market_context']
      addEvidence(evidence, 'data_freshness_negative', `market_context_${torghut.market_context_status}`, refs)
    }

    if ((torghut.open_quant_alerts ?? 0) > 0) {
      addEvidence(evidence, 'data_freshness_negative', 'quant_alerts_open', [
        evidenceRef('quant_alerts:open', torghut.open_quant_alerts),
      ])
    }

    if ((torghut.critical_quant_alerts ?? 0) > 0) {
      addEvidence(evidence, 'data_freshness_negative', 'quant_alerts_critical', [
        evidenceRef('quant_alerts:critical', torghut.critical_quant_alerts),
      ])
    }

    for (const ref of torghut.rollout_ambiguity_refs ?? []) {
      addEvidence(evidence, 'rollout_ambiguity_negative', 'rollout_ambiguity', [ref])
    }
  }

  const deployHoldback = input.failureDomainLeases.holdbacks.find(
    (holdback) => holdback.action_class === 'deploy_widen',
  )
  if (deployHoldback && deployHoldback.decision !== 'allow') {
    addEvidence(evidence, 'rollout_ambiguity_negative', 'failure_domain_deploy_widen_holdback', [
      ...deployHoldback.lease_ids,
      ...deployHoldback.reason_codes.map((reason) => `failure_domain:${reason}`),
    ])
  }

  return flattenEvidence(evidence)
}

const hasReason = (reasons: string[], candidates: string[]) => reasons.some((reason) => candidates.includes(reason))

const buildRequiredRepairs = (reasons: string[]) =>
  uniqueStrings(
    reasons.map((reason) => {
      if (reason.includes('market_context')) return 'refresh Torghut market-context snapshots'
      if (reason.includes('quant_alert')) return 'resolve or supersede open quant alerts'
      if (reason.includes('torghut_readiness')) return 'restore Torghut readiness before capital action'
      if (reason.includes('watch_reliability')) return 'stabilize controller watch streams'
      if (reason.includes('controller_witness_split')) return 'publish a fresh controller-process ingestion witness'
      if (reason.includes('controller_ingestion_stalled'))
        return 'repair stalled AgentRun ingestion before normal dispatch'
      if (reason.includes('agentrun_ingestion')) return 'restore AgentRun ingestion freshness'
      if (reason.includes('workflow')) return 'repair recent workflow failure window'
      if (reason.includes('source_schema')) return 'align source and applied schema projections'
      if (reason.includes('rollout') || reason.includes('pdb')) return 'clear rollout ambiguity or attach waiver'
      return `repair ${reason}`
    }),
  )

const decisionForBudget = (input: {
  spec: BudgetSpec
  negativeRefs: NegativeEvidenceRef[]
  holdbackReasons: string[]
  dependencyQuorum: DependencyQuorumStatus
  torghut?: TorghutNegativeEvidenceInput
}): { decision: ActionSloBudgetDecision; downgradeReasons: string[]; blockedReasons: string[] } => {
  const currentRuntimeReasons = collectReasons(input.negativeRefs, ['current_runtime_negative'])
  const dataFreshnessReasons = collectReasons(input.negativeRefs, ['data_freshness_negative'])
  const sourceSchemaReasons = collectReasons(input.negativeRefs, ['source_schema_negative'])
  const rolloutAmbiguityReasons = collectReasons(input.negativeRefs, ['rollout_ambiguity_negative'])
  const holdbackReasonsValue = uniqueStrings(input.holdbackReasons.map(normalizeReason))

  const actionClass = input.spec.actionClass
  let decision: ActionSloBudgetDecision = 'allow'
  let downgradeReasons: string[] = []
  let blockedReasons: string[] = []

  if (actionClass === 'serve_readonly') {
    if (holdbackReasonsValue.length > 0) {
      decision = 'hold'
      blockedReasons = holdbackReasonsValue
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'dispatch_repair') {
    if (hasReason(holdbackReasonsValue, ['storage.mount_conflict'])) {
      decision = 'hold'
      blockedReasons = holdbackReasonsValue
    } else if (holdbackReasonsValue.length > 0) {
      decision = 'repair_only'
      downgradeReasons = holdbackReasonsValue
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'dispatch_normal') {
    if (holdbackReasonsValue.length > 0 || currentRuntimeReasons.includes('controller_ingestion_stalled')) {
      decision = 'hold'
      blockedReasons = uniqueStrings([
        ...holdbackReasonsValue,
        ...(currentRuntimeReasons.includes('controller_ingestion_stalled') ? ['controller_ingestion_stalled'] : []),
      ])
    } else if (currentRuntimeReasons.length > 0) {
      decision = 'repair_only'
      downgradeReasons = currentRuntimeReasons
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'deploy_widen') {
    const reasons = uniqueStrings([...holdbackReasonsValue, ...rolloutAmbiguityReasons])
    if (reasons.length > 0) {
      decision = 'hold'
      blockedReasons = reasons
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'merge_ready') {
    const reasons = uniqueStrings([...holdbackReasonsValue, ...sourceSchemaReasons])
    if (input.dependencyQuorum.decision === 'block') {
      reasons.push(...input.dependencyQuorum.reasons.map(normalizeReason))
    }
    if (reasons.length > 0) {
      decision = 'hold'
      blockedReasons = uniqueStrings(reasons)
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'torghut_observe') {
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'paper_canary') {
    if (dataFreshnessReasons.length > 0) {
      decision = 'hold'
      blockedReasons = dataFreshnessReasons
    } else if (!input.torghut) {
      decision = 'shadow_only'
      downgradeReasons = ['torghut_consumer_evidence_missing']
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'live_micro_canary') {
    if (dataFreshnessReasons.length > 0) {
      decision = 'block'
      blockedReasons = dataFreshnessReasons
    } else if (!input.torghut) {
      decision = 'hold'
      blockedReasons = ['torghut_consumer_evidence_missing']
    } else if (!input.torghut.paper_settlement_clean) {
      decision = 'hold'
      blockedReasons = ['paper_settlement_required']
    }
    return { decision, downgradeReasons, blockedReasons }
  }

  if (actionClass === 'live_scale') {
    const reasons = [...dataFreshnessReasons]
    if (!input.torghut?.paper_settlement_clean) {
      reasons.push('paper_settlement_required')
    }
    if (reasons.length > 0) {
      decision = 'block'
      blockedReasons = uniqueStrings(reasons)
    }
  }

  return { decision, downgradeReasons, blockedReasons }
}

const rollbackTargetForBudget = (input: {
  actionClass: ActionSloBudgetActionClass
  decision: ActionSloBudgetDecision
  reasons: string[]
  failureDomainLeases: FailureDomainLeaseSet
}) => {
  if (input.decision === 'allow') return null
  const matchingLease = input.failureDomainLeases.leases.find((lease) =>
    (lease.action_classes as readonly string[]).includes(input.actionClass),
  )
  if (matchingLease?.rollback_target) return matchingLease.rollback_target
  if (input.reasons.some((reason) => reason.includes('market_context') || reason.includes('quant_alert'))) {
    return 'hold Torghut capital and refresh data evidence before widening'
  }
  if (input.reasons.some((reason) => reason.includes('rollout') || reason.includes('pdb'))) {
    return 'hold deploy widening until rollout ambiguity clears or is waived'
  }
  return 'keep router in observe mode and use failure-domain leases plus dependency quorum'
}

const buildBudget = (input: {
  spec: BudgetSpec
  routerEpochId: string
  scope: string
  freshUntil: string
  negativeRefs: NegativeEvidenceRef[]
  holdbackReasons: string[]
  dependencyQuorum: DependencyQuorumStatus
  failureDomainLeases: FailureDomainLeaseSet
  torghut?: TorghutNegativeEvidenceInput
}): ActionSloBudget => {
  const decision = decisionForBudget({
    spec: input.spec,
    negativeRefs: input.negativeRefs,
    holdbackReasons: input.holdbackReasons,
    dependencyQuorum: input.dependencyQuorum,
    torghut: input.torghut,
  })
  const allReasons = uniqueStrings([...decision.downgradeReasons, ...decision.blockedReasons])
  const evidenceRefs = collectEvidenceRefs(input.negativeRefs, allReasons)
  const budgetIdSource = {
    router_epoch_id: input.routerEpochId,
    action_class: input.spec.actionClass,
    decision: decision.decision,
    reasons: allReasons,
    scope: input.scope,
  }

  return {
    budget_id: `slo:${input.spec.actionClass}:${hashJson(budgetIdSource)}`,
    router_epoch_id: input.routerEpochId,
    action_class: input.spec.actionClass,
    consumer: input.spec.consumer,
    scope: input.scope,
    decision: decision.decision,
    max_dispatches: decision.decision === 'hold' || decision.decision === 'block' ? 0 : input.spec.maxDispatches,
    max_runtime_seconds:
      decision.decision === 'hold' || decision.decision === 'block' ? 0 : input.spec.maxRuntimeSeconds,
    max_notional: decision.decision === 'allow' ? input.spec.maxNotional : 0,
    max_error_budget_spend:
      decision.decision === 'hold' || decision.decision === 'block' ? 0 : input.spec.maxErrorBudgetSpend,
    fresh_until: input.freshUntil,
    downgrade_reasons: decision.downgradeReasons,
    blocked_reasons: decision.blockedReasons,
    required_repairs: buildRequiredRepairs(allReasons),
    rollback_target: rollbackTargetForBudget({
      actionClass: input.spec.actionClass,
      decision: decision.decision,
      reasons: allReasons,
      failureDomainLeases: input.failureDomainLeases,
    }),
    evidence_refs: evidenceRefs,
  }
}

export const buildNegativeEvidenceRouterStatus = (input: NegativeEvidenceRouterInput): NegativeEvidenceRouterResult => {
  const evidenceWindowMinutes = Math.min(
    Math.max(1, input.workflows.window_minutes || DEFAULT_EVIDENCE_WINDOW_MINUTES),
    DEFAULT_EVIDENCE_WINDOW_MINUTES,
  )
  const positiveEvidenceRefs = buildPositiveRefs(input)
  const negativeEvidenceRefs = buildNegativeEvidenceRefs(input)
  const failureDomainLeaseRefs = input.failureDomainLeases.leases.map((lease) => lease.lease_id).sort()
  const routerEpochId = `ner:${hashJson({
    generated_at: input.now.toISOString(),
    positive_evidence_refs: positiveEvidenceRefs,
    negative_evidence_refs: negativeEvidenceRefs,
    controller_witness_quorum_id: input.controllerWitness?.quorum_id ?? null,
    controller_witness_decision: input.controllerWitness?.decision ?? null,
    failure_domain_lease_set_digest: input.failureDomainLeases.lease_set_digest,
    dependency_quorum: input.dependencyQuorum.decision,
  })}`
  const freshUntil = addMinutes(input.now, evidenceWindowMinutes).toISOString()
  const holdbacks = holdbackByAction(input.failureDomainLeases)
  const scope = `${input.namespace}/${input.service}`
  const budgets = budgetSpecs.map((spec) =>
    buildBudget({
      spec,
      routerEpochId,
      scope,
      freshUntil,
      negativeRefs: negativeEvidenceRefs,
      holdbackReasons: holdbackReasons(holdbacks, spec.actionClass),
      dependencyQuorum: input.dependencyQuorum,
      failureDomainLeases: input.failureDomainLeases,
      torghut: input.torghut,
    }),
  )
  const torghutBudgets = budgets.filter((budget) => budget.consumer === 'torghut' || budget.consumer === 'torghut-sim')

  return {
    router: {
      mode: 'observe',
      design_artifact: NEGATIVE_EVIDENCE_ROUTER_DESIGN_ARTIFACT,
      router_epoch_id: routerEpochId,
      generated_at: input.now.toISOString(),
      evidence_window_minutes: evidenceWindowMinutes,
      positive_evidence_refs: positiveEvidenceRefs,
      negative_evidence_refs: negativeEvidenceRefs,
      contradiction_refs: input.controllerWitness?.reason_codes.includes('controller_witness_split')
        ? [input.controllerWitness.quorum_id]
        : [],
      source_schema_ref: evidenceRef(
        'source_schema:latest_registered',
        input.database.migration_consistency.latest_registered,
      ),
      database_projection_ref: 'database:projection:status',
      gitops_convergence_ref: input.rolloutHealth.status === 'healthy' ? 'rollout:healthy' : 'rollout:degraded',
      failure_domain_lease_refs: failureDomainLeaseRefs,
      consumer_refs: uniqueStrings(budgets.map((budget) => budget.consumer)).sort(),
    },
    budgets,
    torghutBudgets,
  }
}
