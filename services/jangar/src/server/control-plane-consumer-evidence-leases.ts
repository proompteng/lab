import { createHash } from 'node:crypto'

import type {
  ActionSloBudgetActionClass,
  ConsumerEvidenceActionLease,
  ConsumerEvidenceLeaseConfidence,
  ConsumerEvidenceLeaseContradiction,
  ConsumerEvidenceLeaseDecision,
  ConsumerEvidenceLeaseSet,
  ControlPlaneControllerWitnessQuorum,
  EmpiricalServicesStatus,
  MaterialActionVerdict,
  MaterialActionVerdictDecision,
  MaterialActionVerdictEpoch,
} from '~/data/agents-control-plane'
import type {
  ControlPlaneRolloutHealth,
  ControlPlaneWatchReliability,
  DatabaseStatus,
} from '~/server/control-plane-status-types'

export const CONSUMER_EVIDENCE_LEASES_DESIGN_ARTIFACT =
  'docs/agents/designs/129-jangar-consumer-evidence-leases-and-readiness-decoupling-2026-05-06.md'

const CONSUMER_EVIDENCE_LEASES_SCHEMA_VERSION = 'jangar.consumer-evidence-lease-set.v1' as const
const PRODUCER_REVISION = '2026-05-13-consumer-evidence-leases-shadow-v1'
const LEASE_TTL_SECONDS = 60
const OPERATIONAL_GRACE_SECONDS = 300
const ROLLBACK_TARGET = 'JANGAR_CONSUMER_EVIDENCE_LEASES_ENABLED=false'

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

const DECISION_RANK: Record<ConsumerEvidenceLeaseDecision, number> = {
  allow: 0,
  allow_grace: 1,
  unknown: 2,
  repair_only: 3,
  hold: 4,
  block: 5,
}

export type ConsumerEvidenceLeaseInput = {
  now: Date
  namespace: string
  database: DatabaseStatus
  rolloutHealth: ControlPlaneRolloutHealth
  watchReliability: ControlPlaneWatchReliability
  controllerWitness: ControlPlaneControllerWitnessQuorum
  materialActionVerdictEpoch: MaterialActionVerdictEpoch
  empiricalServices: EmpiricalServicesStatus
}

type LeaseSignal = {
  source: 'material_verdict' | 'database' | 'rollout' | 'watch' | 'controller_witness' | 'empirical_services'
  decision: ConsumerEvidenceLeaseDecision
  confidence: ConsumerEvidenceLeaseConfidence
  reasonCodes: string[]
  requiredRepairs: string[]
  evidenceRefs: string[]
  rollbackTarget: string | null
  freshUntil: string | null
  maxDispatches: number | null
  maxRuntimeSeconds: number | null
  maxNotional: number | null
}

const hashJson = (value: unknown, length = 16) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length)

const addSeconds = (date: Date, seconds: number) => new Date(date.getTime() + seconds * 1000)

const uniqueStrings = (values: Array<string | null | undefined>) => [
  ...new Set(values.filter((value): value is string => Boolean(value && value.trim().length > 0))),
]

const normalizeReason = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')

const normalizeReasons = (values: Array<string | null | undefined>) => uniqueStrings(values).map(normalizeReason)

const parseIso = (value: string | null | undefined) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const minIsoTimestamp = (values: Array<string | null | undefined>, fallback: string) => {
  const parsed = values
    .map(parseIso)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)
  return parsed.length > 0 ? new Date(parsed[0] ?? Date.parse(fallback)).toISOString() : fallback
}

const isCapitalAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'paper_canary' || actionClass === 'live_micro_canary' || actionClass === 'live_scale'

const isDeployOrMergeAction = (actionClass: ActionSloBudgetActionClass) =>
  actionClass === 'deploy_widen' || actionClass === 'merge_ready'

const repairActionForReason = (reason: string) => {
  if (reason.includes('database') || reason.includes('schema')) return 'restore Jangar database/schema projection'
  if (reason.includes('rollout')) return 'settle Jangar rollout health before widening'
  if (reason.includes('watch')) return 'restore control-plane watch reliability'
  if (reason.includes('controller') || reason.includes('ingestion')) {
    return 'publish fresh controller-process AgentRun ingestion evidence'
  }
  if (reason.includes('forecast') || reason.includes('empirical')) return 'refresh Torghut empirical proof'
  return `repair ${reason}`
}

const leaseDecisionFromMaterial = (decision: MaterialActionVerdictDecision): ConsumerEvidenceLeaseDecision => {
  if (decision === 'allow') return 'allow'
  if (decision === 'repair_only') return 'repair_only'
  if (decision === 'hold') return 'hold'
  if (decision === 'block' || decision === 'contradicted') return 'block'
  return 'unknown'
}

const materialSignal = (epoch: MaterialActionVerdictEpoch, actionClass: ActionSloBudgetActionClass): LeaseSignal => {
  const verdict = epoch.final_verdicts.find((entry) => entry.action_class === actionClass)
  if (!verdict) {
    return {
      source: 'material_verdict',
      decision: 'unknown',
      confidence: 'unknown',
      reasonCodes: [`material_action_verdict_missing:${actionClass}`],
      requiredRepairs: ['restore material action verdict projection'],
      evidenceRefs: [epoch.epoch_id],
      rollbackTarget: ROLLBACK_TARGET,
      freshUntil: epoch.expires_at,
      maxDispatches: 0,
      maxRuntimeSeconds: 0,
      maxNotional: 0,
    }
  }

  const decision = leaseDecisionFromMaterial(verdict.decision)
  return {
    source: 'material_verdict',
    decision,
    confidence: verdict.confidence,
    reasonCodes: normalizeReasons([
      ...verdict.blocking_reason_codes,
      ...verdict.downgrade_reason_codes,
      ...(decision === 'unknown' ? ['material_action_verdict_unknown'] : []),
    ]),
    requiredRepairs: verdict.required_repair_actions,
    evidenceRefs: uniqueStrings([epoch.epoch_id, verdict.verdict_id, ...verdict.evidence_refs]),
    rollbackTarget: verdict.rollback_target,
    freshUntil: minIsoTimestamp([verdict.allowed_until, epoch.expires_at], epoch.expires_at),
    maxDispatches: verdict.max_dispatches,
    maxRuntimeSeconds: verdict.max_runtime_seconds,
    maxNotional: verdict.max_notional,
  }
}

const databaseSignal = (database: DatabaseStatus, actionClass: ActionSloBudgetActionClass): LeaseSignal | null => {
  const schemaHealthy = database.migration_consistency.status === 'healthy'
  const databaseHealthy = database.connected && database.status === 'healthy' && schemaHealthy
  if (databaseHealthy) return null

  const reasonCodes = normalizeReasons([
    !database.connected ? 'database_disconnected' : `database_${database.status}`,
    !schemaHealthy ? `database_schema_${database.migration_consistency.status}` : null,
  ])
  const evidenceRefs = [
    `database:${database.status}:${database.migration_consistency.status}`,
    ...(database.migration_consistency.latest_applied
      ? [`migration:${database.migration_consistency.latest_applied}`]
      : []),
  ]

  let decision: ConsumerEvidenceLeaseDecision = 'hold'
  if (isDeployOrMergeAction(actionClass) || isCapitalAction(actionClass)) {
    decision = 'block'
  } else if (actionClass === 'dispatch_normal' || actionClass === 'dispatch_repair') {
    decision = database.connected ? 'repair_only' : 'hold'
  }

  return {
    source: 'database',
    decision,
    confidence: database.connected ? 'high' : 'medium',
    reasonCodes,
    requiredRepairs: uniqueStrings(reasonCodes.map(repairActionForReason)),
    evidenceRefs,
    rollbackTarget: 'hold consumer lease enforcement until Jangar database and schema projections are healthy',
    freshUntil: null,
    maxDispatches: decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: 0,
  }
}

const rolloutSignal = (
  rolloutHealth: ControlPlaneRolloutHealth,
  actionClass: ActionSloBudgetActionClass,
): LeaseSignal | null => {
  if (rolloutHealth.status === 'healthy') return null
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe' || actionClass === 'dispatch_repair') {
    return null
  }

  const degradedDeployments = rolloutHealth.deployments.filter((deployment) => deployment.status !== 'healthy')
  const reasonCodes = normalizeReasons([
    `rollout_${rolloutHealth.status}`,
    ...degradedDeployments.map((deployment) => `deployment_${deployment.name}_${deployment.status}`),
  ])
  const decision: ConsumerEvidenceLeaseDecision = actionClass === 'dispatch_normal' ? 'repair_only' : 'hold'

  return {
    source: 'rollout',
    decision,
    confidence: rolloutHealth.status === 'unknown' ? 'unknown' : 'medium',
    reasonCodes,
    requiredRepairs: uniqueStrings(reasonCodes.map(repairActionForReason)),
    evidenceRefs: uniqueStrings([
      `rollout:${rolloutHealth.status}:${rolloutHealth.degraded_deployments}:${rolloutHealth.observed_deployments}`,
      ...degradedDeployments.map((deployment) => `deployment:${deployment.namespace}/${deployment.name}`),
    ]),
    rollbackTarget: 'hold deploy widening and normal dispatch until rollout health is current',
    freshUntil: null,
    maxDispatches: decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: 0,
  }
}

const watchSignal = (
  watchReliability: ControlPlaneWatchReliability,
  actionClass: ActionSloBudgetActionClass,
): LeaseSignal | null => {
  if (watchReliability.status === 'healthy') return null
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe' || actionClass === 'dispatch_repair') {
    return null
  }

  const reasonCodes = normalizeReasons([
    `watch_reliability_${watchReliability.status}`,
    ...(watchReliability.total_errors > 0 ? ['watch_errors_present'] : []),
    ...(watchReliability.total_restarts > 0 ? ['watch_restarts_present'] : []),
  ])
  const decision: ConsumerEvidenceLeaseDecision = actionClass === 'dispatch_normal' ? 'repair_only' : 'hold'

  return {
    source: 'watch',
    decision,
    confidence: watchReliability.status === 'unknown' ? 'unknown' : 'medium',
    reasonCodes,
    requiredRepairs: uniqueStrings(reasonCodes.map(repairActionForReason)),
    evidenceRefs: [
      `watch:${watchReliability.status}:${watchReliability.total_events}:${watchReliability.total_errors}:${watchReliability.total_restarts}`,
    ],
    rollbackTarget: 'hold normal dispatch and rollout widening until watch reliability recovers',
    freshUntil: null,
    maxDispatches: decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: 0,
  }
}

const controllerWitnessSignal = (
  controllerWitness: ControlPlaneControllerWitnessQuorum,
  actionClass: ActionSloBudgetActionClass,
): LeaseSignal | null => {
  if (
    controllerWitness.decision === 'allow' &&
    controllerWitness.controller_self_report_current &&
    controllerWitness.watch_epoch_current
  ) {
    return null
  }
  if (actionClass === 'serve_readonly' || actionClass === 'torghut_observe' || actionClass === 'dispatch_repair') {
    return null
  }

  const reasonCodes = normalizeReasons([
    ...controllerWitness.reason_codes,
    `controller_witness_${controllerWitness.decision}`,
    !controllerWitness.controller_self_report_current ? 'controller_ingestion_not_current' : null,
    !controllerWitness.watch_epoch_current ? 'controller_watch_epoch_not_current' : null,
  ])
  const decision: ConsumerEvidenceLeaseDecision = actionClass === 'dispatch_normal' ? 'repair_only' : 'hold'

  return {
    source: 'controller_witness',
    decision,
    confidence: controllerWitness.decision === 'block' ? 'high' : 'medium',
    reasonCodes,
    requiredRepairs: uniqueStrings(reasonCodes.map(repairActionForReason)),
    evidenceRefs: uniqueStrings([controllerWitness.quorum_id, ...controllerWitness.witness_refs]),
    rollbackTarget: 'keep normal dispatch and capital holds until controller-process ingestion evidence is current',
    freshUntil: controllerWitness.expires_at,
    maxDispatches: decision === 'repair_only' ? 1 : 0,
    maxRuntimeSeconds: decision === 'repair_only' ? 20 * 60 : 0,
    maxNotional: 0,
  }
}

const empiricalSignal = (
  empiricalServices: EmpiricalServicesStatus,
  actionClass: ActionSloBudgetActionClass,
): LeaseSignal | null => {
  if (!isCapitalAction(actionClass)) return null
  if (empiricalServices.forecast.status === 'healthy') return null

  const reasonCodes = normalizeReasons([
    `forecast_service_${empiricalServices.forecast.status}`,
    ...(empiricalServices.jobs.status !== 'healthy' ? [`empirical_jobs_${empiricalServices.jobs.status}`] : []),
  ])

  return {
    source: 'empirical_services',
    decision: 'hold',
    confidence: empiricalServices.forecast.status === 'unknown' ? 'unknown' : 'medium',
    reasonCodes,
    requiredRepairs: uniqueStrings(reasonCodes.map(repairActionForReason)),
    evidenceRefs: uniqueStrings([
      `empirical:forecast:${empiricalServices.forecast.status}`,
      `empirical:jobs:${empiricalServices.jobs.status}`,
      empiricalServices.forecast.endpoint,
      empiricalServices.jobs.endpoint,
    ]),
    rollbackTarget: 'keep Torghut paper/live capital held until empirical proof is current',
    freshUntil: null,
    maxDispatches: 0,
    maxRuntimeSeconds: 0,
    maxNotional: 0,
  }
}

const strictestSignal = (signals: LeaseSignal[]) => {
  const [firstSignal, ...restSignals] = signals
  if (!firstSignal) {
    throw new Error('consumer evidence lease requires at least one signal')
  }
  return restSignals.reduce<LeaseSignal>(
    (strictest, signal) => (DECISION_RANK[signal.decision] > DECISION_RANK[strictest.decision] ? signal : strictest),
    firstSignal,
  )
}

const confidenceRank: Record<ConsumerEvidenceLeaseConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
  unknown: 3,
}

const worstConfidence = (signals: LeaseSignal[]): ConsumerEvidenceLeaseConfidence =>
  signals.reduce<ConsumerEvidenceLeaseConfidence>(
    (current, signal) => (confidenceRank[signal.confidence] > confidenceRank[current] ? signal.confidence : current),
    'high',
  )

const leaseLimits = (
  actionClass: ActionSloBudgetActionClass,
  decision: ConsumerEvidenceLeaseDecision,
  signal: LeaseSignal,
) => {
  if (decision === 'block' || decision === 'hold' || decision === 'unknown') {
    return { maxDispatches: 0, maxRuntimeSeconds: 0, maxNotional: 0 }
  }
  if (decision === 'repair_only') {
    return {
      maxDispatches: signal.maxDispatches ?? 1,
      maxRuntimeSeconds: signal.maxRuntimeSeconds ?? 20 * 60,
      maxNotional: 0,
    }
  }
  if (actionClass === 'dispatch_repair') {
    return { maxDispatches: 1, maxRuntimeSeconds: 20 * 60, maxNotional: 0 }
  }
  if (actionClass === 'torghut_observe') {
    return { maxDispatches: null, maxRuntimeSeconds: null, maxNotional: 0 }
  }
  return {
    maxDispatches: signal.maxDispatches,
    maxRuntimeSeconds: signal.maxRuntimeSeconds,
    maxNotional: signal.maxNotional,
  }
}

const buildActionLease = (
  input: ConsumerEvidenceLeaseInput,
  actionClass: ActionSloBudgetActionClass,
): { lease: ConsumerEvidenceActionLease; contradiction: ConsumerEvidenceLeaseContradiction | null } => {
  const fallbackFreshUntil = addSeconds(input.now, LEASE_TTL_SECONDS).toISOString()
  const material = materialSignal(input.materialActionVerdictEpoch, actionClass)
  const signals = [
    material,
    databaseSignal(input.database, actionClass),
    rolloutSignal(input.rolloutHealth, actionClass),
    watchSignal(input.watchReliability, actionClass),
    controllerWitnessSignal(input.controllerWitness, actionClass),
    empiricalSignal(input.empiricalServices, actionClass),
  ].filter((signal): signal is LeaseSignal => signal !== null)
  const strictest = strictestSignal(signals)
  const freshUntil = minIsoTimestamp(
    signals.map((signal) => signal.freshUntil),
    fallbackFreshUntil,
  )
  const graceUntil = addSeconds(new Date(freshUntil), OPERATIONAL_GRACE_SECONDS).toISOString()
  const reasonCodes = normalizeReasons(signals.flatMap((signal) => signal.reasonCodes))
  const requiredRepairs = uniqueStrings([
    ...signals.flatMap((signal) => signal.requiredRepairs),
    ...reasonCodes.map(repairActionForReason),
  ])
  const evidenceRefs = uniqueStrings(signals.flatMap((signal) => signal.evidenceRefs))
  const rollbackTarget =
    strictest.rollbackTarget ?? signals.find((signal) => signal.rollbackTarget !== null)?.rollbackTarget ?? null
  const limits = leaseLimits(actionClass, strictest.decision, strictest)
  const lease = {
    lease_id: `consumer-evidence-lease:${actionClass}:${hashJson([
      input.namespace,
      actionClass,
      strictest.decision,
      reasonCodes,
      evidenceRefs,
    ])}`,
    action_class: actionClass,
    decision: strictest.decision,
    confidence: worstConfidence(signals),
    fresh_until: freshUntil,
    grace_until: graceUntil,
    max_dispatches: limits.maxDispatches,
    max_runtime_seconds: limits.maxRuntimeSeconds,
    max_notional: limits.maxNotional,
    required_repairs: requiredRepairs,
    reason_codes: reasonCodes,
    evidence_refs: evidenceRefs,
    rollback_target: rollbackTarget,
  } satisfies ConsumerEvidenceActionLease

  const contradiction =
    material.decision === 'allow' && strictest.decision !== 'allow'
      ? {
          contradiction_id: `consumer-evidence-contradiction:${hashJson([
            input.namespace,
            actionClass,
            strictest.decision,
            reasonCodes,
          ])}`,
          action_class: actionClass,
          message: `${actionClass} material verdict allowed but consumer lease downgraded to ${strictest.decision}`,
          reason_codes: reasonCodes,
          evidence_refs: evidenceRefs,
        }
      : null

  return { lease, contradiction }
}

export const buildConsumerEvidenceLeaseSet = (input: ConsumerEvidenceLeaseInput): ConsumerEvidenceLeaseSet => {
  const actionResults = ACTION_CLASSES.map((actionClass) => buildActionLease(input, actionClass))
  const actionLeases = actionResults.map((result) => result.lease)
  const contradictions = actionResults
    .map((result) => result.contradiction)
    .filter((contradiction): contradiction is ConsumerEvidenceLeaseContradiction => contradiction !== null)
  const databaseRef = `database:${input.database.status}:${input.database.migration_consistency.status}`
  const rolloutRef = `rollout:${input.rolloutHealth.status}:${input.rolloutHealth.degraded_deployments}:${input.rolloutHealth.observed_deployments}`
  const watchRef = `watch:${input.watchReliability.status}:${input.watchReliability.total_events}:${input.watchReliability.total_errors}:${input.watchReliability.total_restarts}`
  const empiricalServicesRef = `empirical:forecast=${input.empiricalServices.forecast.status}:lean=${input.empiricalServices.lean.status}:jobs=${input.empiricalServices.jobs.status}`
  const generatedAt = input.now.toISOString()
  const expiresAt = minIsoTimestamp(
    actionLeases.map((lease) => lease.fresh_until),
    addSeconds(input.now, LEASE_TTL_SECONDS).toISOString(),
  )
  const sourceStatusRef = `control-plane-status:${input.namespace}:${hashJson([
    databaseRef,
    rolloutRef,
    watchRef,
    input.controllerWitness.quorum_id,
    input.materialActionVerdictEpoch.epoch_id,
    empiricalServicesRef,
  ])}`

  return {
    schema_version: CONSUMER_EVIDENCE_LEASES_SCHEMA_VERSION,
    mode: 'shadow',
    design_artifact: CONSUMER_EVIDENCE_LEASES_DESIGN_ARTIFACT,
    lease_set_id: `consumer-evidence-lease-set:${hashJson([
      input.namespace,
      generatedAt,
      sourceStatusRef,
      actionLeases.map((lease) => [lease.action_class, lease.decision, lease.reason_codes]),
    ])}`,
    generated_at: generatedAt,
    expires_at: expiresAt,
    producer_revision: PRODUCER_REVISION,
    consumer: 'torghut',
    namespace: input.namespace,
    source_status_ref: sourceStatusRef,
    database_ref: databaseRef,
    rollout_ref: rolloutRef,
    watch_ref: watchRef,
    controller_witness_ref: input.controllerWitness.quorum_id,
    empirical_services_ref: empiricalServicesRef,
    action_leases: actionLeases,
    contradictions,
    rollback_target: ROLLBACK_TARGET,
  }
}
