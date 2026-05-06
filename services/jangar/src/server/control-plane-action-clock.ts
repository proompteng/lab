import { createHash } from 'node:crypto'

import type {
  EmpiricalServicesStatus,
  FailureDomainActionClass,
  FailureDomainLease,
  FailureDomainLeaseDomain,
  FailureDomainLeaseSet,
  ReconciledActionClock,
  ReconciledActionClockConflictClass,
  ReconciledActionClockDecision,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const ACTION_CLOCK_DESIGN_ARTIFACT =
  'docs/agents/designs/100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md'

const PRODUCER_REVISION = '2026-05-06-action-clock-shadow-v1'
const FRESHNESS_MS = 60_000

const ACTION_CLASSES: FailureDomainActionClass[] = [
  'serve_readonly',
  'dispatch_repair',
  'dispatch_normal',
  'deploy_widen',
  'merge_ready',
  'torghut_observe',
  'torghut_capital',
]

const REQUIRED_DOMAINS_BY_ACTION: Record<FailureDomainActionClass, FailureDomainLeaseDomain[]> = {
  serve_readonly: ['route'],
  dispatch_repair: ['storage', 'nats'],
  dispatch_normal: ['database', 'route', 'rollout', 'storage', 'workflow_artifact', 'nats', 'source_schema'],
  deploy_widen: ['database', 'route', 'rollout', 'registry', 'source_schema'],
  merge_ready: ['database', 'source_schema'],
  torghut_observe: [],
  torghut_capital: ['database', 'route', 'rollout', 'source_schema'],
}

export type ReconciledActionClockInput = {
  now: Date
  namespace: string
  failureDomainLeases: FailureDomainLeaseSet
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  workflows: WorkflowsReliabilityStatus
  watchReliability: ControlPlaneWatchReliability
  empiricalServices: EmpiricalServicesStatus
}

const uniqueStrings = (values: string[]) => [...new Set(values.filter((value) => value.length > 0))]

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const isPositiveLease = (lease: FailureDomainLease) => lease.status === 'valid' || lease.status === 'override'

const reasonNeedsRepair = (reason: string) => {
  if (reason.includes('source_schema')) return 'align source and applied schema projections'
  if (reason.includes('database')) return 'restore database routability evidence'
  if (reason.includes('rollout') || reason.includes('pdb')) return 'clear rollout ambiguity or attach waiver'
  if (reason.includes('workflow')) return 'repair recent workflow failure window'
  if (reason.includes('storage')) return 'restore workspace storage lease'
  if (reason.includes('nats')) return 'restore collaboration transport lease'
  if (reason.includes('route')) return 'restore Jangar route health'
  if (reason.includes('empirical_jobs')) return 'refresh Torghut empirical job proof'
  if (reason.includes('empirical')) return 'refresh Torghut empirical proof'
  if (reason.includes('watch')) return 'restore control-plane watch reliability'
  return `repair ${reason}`
}

const decisionForNegativeLease = (actionClass: FailureDomainActionClass, lease: FailureDomainLease) => {
  if (actionClass === 'serve_readonly' && lease.domain === 'route' && lease.status === 'expired') return 'block'
  if (actionClass === 'dispatch_repair') return 'hold'
  return 'hold'
}

const stricterDecision = (
  current: ReconciledActionClockDecision,
  next: ReconciledActionClockDecision,
): ReconciledActionClockDecision => {
  const rank: Record<ReconciledActionClockDecision, number> = {
    allow: 0,
    observe_only: 1,
    repair_only: 2,
    hold: 3,
    block: 4,
  }
  return rank[next] > rank[current] ? next : current
}

const empiricalDebtReasons = (services: EmpiricalServicesStatus) => {
  const staleJobs = services.jobs.stale_jobs ?? []
  return uniqueStrings([
    services.jobs.status !== 'healthy' ? 'empirical_jobs_degraded' : '',
    ...(staleJobs.length > 0 ? staleJobs.map((job) => `empirical_jobs_stale:${job}`) : []),
    services.forecast.status === 'degraded' ? 'forecast_service_degraded' : '',
    services.lean.status === 'degraded' ? 'lean_authority_degraded' : '',
  ])
}

const missingLeaseReason = (domain: FailureDomainLeaseDomain) => `${domain}.lease_missing`

const buildClock = (input: {
  now: Date
  namespace: string
  actionClass: FailureDomainActionClass
  requiredLeases: FailureDomainLease[]
  missingDomains: FailureDomainLeaseDomain[]
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  workflows: WorkflowsReliabilityStatus
  watchReliability: ControlPlaneWatchReliability
  empiricalServices: EmpiricalServicesStatus
}) => {
  const requiredNegativeLeases = input.requiredLeases.filter((lease) => !isPositiveLease(lease))
  const positiveLeaseIds = input.requiredLeases.filter(isPositiveLease).map((lease) => lease.lease_id)
  const negativeLeaseIds = requiredNegativeLeases.map((lease) => lease.lease_id)
  let blockingReasonCodes = uniqueStrings([
    ...requiredNegativeLeases.flatMap((lease) => lease.reason_codes),
    ...input.missingDomains.map(missingLeaseReason),
  ])
  let decision: ReconciledActionClockDecision = 'allow'
  let conflictClass: ReconciledActionClockConflictClass = 'none'

  if (input.missingDomains.length > 0) {
    decision = 'hold'
    conflictClass = 'missing_authority'
  }

  for (const lease of requiredNegativeLeases) {
    decision = stricterDecision(decision, decisionForNegativeLease(input.actionClass, lease))
  }

  if (requiredNegativeLeases.length > 0 && conflictClass === 'none') {
    conflictClass = 'stale_negative'
  }

  const hasSourceSchemaDatabaseConflict = requiredNegativeLeases.some((lease) =>
    lease.reason_codes.includes('source_schema.database_unroutable'),
  )
  if (input.database.status === 'healthy' && input.database.connected && hasSourceSchemaDatabaseConflict) {
    conflictClass = 'contradictory_positive_negative'
  }

  if (
    (input.actionClass === 'dispatch_normal' || input.actionClass === 'deploy_widen') &&
    input.watchReliability.status === 'degraded'
  ) {
    decision = stricterDecision(decision, 'hold')
    blockingReasonCodes = uniqueStrings([...blockingReasonCodes, 'watch_reliability_degraded'])
    if (conflictClass === 'none') conflictClass = 'stale_negative'
  }

  if (
    (input.actionClass === 'dispatch_normal' || input.actionClass === 'deploy_widen') &&
    input.workflows.data_confidence !== 'high'
  ) {
    decision = stricterDecision(decision, 'hold')
    blockingReasonCodes = uniqueStrings([
      ...blockingReasonCodes,
      `workflow_data_confidence_${input.workflows.data_confidence}`,
    ])
    if (conflictClass === 'none') conflictClass = 'missing_authority'
  }

  if (input.actionClass === 'torghut_observe') {
    decision = 'allow'
    conflictClass = 'none'
    blockingReasonCodes = []
  }

  if (input.actionClass === 'torghut_capital') {
    const consumerReasons = empiricalDebtReasons(input.empiricalServices)
    if (consumerReasons.length > 0) {
      decision = stricterDecision(decision, 'hold')
      blockingReasonCodes = uniqueStrings([...blockingReasonCodes, ...consumerReasons])
      if (conflictClass === 'none') conflictClass = 'consumer_debt'
    }
  }

  if (
    input.rolloutHealth.status !== 'healthy' &&
    ['dispatch_normal', 'deploy_widen', 'torghut_capital'].includes(input.actionClass)
  ) {
    decision = stricterDecision(decision, 'hold')
    blockingReasonCodes = uniqueStrings([...blockingReasonCodes, 'rollout_health_degraded'])
    if (conflictClass === 'none') conflictClass = 'stale_negative'
  }

  const confidence =
    input.watchReliability.status === 'unknown' ||
    input.workflows.data_confidence === 'unknown' ||
    input.rolloutHealth.status === 'unknown'
      ? 'low'
      : input.watchReliability.status === 'degraded' ||
          input.workflows.data_confidence === 'degraded' ||
          input.rolloutHealth.status === 'degraded'
        ? 'medium'
        : 'high'
  const evidenceRefs = uniqueStrings([
    ACTION_CLOCK_DESIGN_ARTIFACT,
    ...input.requiredLeases.flatMap((lease) => lease.evidence_refs),
    ...requiredNegativeLeases.flatMap((lease) => lease.reason_codes.map((reason) => `reason:${reason}`)),
    ...(input.actionClass === 'torghut_capital'
      ? empiricalDebtReasons(input.empiricalServices).map((reason) => `reason:${reason}`)
      : []),
  ])
  const rollbackTarget =
    requiredNegativeLeases.find((lease) => lease.rollback_target)?.rollback_target ??
    (blockingReasonCodes.length > 0 ? 'keep action-clock projection in shadow mode and repair blocking evidence' : null)
  const observedAt = input.now.toISOString()
  const freshUntil = new Date(input.now.getTime() + FRESHNESS_MS).toISOString()
  const clockId = `action-clock:${input.actionClass}:${hashJson({
    namespace: input.namespace,
    actionClass: input.actionClass,
    decision,
    conflictClass,
    positiveLeaseIds,
    negativeLeaseIds,
    blockingReasonCodes,
    observedAt,
  })}`

  return {
    clock_id: clockId,
    namespace: input.namespace,
    action_class: input.actionClass,
    decision,
    conflict_class: conflictClass,
    confidence,
    observed_at: observedAt,
    fresh_until: freshUntil,
    positive_lease_ids: positiveLeaseIds,
    negative_lease_ids: negativeLeaseIds,
    blocking_reason_codes: blockingReasonCodes,
    required_repair_actions: uniqueStrings(blockingReasonCodes.map(reasonNeedsRepair)),
    rollback_target: rollbackTarget,
    producer_revision: PRODUCER_REVISION,
    evidence_refs: evidenceRefs,
  } satisfies ReconciledActionClock
}

export const buildReconciledActionClocks = (input: ReconciledActionClockInput): ReconciledActionClock[] => {
  const leasesByRequiredDomain = new Map<FailureDomainLeaseDomain, FailureDomainLease[]>()
  for (const lease of input.failureDomainLeases.leases) {
    const leases = leasesByRequiredDomain.get(lease.domain) ?? []
    leases.push(lease)
    leasesByRequiredDomain.set(lease.domain, leases)
  }

  return ACTION_CLASSES.map((actionClass) => {
    const requiredDomains = REQUIRED_DOMAINS_BY_ACTION[actionClass]
    const requiredLeases = requiredDomains.flatMap((domain) => leasesByRequiredDomain.get(domain) ?? [])
    const missingDomains = requiredDomains.filter((domain) => !leasesByRequiredDomain.has(domain))

    return buildClock({
      now: input.now,
      namespace: input.namespace,
      actionClass,
      requiredLeases,
      missingDomains,
      database: input.database,
      rolloutHealth: input.rolloutHealth,
      workflows: input.workflows,
      watchReliability: input.watchReliability,
      empiricalServices: input.empiricalServices,
    })
  })
}
