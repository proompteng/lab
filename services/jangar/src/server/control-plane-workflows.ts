import { resolveControlPlaneStatusConfig } from '~/server/control-plane-config'
import type { ControlPlaneWatchReliabilitySummary } from '~/server/control-plane-watch-reliability'
import type { KubeGateway, KubeGatewayCondition } from '~/server/kube-gateway'
import { parseNamespaceScopeEnv } from '~/server/namespace-scope'
import { asString } from '~/server/primitives-http'
import type {
  DependencyQuorumConfidence,
  DependencyQuorumSegment,
  DependencyQuorumSegmentName,
  DependencyQuorumSegmentScope,
  DependencyQuorumSegmentStatus,
  DependencyQuorumStatus,
  ExecutionTrustStatus,
  WorkflowsReliabilityStatus,
} from '~/data/agents-control-plane'
import { hasMaterialRolloutDegradation } from './control-plane-rollout-health'
import type {
  ControllerStatus,
  ControlPlaneRolloutHealth,
  DatabaseStatus,
  EmpiricalServicesStatus,
  RuntimeAdapterStatus,
} from './control-plane-status-types'

const DEFAULT_WORKFLOWS_NAMESPACES = ['agents']
const MAX_TOP_FAILURE_REASONS = 5
const MAX_WORKFLOW_COLLECTION_ERROR_SAMPLE = 3
const STATUS_MS_PER_MINUTE = 60 * 1000
const WORKFLOW_SCHEDULE_LABEL_SELECTOR = 'schedules.proompteng.ai/schedule'
const SWARM_LABEL_SELECTOR = 'swarm.proompteng.ai/name'

export type WorkflowsReliabilityStatusInput = {
  now: Date
  namespace: string
  namespaces: string[]
  windowMinutes: number
  swarms: string[]
  kube: KubeGateway
}

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const uniqueStrings = <T extends string>(values: readonly T[]) => {
  const seen = new Set<T>()
  const unique: T[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

const DEPENDENCY_QUORUM_SCOPE_PRIORITY: Record<DependencyQuorumSegmentScope, number> = {
  single_capability: 0,
  hypothesis_scoped: 1,
  capital_family: 2,
  global: 3,
}

const DEPENDENCY_QUORUM_CONFIDENCE_PRIORITY: Record<DependencyQuorumConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

const pickBroaderDependencyScope = (
  current: DependencyQuorumSegmentScope | undefined,
  next: DependencyQuorumSegmentScope,
) => {
  if (current == null) {
    return next
  }

  return DEPENDENCY_QUORUM_SCOPE_PRIORITY[next] > DEPENDENCY_QUORUM_SCOPE_PRIORITY[current] ? next : current
}

const pickLowerDependencyConfidence = (
  current: DependencyQuorumConfidence | undefined,
  next: DependencyQuorumConfidence,
) => {
  if (current == null) {
    return next
  }

  return DEPENDENCY_QUORUM_CONFIDENCE_PRIORITY[next] > DEPENDENCY_QUORUM_CONFIDENCE_PRIORITY[current] ? next : current
}

export const resolveWorkflowWindowMinutes = () => resolveControlPlaneStatusConfig(process.env).workflowsWindowMinutes

export const resolveWorkflowSwarms = () => resolveControlPlaneStatusConfig(process.env).workflowsSwarms

export const resolveWatchReliabilityBlockErrorsThreshold = () =>
  resolveControlPlaneStatusConfig(process.env).watchReliabilityBlockErrors

export const resolveWatchReliabilityBlockRestartsThreshold = () =>
  resolveControlPlaneStatusConfig(process.env).watchReliabilityBlockRestarts

export const resolveWorkflowNamespaces = (optionsNamespace: string) => {
  const fallback = uniqueStrings([optionsNamespace, ...DEFAULT_WORKFLOWS_NAMESPACES])
  try {
    const parsed = parseNamespaceScopeEnv('JANGAR_AGENTS_CONTROLLER_NAMESPACES', {
      fallback,
      label: 'workflow reliability status',
    })
    return uniqueStrings(parsed)
  } catch (error) {
    console.warn(`[jangar] failed to parse JANGAR_AGENTS_CONTROLLER_NAMESPACES: ${normalizeMessage(error)}`)
    return fallback
  }
}

const safeNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined

const parseIsoMs = (value: unknown): number | null => {
  const text = asString(value)
  if (!text) return null
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

const isBackoffLimitExceededCondition = (condition: KubeGatewayCondition) => condition.reason === 'BackoffLimitExceeded'

export const resolveWorkflowsReliabilityStatus = async ({
  now,
  namespace,
  namespaces,
  windowMinutes,
  swarms,
  kube,
}: WorkflowsReliabilityStatusInput) => {
  const nowMs = now.getTime()
  const windowStartMs = nowMs - windowMinutes * STATUS_MS_PER_MINUTE

  let activeJobRuns = 0
  let recentFailedJobs = 0
  let backoffLimitExceededJobs = 0
  const reasonsMap = new Map<string, number>()
  let collectionErrors = 0
  let collectedNamespaces = 0
  const collectionErrorMessages: string[] = []

  const uniqueNamespaces = uniqueStrings(namespaces)
  const uniqueSwarms = uniqueStrings(swarms)
  const scopeSwarms = new Set(uniqueSwarms)

  const namespaceScope = uniqueNamespaces.length > 0 ? uniqueNamespaces : [namespace]
  const selectorSwarms =
    scopeSwarms.size > 0 ? `${SWARM_LABEL_SELECTOR} in (${Array.from(scopeSwarms).join(',')})` : null
  const labelSelector = selectorSwarms
    ? `${WORKFLOW_SCHEDULE_LABEL_SELECTOR},${selectorSwarms}`
    : WORKFLOW_SCHEDULE_LABEL_SELECTOR

  for (const currentNamespace of namespaceScope) {
    try {
      const jobs = await kube.listJobs(currentNamespace, labelSelector)
      collectedNamespaces += 1

      for (const job of jobs) {
        const swarm = job.metadata.labels[SWARM_LABEL_SELECTOR] ?? null
        if (!swarm || !scopeSwarms.has(swarm)) {
          continue
        }

        const active = safeNumber(job.status.active)
        if (active !== undefined && active > 0) {
          activeJobRuns += 1
        }

        const failed = safeNumber(job.status.failed)
        const completionTimeMs = parseIsoMs(job.status.completionTime)
        const creationTimeMs = parseIsoMs(job.metadata.creationTimestamp)
        const referenceMs = completionTimeMs ?? parseIsoMs(job.status.startTime) ?? creationTimeMs

        if (
          failed !== undefined &&
          failed > 0 &&
          referenceMs !== null &&
          referenceMs >= windowStartMs &&
          referenceMs <= nowMs
        ) {
          recentFailedJobs += 1
        }

        const conditionReasons = new Set<string>()
        let hasBackoffLimitExceeded = false

        for (const condition of job.status.conditions) {
          const reason = condition.reason
          const transitionMs = parseIsoMs(condition.lastTransitionTime)
          const eventMs = transitionMs ?? referenceMs
          if (!reason || eventMs === null || eventMs < windowStartMs || eventMs > nowMs) continue

          conditionReasons.add(reason)
          if (isBackoffLimitExceededCondition(condition)) {
            hasBackoffLimitExceeded = true
          }
        }

        if (
          conditionReasons.size > 0 &&
          failed !== undefined &&
          failed > 0 &&
          referenceMs !== null &&
          referenceMs >= windowStartMs &&
          referenceMs <= nowMs
        ) {
          for (const reason of conditionReasons) {
            const normalized = reason.trim()
            if (!normalized) continue
            reasonsMap.set(normalized, (reasonsMap.get(normalized) ?? 0) + 1)
          }
        }

        if (
          hasBackoffLimitExceeded &&
          failed !== undefined &&
          failed > 0 &&
          referenceMs !== null &&
          referenceMs >= windowStartMs &&
          referenceMs <= nowMs
        ) {
          backoffLimitExceededJobs += 1
        }
      }
    } catch (error) {
      collectionErrors += 1
      const errorMessage = normalizeMessage(error)
      collectionErrorMessages.push(`${currentNamespace}: ${errorMessage}`)
      console.warn(
        `[jangar] failed to collect workflow reliability metrics for namespace ${currentNamespace}: ${errorMessage}`,
      )
    }
  }

  const topFailureReasons = Array.from(reasonsMap.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })
    .slice(0, MAX_TOP_FAILURE_REASONS)
    .map(([reason, count]) => ({ reason, count }))

  const targetNamespaces = namespaceScope.length
  const dataConfidence: WorkflowsReliabilityStatus['data_confidence'] =
    collectionErrors === 0 ? 'high' : collectedNamespaces === 0 ? 'unknown' : 'degraded'
  const collectionMessage =
    dataConfidence === 'high'
      ? ''
      : [
          dataConfidence === 'unknown'
            ? `workflow reliability unavailable (${collectionErrors}/${targetNamespaces} namespace queries failed)`
            : `workflow reliability partially unavailable (${collectionErrors}/${targetNamespaces} namespace queries failed)`,
          collectionErrorMessages.length > 0
            ? `sample errors: ${collectionErrorMessages.slice(0, MAX_WORKFLOW_COLLECTION_ERROR_SAMPLE).join(' | ')}`
            : '',
        ]
          .filter((value) => value.length > 0)
          .join('; ')

  return {
    active_job_runs: activeJobRuns,
    recent_failed_jobs: recentFailedJobs,
    backoff_limit_exceeded_jobs: backoffLimitExceededJobs,
    window_minutes: windowMinutes,
    top_failure_reasons: topFailureReasons,
    data_confidence: dataConfidence,
    collection_errors: collectionErrors,
    collected_namespaces: collectedNamespaces,
    target_namespaces: targetNamespaces,
    message: collectionMessage,
  }
}

const asDependencyReason = (name: string, suffix: string) => `${name.replace(/-/g, '_')}_${suffix}`

export const buildDependencyQuorum = (input: {
  controllers: ControllerStatus[]
  runtimeAdapters: RuntimeAdapterStatus[]
  database: DatabaseStatus
  watchReliability: ControlPlaneWatchReliabilitySummary
  workflows: WorkflowsReliabilityStatus
  rolloutHealth: ControlPlaneRolloutHealth
  empiricalServices: EmpiricalServicesStatus
  now: Date
  warningBackoffThreshold: number
  degradedBackoffThreshold: number
  watchReliabilityBlockErrorsThreshold: number
  watchReliabilityBlockRestartsThreshold: number
  executionTrust?: ExecutionTrustStatus
}): DependencyQuorumStatus => {
  const blockReasons: string[] = []
  const delayReasons: string[] = []
  const asOf = input.now.toISOString()
  const workflowTopReasons = input.workflows.top_failure_reasons
    .map((item) => item.reason)
    .filter((reason) => reason.length > 0)
  const segmentReasons = new Map<DependencyQuorumSegmentName, string[]>()
  const segmentScopes = new Map<DependencyQuorumSegmentName, DependencyQuorumSegmentScope>()
  const segmentConfidences = new Map<DependencyQuorumSegmentName, DependencyQuorumConfidence>()

  const setSegmentScope = (segment: DependencyQuorumSegmentName, scope: DependencyQuorumSegmentScope) => {
    segmentScopes.set(segment, pickBroaderDependencyScope(segmentScopes.get(segment), scope))
  }

  const appendSegmentReason = (
    segment: DependencyQuorumSegmentName,
    reason: string,
    scope: DependencyQuorumSegmentScope,
    confidence: DependencyQuorumConfidence,
  ) => {
    const list = segmentReasons.get(segment) ?? []
    list.push(reason)
    segmentReasons.set(segment, list)
    setSegmentScope(segment, scope)
    segmentConfidences.set(segment, pickLowerDependencyConfidence(segmentConfidences.get(segment), confidence))
  }

  const addControlRuntimeReason = (reason: string, status: 'blocked' | 'degraded') => {
    appendSegmentReason('control_runtime', reason, 'global', status === 'blocked' ? 'low' : 'medium')
  }

  const addWorkflowReason = (reason: string, status: 'blocked' | 'degraded') => {
    appendSegmentReason(
      'dependency_quorum',
      reason,
      status === 'blocked' ? 'global' : 'single_capability',
      status === 'blocked' ? 'low' : 'medium',
    )
  }

  const addWatchReason = (reason: string) => {
    appendSegmentReason('watch_stream', reason, 'single_capability', 'medium')
  }

  const addRolloutReason = (reason: string) => {
    appendSegmentReason('control_runtime', reason, 'single_capability', 'medium')
  }

  const addExecutionTrustReason = (reason: string, status: 'blocked' | 'degraded') => {
    appendSegmentReason('freshness_authority', reason, 'global', status === 'blocked' ? 'low' : 'medium')
  }

  const summarizeSegment = (
    segment: DependencyQuorumSegmentName,
    status: DependencyQuorumSegmentStatus,
  ): DependencyQuorumSegment => ({
    segment,
    status,
    scope: segmentScopes.get(segment) ?? 'global',
    confidence: segmentConfidences.get(segment) ?? 'high',
    reasons: uniqueStrings(segmentReasons.get(segment) ?? []),
    as_of: asOf,
  })

  for (const controller of input.controllers) {
    if (controller.status === 'healthy') continue

    if (controller.status === 'unknown') {
      blockReasons.push(asDependencyReason(controller.name, 'status_unknown'))
      addControlRuntimeReason(asDependencyReason(controller.name, 'status_unknown'), 'blocked')
      continue
    }

    if (controller.name === 'agents-controller') {
      blockReasons.push('agents_controller_unavailable')
      addControlRuntimeReason('agents_controller_unavailable', 'blocked')
      continue
    }
    delayReasons.push(`${controller.name.replace(/-/g, '_')}_degraded`)
    addControlRuntimeReason(`${controller.name.replace(/-/g, '_')}_degraded`, 'degraded')
  }

  const workflowAdapter = input.runtimeAdapters.find((adapter) => adapter.name === 'workflow')
  if (!workflowAdapter) {
    blockReasons.push('workflow_runtime_unavailable')
    addControlRuntimeReason('workflow_runtime_unavailable', 'blocked')
  } else if (workflowAdapter.status === 'unknown') {
    blockReasons.push('workflow_runtime_status_unknown')
    addControlRuntimeReason('workflow_runtime_status_unknown', 'blocked')
  } else if (workflowAdapter.available === false || workflowAdapter.status === 'degraded') {
    blockReasons.push('workflow_runtime_unavailable')
    addControlRuntimeReason('workflow_runtime_unavailable', 'blocked')
  }

  if (input.database.status !== 'healthy') {
    blockReasons.push('control_plane_database_unhealthy')
    addControlRuntimeReason('control_plane_database_unhealthy', 'blocked')
  }

  if (input.workflows.data_confidence === 'unknown') {
    blockReasons.push('workflows_data_unknown')
    addWorkflowReason('workflows_data_unknown', 'blocked')
  } else if (input.workflows.data_confidence === 'degraded') {
    delayReasons.push('workflows_data_degraded')
    addWorkflowReason('workflows_data_degraded', 'degraded')
  }

  if (input.executionTrust?.status === 'blocked') {
    blockReasons.push('execution_trust_blocked')
    addExecutionTrustReason('execution_trust_blocked', 'blocked')
  } else if (input.executionTrust?.status === 'unknown') {
    blockReasons.push('execution_trust_unknown')
    addExecutionTrustReason('execution_trust_unknown', 'blocked')
  } else if (input.executionTrust?.status === 'degraded') {
    delayReasons.push('execution_trust_degraded')
    addExecutionTrustReason('execution_trust_degraded', 'degraded')
  }

  if (input.workflows.backoff_limit_exceeded_jobs >= input.degradedBackoffThreshold) {
    blockReasons.push('workflow_backoff_limit_exceeded')
    addWorkflowReason('workflow_backoff_limit_exceeded', 'blocked')
  } else if (input.workflows.backoff_limit_exceeded_jobs >= input.warningBackoffThreshold) {
    delayReasons.push('workflow_backoff_warning')
    addWorkflowReason('workflow_backoff_warning', 'degraded')
  }

  const maxWatchReliabilityRestarts = (input.watchReliability.streams ?? []).reduce(
    (max, stream) => Math.max(max, stream.restarts),
    0,
  )
  const isWatchReliabilityBlocked =
    input.watchReliability.status === 'degraded' &&
    (input.watchReliability.total_errors >= input.watchReliabilityBlockErrorsThreshold ||
      maxWatchReliabilityRestarts >= input.watchReliabilityBlockRestartsThreshold)

  if (isWatchReliabilityBlocked) {
    blockReasons.push('watch_reliability_blocked')
  } else if (input.watchReliability.status === 'degraded') {
    delayReasons.push('watch_reliability_degraded')
    addWatchReason('watch_reliability_degraded')
  }

  if (hasMaterialRolloutDegradation(input.rolloutHealth)) {
    delayReasons.push('rollout_health_degraded')
    addRolloutReason('rollout_health_degraded')
  }

  if (input.empiricalServices.jobs.status === 'degraded') {
    blockReasons.push('empirical_jobs_degraded')
  } else if (input.empiricalServices.jobs.status === 'unknown') {
    delayReasons.push('empirical_jobs_unknown')
  }

  const reasons = uniqueStrings(blockReasons.length > 0 ? blockReasons : delayReasons)
  const decision: DependencyQuorumStatus['decision'] =
    blockReasons.length > 0 ? 'block' : delayReasons.length > 0 ? 'delay' : 'allow'
  const segmentOrder: DependencyQuorumSegmentName[] = [
    'control_runtime',
    'dependency_quorum',
    'freshness_authority',
    'evidence_authority',
    'market_data_context',
    'watch_stream',
  ]
  const segments: DependencyQuorumSegment[] = segmentOrder.flatMap((segment) => {
    const segmentReasonSet = segmentReasons.get(segment)
    if (segmentReasonSet == null || segmentReasonSet.length === 0) {
      return [summarizeSegment(segment, 'healthy')]
    }
    const hasBlock = segmentReasonSet.some((reason) => blockReasons.includes(reason))
    const status: DependencyQuorumSegmentStatus = hasBlock ? 'blocked' : 'degraded'
    return [summarizeSegment(segment, status)]
  })
  const delayedSegments = segments.filter((segment) => segment.status === 'degraded')
  const blockedSegments = segments.filter((segment) => segment.status === 'blocked')
  const resolveSegmentScope = (items: DependencyQuorumSegment[]) =>
    items.reduce<DependencyQuorumSegmentScope | undefined>(
      (scope, segment) => pickBroaderDependencyScope(scope, segment.scope),
      undefined,
    )
  const degradationScope =
    decision === 'block'
      ? (resolveSegmentScope(blockedSegments) ?? 'global')
      : decision === 'delay'
        ? (resolveSegmentScope(delayedSegments) ?? 'single_capability')
        : undefined
  const message =
    decision === 'allow'
      ? 'Control-plane admission dependencies are healthy.'
      : [
          decision === 'block'
            ? 'Control-plane dependency quorum is blocked.'
            : 'Control-plane dependency quorum is degraded; delay capital promotion.',
          workflowTopReasons.length > 0 ? `recent workflow reasons: ${workflowTopReasons.join(', ')}` : '',
          input.workflows.message.length > 0 ? input.workflows.message : '',
        ]
          .filter((value) => value.length > 0)
          .join(' ')

  return {
    decision,
    reasons,
    message,
    segments,
    degradation_scope: degradationScope,
  }
}
