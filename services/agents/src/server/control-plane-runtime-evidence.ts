import { Context, Data, Effect, Layer } from 'effect'

import type {
  ControlPlaneRolloutHealth,
  DeploymentRolloutStatus,
  WorkflowsReliabilityStatus,
} from '@proompteng/agent-contracts'

import {
  createKubeGateway,
  type KubeGateway,
  type KubeGatewayCondition,
  type KubeGatewayDeployment,
} from './kube-gateway'

type EnvSource = Record<string, string | undefined>

export type {
  ControlPlaneRolloutHealth,
  DeploymentRolloutStatus,
  WorkflowFailureReason,
  WorkflowsReliabilityStatus,
} from '@proompteng/agent-contracts'

export type ControlPlaneRuntimeEvidence = {
  workflows: WorkflowsReliabilityStatus
  rolloutHealth: ControlPlaneRolloutHealth
}

export type CollectControlPlaneRuntimeEvidenceInput = {
  namespace: string
  now: Date
  env?: EnvSource
}

export class ControlPlaneRuntimeEvidenceError extends Data.TaggedError('ControlPlaneRuntimeEvidenceError')<{
  readonly operation: string
  readonly namespace: string
  readonly message: string
  readonly retryable: boolean
}> {}

export type ControlPlaneRuntimeEvidenceService = {
  collect: (
    input: CollectControlPlaneRuntimeEvidenceInput,
  ) => Effect.Effect<ControlPlaneRuntimeEvidence, ControlPlaneRuntimeEvidenceError>
}

export class ControlPlaneRuntimeEvidenceApi extends Context.Tag('ControlPlaneRuntimeEvidenceApi')<
  ControlPlaneRuntimeEvidenceApi,
  ControlPlaneRuntimeEvidenceService
>() {}

export type ControlPlaneRuntimeEvidenceDependencies = {
  kubeGateway?: Pick<KubeGateway, 'listJobs' | 'listDeployments'>
  env?: EnvSource
}

const DEFAULT_WORKFLOW_WINDOW_MINUTES = 60
const DEFAULT_ROLLOUT_DEPLOYMENTS = ['agents', 'agents-controllers']
const AGENT_RUN_JOB_SELECTOR = 'agents.proompteng.ai/agent-run'
const MAX_TOP_FAILURE_REASONS = 5
const MS_PER_MINUTE = 60 * 1000

const normalizeMessage = (value: unknown) => (value instanceof Error ? value.message : String(value))

const categorizeEvidenceError = (operation: string, namespace: string, error: unknown) => {
  const message = normalizeMessage(error)
  const normalized = message.toLowerCase()
  const retryable =
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('econnreset') ||
    normalized.includes('connection') ||
    normalized.includes('temporarily unavailable')
  return new ControlPlaneRuntimeEvidenceError({ operation, namespace, message, retryable })
}

const uniqueStrings = (values: string[]) => {
  const seen = new Set<string>()
  const unique: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }
  return unique
}

const parseStringList = (value: string | undefined) => {
  if (!value) return []
  const trimmed = value.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed)
        ? uniqueStrings(parsed.filter((entry): entry is string => typeof entry === 'string'))
        : []
    } catch {
      return []
    }
  }
  return uniqueStrings(trimmed.split(','))
}

const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const resolveWorkflowNamespaces = (namespace: string, env: EnvSource) =>
  uniqueStrings([namespace, ...parseStringList(env.AGENTS_WORKFLOW_RELIABILITY_NAMESPACES)])

const resolveWorkflowWindowMinutes = (env: EnvSource) =>
  parsePositiveInteger(env.AGENTS_WORKFLOW_RELIABILITY_WINDOW_MINUTES, DEFAULT_WORKFLOW_WINDOW_MINUTES)

const resolveRolloutDeployments = (env: EnvSource) => {
  const parsed = parseStringList(env.AGENTS_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS)
  return parsed.length > 0 ? parsed : [...DEFAULT_ROLLOUT_DEPLOYMENTS]
}

const safeNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0

const parseIsoMs = (value: string | null | undefined): number | null => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const terminalFailedCondition = (conditions: KubeGatewayCondition[]) => {
  let selected: KubeGatewayCondition | null = null
  let selectedAt = Number.MIN_SAFE_INTEGER
  for (const condition of conditions) {
    if (condition.type !== 'Failed' || condition.status?.toLowerCase() !== 'true') continue
    const occurredAt = parseIsoMs(condition.lastTransitionTime)
    if (selected === null || (occurredAt !== null && occurredAt > selectedAt)) {
      selected = condition
      selectedAt = occurredAt ?? selectedAt
    }
  }
  return selected
}

const isBackoffLimitExceededCondition = (condition: KubeGatewayCondition) => condition.reason === 'BackoffLimitExceeded'

const collectWorkflows = async ({
  kubeGateway,
  namespace,
  now,
  env,
}: {
  kubeGateway: Pick<KubeGateway, 'listJobs'>
  namespace: string
  now: Date
  env: EnvSource
}): Promise<WorkflowsReliabilityStatus> => {
  const namespaces = resolveWorkflowNamespaces(namespace, env)
  const windowMinutes = resolveWorkflowWindowMinutes(env)
  const nowMs = now.getTime()
  const windowStartMs = nowMs - windowMinutes * MS_PER_MINUTE
  const reasonsMap = new Map<string, number>()
  const collectionErrorMessages: string[] = []
  let activeJobRuns = 0
  let recentFailedJobs = 0
  let backoffLimitExceededJobs = 0
  let collectionErrors = 0
  let collectedNamespaces = 0

  for (const currentNamespace of namespaces) {
    try {
      const jobs = await kubeGateway.listJobs(currentNamespace, AGENT_RUN_JOB_SELECTOR)
      collectedNamespaces += 1
      for (const job of jobs) {
        const active = safeNumber(job.status.active)
        if (active > 0) activeJobRuns += 1

        const failedCondition = terminalFailedCondition(job.status.conditions)
        const referenceMs = failedCondition
          ? (parseIsoMs(failedCondition.lastTransitionTime) ??
            parseIsoMs(job.status.completionTime) ??
            parseIsoMs(job.status.startTime) ??
            parseIsoMs(job.metadata.creationTimestamp))
          : null
        const failedInWindow =
          failedCondition !== null && referenceMs !== null && referenceMs >= windowStartMs && referenceMs <= nowMs

        if (failedInWindow) {
          recentFailedJobs += 1
        }

        if (failedInWindow) {
          const reason = failedCondition.reason?.trim()
          if (reason) {
            reasonsMap.set(reason, (reasonsMap.get(reason) ?? 0) + 1)
          }
          if (isBackoffLimitExceededCondition(failedCondition)) {
            backoffLimitExceededJobs += 1
          }
        }
      }
    } catch (error) {
      collectionErrors += 1
      collectionErrorMessages.push(`${currentNamespace}: ${normalizeMessage(error)}`)
    }
  }

  const topFailureReasons = Array.from(reasonsMap.entries())
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0].localeCompare(right[0])
    })
    .slice(0, MAX_TOP_FAILURE_REASONS)
    .map(([reason, count]) => ({ reason, count }))
  const dataConfidence: WorkflowsReliabilityStatus['data_confidence'] =
    collectionErrors === 0 ? 'high' : collectedNamespaces === 0 ? 'unknown' : 'degraded'
  const targetNamespaces = namespaces.length
  const message =
    dataConfidence === 'high'
      ? `${collectedNamespaces} namespace(s) collected for AgentRun job evidence`
      : [
          dataConfidence === 'unknown'
            ? `AgentRun job evidence unavailable (${collectionErrors}/${targetNamespaces} namespace queries failed)`
            : `AgentRun job evidence partially unavailable (${collectionErrors}/${targetNamespaces} namespace queries failed)`,
          collectionErrorMessages.length > 0 ? `sample errors: ${collectionErrorMessages.slice(0, 3).join(' | ')}` : '',
        ]
          .filter((entry) => entry.length > 0)
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
    message,
  }
}

const conditionHealthy = (conditions: KubeGatewayCondition[], type: string) =>
  conditions.find((condition) => condition.type === type)?.status?.toLowerCase() === 'true'

const buildDeploymentRolloutEntry = (deployment: KubeGatewayDeployment, namespace: string): DeploymentRolloutStatus => {
  const desiredReplicas = safeNumber(deployment.spec.replicas)
  const readyReplicas = safeNumber(deployment.status.readyReplicas)
  const availableReplicas = safeNumber(deployment.status.availableReplicas)
  const updatedReplicas = safeNumber(deployment.status.updatedReplicas)
  const unavailableReplicas = safeNumber(deployment.status.unavailableReplicas)

  if (desiredReplicas === 0) {
    return {
      name: deployment.metadata.name,
      namespace,
      status: 'disabled',
      desired_replicas: desiredReplicas,
      ready_replicas: readyReplicas,
      available_replicas: availableReplicas,
      updated_replicas: updatedReplicas,
      unavailable_replicas: unavailableReplicas,
      message: 'scaled to zero replicas',
    }
  }

  const reasons: string[] = []
  if (!conditionHealthy(deployment.status.conditions, 'Available')) {
    reasons.push('available condition is false')
  }
  if (!conditionHealthy(deployment.status.conditions, 'Progressing')) {
    reasons.push('progressing condition is not true')
  }
  if (
    readyReplicas < desiredReplicas ||
    availableReplicas < desiredReplicas ||
    updatedReplicas < desiredReplicas ||
    unavailableReplicas > 0
  ) {
    reasons.push(
      `replicas are behind: ready=${readyReplicas}, available=${availableReplicas}, updated=${updatedReplicas}, desired=${desiredReplicas}`,
    )
  }

  return {
    name: deployment.metadata.name,
    namespace,
    status: reasons.length === 0 ? 'healthy' : 'degraded',
    desired_replicas: desiredReplicas,
    ready_replicas: readyReplicas,
    available_replicas: availableReplicas,
    updated_replicas: updatedReplicas,
    unavailable_replicas: unavailableReplicas,
    message: reasons.length === 0 ? 'deployment rollout healthy' : reasons.join('; '),
  }
}

const unknownRolloutHealth = (message: string): ControlPlaneRolloutHealth => ({
  status: 'unknown',
  observed_deployments: 0,
  degraded_deployments: 0,
  deployments: [],
  message,
})

const collectRolloutHealth = async ({
  kubeGateway,
  namespace,
  env,
}: {
  kubeGateway: Pick<KubeGateway, 'listDeployments'>
  namespace: string
  env: EnvSource
}): Promise<ControlPlaneRolloutHealth> => {
  try {
    const expectedNames = resolveRolloutDeployments(env)
    const deployments = await kubeGateway.listDeployments(namespace)
    const byName = new Map(deployments.map((deployment) => [deployment.metadata.name, deployment]))
    const entries = expectedNames.map((name): DeploymentRolloutStatus => {
      const deployment = byName.get(name)
      if (!deployment) {
        return {
          name,
          namespace,
          status: 'degraded',
          desired_replicas: 0,
          ready_replicas: 0,
          available_replicas: 0,
          updated_replicas: 0,
          unavailable_replicas: 0,
          message: `deployment ${name} not found in namespace ${namespace}`,
        }
      }
      return buildDeploymentRolloutEntry(deployment, namespace)
    })
    const degradedDeployments = entries.filter((entry) => entry.status === 'degraded').length
    return {
      status: degradedDeployments > 0 ? 'degraded' : 'healthy',
      observed_deployments: entries.length,
      degraded_deployments: degradedDeployments,
      deployments: entries,
      message:
        degradedDeployments > 0
          ? `${degradedDeployments} configured deployment(s) degraded in rollout`
          : `${entries.length} configured deployment(s) healthy`,
    }
  } catch (error) {
    return unknownRolloutHealth(`rollout health unavailable: ${normalizeMessage(error)}`)
  }
}

export const createControlPlaneRuntimeEvidenceService = (
  deps: ControlPlaneRuntimeEvidenceDependencies = {},
): ControlPlaneRuntimeEvidenceService => ({
  collect: (input) =>
    Effect.tryPromise({
      try: async () => {
        const env = input.env ?? deps.env ?? process.env
        const kubeGateway = deps.kubeGateway ?? createKubeGateway()
        const [workflows, rolloutHealth] = await Promise.all([
          collectWorkflows({ kubeGateway, namespace: input.namespace, now: input.now, env }),
          collectRolloutHealth({ kubeGateway, namespace: input.namespace, env }),
        ])
        return { workflows, rolloutHealth }
      },
      catch: (error) => categorizeEvidenceError('collectRuntimeEvidence', input.namespace, error),
    }),
})

export const ControlPlaneRuntimeEvidenceApiLive = Layer.succeed(
  ControlPlaneRuntimeEvidenceApi,
  createControlPlaneRuntimeEvidenceService(),
)

export const collectControlPlaneRuntimeEvidence = (
  input: CollectControlPlaneRuntimeEvidenceInput,
  deps: ControlPlaneRuntimeEvidenceDependencies = {},
) => Effect.runPromise(createControlPlaneRuntimeEvidenceService(deps).collect(input))
