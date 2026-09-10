import { randomUUID } from 'node:crypto'

import { Context, Effect, Layer } from 'effect'

import { resolveAgentRunAdmissionConfig } from '../agents-controller/controller-config'
import { resolveAgentRunnerDefaultsConfig } from '../agents-controller/runtime-config'
import { resolveWorkloadImage } from '../agents-controller/workload-image'
import { parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'
import {
  extractAllowedImplementationSourceProviders,
  extractAllowedServiceAccounts,
  extractImplementationSourceProvider,
  extractRequiredSecrets,
  resolveEffectiveServiceAccount,
  type PolicyChecks,
  validatePolicies,
} from '../primitives-policy'

import type { AgentRunRuntimeConfigOptions, AgentRunsApiDependencies } from './agent-runs-dependencies'
import {
  AgentRunAdmissionRejectedError,
  AgentRunConflictError,
  AgentRunForbiddenError,
  AgentRunInvalidPayloadError,
  AgentRunKubeError,
  type AgentRunKubeOperation,
  AgentRunNotFoundError,
  AgentRunPolicyDeniedError,
  type AgentRunSubmitError,
  type AgentRunSubmitSuccess,
  describeAgentRunSubmitError,
  toErrorMessage,
} from './agent-run-errors'
import { AgentRunStoreService, makeAgentRunStoreService } from './agent-run-store'
import {
  type AgentRunPayload,
  type WorkflowLoopPayload,
  type WorkflowStepPayload,
  parseGoal,
  parseOptionalNumber,
} from './agent-runs-payload'
import { buildDeliveryIdLabels } from './delivery-labels'

type AgentRunQueueDepthRecorder = NonNullable<AgentRunsApiDependencies['recordAgentQueueDepth']>
type AgentRunAuditContextResolver = NonNullable<AgentRunsApiDependencies['resolveAuditContextFromRequest']>
type AgentRunRepositoryResolver = NonNullable<AgentRunsApiDependencies['resolveRepositoryFromParameters']>
type AgentRunResourceLookupOperation = Extract<AgentRunKubeOperation, 'get-existing-run' | 'get-idempotent-run'>
type AgentRunKubernetesResource = Record<string, unknown>

type AgentRunKubernetesServiceDefinition = {
  readonly client: (namespace: string) => Effect.Effect<KubernetesClient, AgentRunKubeError>
  readonly getAgentRun: (
    kube: KubernetesClient,
    operation: AgentRunResourceLookupOperation,
    name: string,
    namespace: string,
  ) => Effect.Effect<AgentRunKubernetesResource | null, AgentRunKubeError>
  readonly getAgent: (
    kube: KubernetesClient,
    name: string,
    namespace: string,
  ) => Effect.Effect<AgentRunKubernetesResource | null, AgentRunKubeError>
  readonly getAgentProvider: (
    kube: KubernetesClient,
    name: string,
    namespace: string,
  ) => Effect.Effect<AgentRunKubernetesResource | null, AgentRunKubeError>
  readonly getImplementationSpec: (
    kube: KubernetesClient,
    name: string,
    namespace: string,
  ) => Effect.Effect<AgentRunKubernetesResource | null, AgentRunKubeError>
  readonly getVcsProvider: (
    kube: KubernetesClient,
    name: string,
    namespace: string,
  ) => Effect.Effect<AgentRunKubernetesResource | null, AgentRunKubeError>
  readonly evaluateAdmissionLimits: (
    kube: KubernetesClient,
    namespace: string,
    repository: string | null,
    config: Pick<AgentRunSubmissionConfig, 'admissionNamespaces' | 'concurrency' | 'queue' | 'rate'>,
    now: number,
    recordQueueDepth: AgentRunQueueDepthRecorder,
  ) => Effect.Effect<AdmissionDecision, AgentRunKubeError>
  readonly applyAgentRun: (
    kube: KubernetesClient,
    resource: AgentRunKubernetesResource,
    namespace: string,
  ) => Effect.Effect<AgentRunKubernetesResource, AgentRunKubeError>
}

type AgentRunPolicyServiceDefinition = {
  readonly validate: (
    namespace: string,
    checks: PolicyChecks,
    kube: KubernetesClient,
  ) => Effect.Effect<void, AgentRunPolicyDeniedError>
}

type AgentRunAuditContextServiceDefinition = {
  readonly resolve: AgentRunAuditContextResolver
}

type AgentRunRepositoryServiceDefinition = {
  readonly resolveFromParameters: AgentRunRepositoryResolver
}

type AgentRunQueueDepthServiceDefinition = {
  readonly record: AgentRunQueueDepthRecorder
}

type AgentRunIdGeneratorServiceDefinition = {
  readonly next: Effect.Effect<string>
}

export type AgentRunSubmissionConfig = {
  readonly idempotencyEnabled: boolean
  readonly idempotencyReservationTtlSeconds: number
  readonly vcsProvidersEnabled: boolean
  readonly defaultRunnerServiceAccount: string | null
  readonly admissionNamespaces: {
    readonly namespaces: string[]
    readonly includeCluster: boolean
  }
  readonly concurrency: {
    readonly perNamespace: number
    readonly cluster: number
  }
  readonly queue: {
    readonly perNamespace: number
    readonly perRepo: number
    readonly cluster: number
  }
  readonly rate: {
    readonly windowSeconds: number
    readonly perNamespace: number
    readonly perRepo: number
    readonly cluster: number
  }
}

type AgentRunRuntimeConfigServiceDefinition = {
  readonly resolveSubmissionConfig: (namespace: string) => Effect.Effect<AgentRunSubmissionConfig>
  readonly resolveDefaultRunnerImage: () => Effect.Effect<string | null>
  readonly isIdempotencyReservationStale: (
    createdAt: unknown,
    config: Pick<AgentRunSubmissionConfig, 'idempotencyReservationTtlSeconds'>,
  ) => Effect.Effect<boolean>
  readonly now: () => Effect.Effect<number>
}

export class AgentRunKubernetesService extends Context.Tag('agents/AgentRunKubernetesService')<
  AgentRunKubernetesService,
  AgentRunKubernetesServiceDefinition
>() {}

export class AgentRunPolicyService extends Context.Tag('agents/AgentRunPolicyService')<
  AgentRunPolicyService,
  AgentRunPolicyServiceDefinition
>() {}

export class AgentRunAuditContextService extends Context.Tag('agents/AgentRunAuditContextService')<
  AgentRunAuditContextService,
  AgentRunAuditContextServiceDefinition
>() {}

export class AgentRunRepositoryService extends Context.Tag('agents/AgentRunRepositoryService')<
  AgentRunRepositoryService,
  AgentRunRepositoryServiceDefinition
>() {}

export class AgentRunQueueDepthService extends Context.Tag('agents/AgentRunQueueDepthService')<
  AgentRunQueueDepthService,
  AgentRunQueueDepthServiceDefinition
>() {}

export class AgentRunIdGeneratorService extends Context.Tag('agents/AgentRunIdGeneratorService')<
  AgentRunIdGeneratorService,
  AgentRunIdGeneratorServiceDefinition
>() {}

export class AgentRunRuntimeConfigService extends Context.Tag('agents/AgentRunRuntimeConfigService')<
  AgentRunRuntimeConfigService,
  AgentRunRuntimeConfigServiceDefinition
>() {}

const normalizeParameterMap = (value: Record<string, unknown> | null): Record<string, string> | undefined => {
  if (!value) return undefined
  const entries = Object.entries(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    if (typeof raw !== 'string') {
      throw new Error(`parameters.${key} must be a string`)
    }
    output[key] = raw
  }
  return output
}

const normalizeStringMap = (
  value: Record<string, unknown> | null,
  path: string,
): Record<string, string> | undefined => {
  if (!value) return undefined
  const output: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw == null) continue
    if (typeof raw !== 'string') {
      throw new Error(`${path}.${key} must be a string`)
    }
    output[key] = raw
  }
  return Object.keys(output).length > 0 ? output : undefined
}

const normalizeMetadataGenerateName = (value: unknown): string | undefined => {
  if (value == null) return undefined
  const generateName = asString(value)
  if (!generateName) {
    throw new Error('metadata.generateName must be a non-empty string')
  }
  if (generateName.includes('/') || generateName.length > 253) {
    throw new Error('metadata.generateName must be a valid Kubernetes generateName prefix')
  }
  return generateName
}

const normalizeVcsMode = (value?: string | null) => {
  const raw = value?.trim().toLowerCase()
  if (raw === 'read-only' || raw === 'read-write' || raw === 'none') return raw
  return 'read-write'
}

const QUEUED_PHASES = new Set(['pending', 'queued', 'progressing', 'inprogress'])
const RUNNING_PHASE = 'running'

type RateBucket = { count: number; resetAt: number }

const admissionRateState = {
  cluster: { count: 0, resetAt: 0 } as RateBucket,
  perNamespace: new Map<string, RateBucket>(),
  perRepo: new Map<string, RateBucket>(),
}

const parseTimestampMs = (value: unknown): number | null => {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

export const makeAgentRunRuntimeConfigService = (
  options: AgentRunRuntimeConfigOptions = {},
): AgentRunRuntimeConfigServiceDefinition => {
  const env = options.env ?? process.env
  const now = options.now ?? Date.now

  return {
    resolveSubmissionConfig: (namespace) =>
      Effect.sync(() => {
        const config = resolveAgentRunAdmissionConfig(namespace, env)
        const runnerDefaults = resolveAgentRunnerDefaultsConfig(env)
        return {
          idempotencyEnabled: config.idempotencyEnabled,
          idempotencyReservationTtlSeconds: config.idempotencyReservationTtlSeconds,
          vcsProvidersEnabled: config.vcsProvidersEnabled,
          defaultRunnerServiceAccount: runnerDefaults.serviceAccount,
          admissionNamespaces: config.admissionNamespaces,
          concurrency: config.concurrency,
          queue: config.queue,
          rate: config.rate,
        }
      }),
    resolveDefaultRunnerImage: () => Effect.sync(() => resolveAgentRunnerDefaultsConfig(env).defaultRunnerImage),
    isIdempotencyReservationStale: (createdAt, config) =>
      Effect.sync(() => {
        const ttlSeconds = config.idempotencyReservationTtlSeconds
        if (ttlSeconds <= 0) return false
        const createdAtMs = parseTimestampMs(createdAt)
        if (createdAtMs == null) return false
        return now() - createdAtMs >= ttlSeconds * 1000
      }),
    now: () => Effect.sync(now),
  }
}

const normalizeRepository = (value: string) => value.trim().toLowerCase()

const resolveRepositoryFromParams = (params: Record<string, string> | undefined) => {
  if (!params) return ''
  const candidates = [params.repository, params.repo, params.issueRepository]
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate.trim()
  }
  return ''
}

const defaultResolveRepositoryFromParameters = (params: Record<string, string> | undefined) => {
  const repository = resolveRepositoryFromParams(params)
  return repository.length > 0 ? repository : undefined
}

const getKubeClient = (deps: Pick<AgentRunsApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const defaultResolveAuditContextFromRequest = (
  _request: Request,
  defaults: { deliveryId: string; namespace: string; repository?: string; source: string },
): Record<string, unknown> => defaults

const resolveRepositoryFromRawParams = (params: Record<string, unknown> | null) => {
  if (!params) return ''
  const candidates = [params.repository, params.repo, params.issueRepository]
  for (const candidate of candidates) {
    const value = asString(candidate)
    if (value) return value
  }
  return ''
}

const resolveRepositoryFromRun = (run: Record<string, unknown>) => {
  const statusRepo = asString(readNested(run, ['status', 'vcs', 'repository']))
  if (statusRepo) return statusRepo
  return resolveRepositoryFromRawParams(asRecord(readNested(run, ['spec', 'parameters'])))
}

const getRateBucket = (map: Map<string, RateBucket>, key: string) => {
  const existing = map.get(key)
  if (existing) return existing
  const created = { count: 0, resetAt: 0 }
  map.set(key, created)
  return created
}

const checkRateLimit = (bucket: RateBucket, limit: number, windowMs: number, now: number) => {
  if (limit <= 0) return { ok: true as const }
  if (now >= bucket.resetAt) {
    bucket.count = 0
    bucket.resetAt = now + windowMs
  }
  if (bucket.count >= limit) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    return { ok: false as const, retryAfterSeconds }
  }
  bucket.count += 1
  return { ok: true as const }
}

const parseWorkflowStepNumber = (value: unknown, path: string): number | undefined => {
  if (value == null) return undefined
  const parsed = parseOptionalNumber(value)
  if (parsed === undefined) {
    throw new Error(`${path} must be a number`)
  }
  if (parsed < 0) {
    throw new Error(`${path} must be >= 0`)
  }
  return Math.trunc(parsed)
}

const compactRecord = <T extends Record<string, unknown>>(record: T): T =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T

const parsePositiveWorkflowStepNumber = (value: unknown, path: string): number | undefined => {
  const parsed = parseWorkflowStepNumber(value, path)
  if (parsed !== undefined && parsed < 1) {
    throw new Error(`${path} must be >= 1`)
  }
  return parsed
}

const parseWorkflowLoop = (value: unknown, path: string): WorkflowLoopPayload | undefined => {
  if (value == null) return undefined
  const loop = asRecord(value)
  if (!loop) {
    throw new Error(`${path} must be an object`)
  }
  const maxIterations = parsePositiveWorkflowStepNumber(loop.maxIterations, `${path}.maxIterations`)
  if (maxIterations === undefined) {
    throw new Error(`${path}.maxIterations is required`)
  }
  const conditionRaw = asRecord(loop.condition)
  const sourceRaw = asRecord(conditionRaw?.source)
  const stateRaw = asRecord(loop.state)
  const volumeNamesRaw = stateRaw?.volumeNames
  if (volumeNamesRaw != null && !Array.isArray(volumeNamesRaw)) {
    throw new Error(`${path}.state.volumeNames must be an array`)
  }
  const volumeNames = Array.isArray(volumeNamesRaw)
    ? volumeNamesRaw.filter((item): item is string => typeof item === 'string')
    : undefined

  return {
    maxIterations,
    ...(conditionRaw
      ? {
          condition: compactRecord({
            type: asString(conditionRaw.type) ?? undefined,
            expression: asString(conditionRaw.expression) ?? undefined,
            ...(sourceRaw
              ? {
                  source: compactRecord({
                    type: asString(sourceRaw.type) ?? undefined,
                    path: asString(sourceRaw.path) ?? undefined,
                    onMissing: asString(sourceRaw.onMissing) ?? undefined,
                    onInvalid: asString(sourceRaw.onInvalid) ?? undefined,
                  }),
                }
              : {}),
          }),
        }
      : {}),
    ...(stateRaw
      ? {
          state: compactRecord({
            required: stateRaw.required === true,
            ...(volumeNames ? { volumeNames } : {}),
          }),
        }
      : {}),
  }
}

const parseWorkflowSteps = (value: Record<string, unknown> | null): WorkflowStepPayload[] | undefined => {
  if (!value) return undefined
  const rawSteps = value.steps
  if (!Array.isArray(rawSteps)) {
    throw new Error('workflow.steps must be an array')
  }
  return rawSteps.map((raw, index) => {
    const step = asRecord(raw)
    if (!step) {
      throw new Error(`workflow.steps[${index}] must be an object`)
    }
    const name = asString(step.name)
    if (!name) {
      throw new Error(`workflow.steps[${index}].name is required`)
    }
    let parameters: Record<string, string> | undefined
    try {
      parameters = normalizeParameterMap(asRecord(step.parameters))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`workflow.steps[${index}] ${message}`)
    }
    const forbiddenStepPromptKey = Object.keys(parameters ?? {}).find((key) => key.trim().toLowerCase() === 'prompt')
    if (forbiddenStepPromptKey) {
      throw new Error(
        `workflow.steps[${index}].parameters.${forbiddenStepPromptKey} is not allowed; use ImplementationSpec.spec.text`,
      )
    }

    const implementationSpecRef = asRecord(step.implementationSpecRef)
    const implementationSpecName = asString(implementationSpecRef?.name)
    const implementationRaw = asRecord(step.implementation)
    const implementationInline = asRecord(implementationRaw?.inline) ?? implementationRaw ?? undefined

    return {
      name,
      implementationSpecRef: implementationSpecName ? { name: implementationSpecName } : undefined,
      implementation: implementationInline,
      parameters,
      workload: asRecord(step.workload) ?? undefined,
      retries: parseWorkflowStepNumber(step.retries, `workflow.steps[${index}].retries`),
      retryBackoffSeconds: parseWorkflowStepNumber(
        step.retryBackoffSeconds,
        `workflow.steps[${index}].retryBackoffSeconds`,
      ),
      timeoutSeconds: parseWorkflowStepNumber(step.timeoutSeconds, `workflow.steps[${index}].timeoutSeconds`),
      loop: parseWorkflowLoop(step.loop, `workflow.steps[${index}].loop`),
    }
  })
}

const parseAgentRunPayload = (payload: Record<string, unknown>): AgentRunPayload => {
  const agentRef = asRecord(payload.agentRef)
  const name = asString(agentRef?.name)
  if (!name) throw new Error('agentRef.name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const metadataRaw = asRecord(payload.metadata)
  if (payload.metadata != null && !metadataRaw) {
    throw new Error('metadata must be an object')
  }
  const metadata =
    metadataRaw != null
      ? {
          generateName: normalizeMetadataGenerateName(metadataRaw.generateName),
          labels: normalizeStringMap(asRecord(metadataRaw.labels), 'metadata.labels'),
          annotations: normalizeStringMap(asRecord(metadataRaw.annotations), 'metadata.annotations'),
        }
      : undefined
  const idempotencyKeyRaw = payload.idempotencyKey
  const idempotencyKey = asString(idempotencyKeyRaw) ?? undefined
  if (idempotencyKeyRaw != null && !idempotencyKey) {
    throw new Error('idempotencyKey must be a string')
  }
  if (payload.systemPrompt != null || payload.systemPromptRef != null) {
    throw new Error(
      'AgentRun-level systemPrompt/systemPromptRef overrides are not allowed; configure Agent.spec.defaults instead',
    )
  }

  const implementationSpecRef = asRecord(payload.implementationSpecRef)
  const implementationSpecName = asString(implementationSpecRef?.name)

  const inline = asRecord(payload.implementation)
  const goal = parseGoal(asRecord(payload.goal))
  const runtime = asRecord(payload.runtime)
  if (!runtime) throw new Error('runtime is required')
  const runtimeType = asString(runtime.type)
  if (!runtimeType) throw new Error('runtime.type is required')

  const parameters = normalizeParameterMap(asRecord(payload.parameters))
  const forbiddenPromptKey = Object.keys(parameters ?? {}).find((key) => key.trim().toLowerCase() === 'prompt')
  if (forbiddenPromptKey) {
    throw new Error(`parameters.${forbiddenPromptKey} is not allowed; use ImplementationSpec.spec.text`)
  }
  const policy = asRecord(payload.policy) ?? undefined
  const secrets = Array.isArray(payload.secrets)
    ? payload.secrets.filter((item) => typeof item === 'string')
    : undefined

  const memoryRef = asRecord(payload.memoryRef)
  const memoryRefName = asString(memoryRef?.name)
  const workload = asRecord(payload.workload) ?? undefined
  const vcsRef = asRecord(payload.vcsRef)
  const vcsRefName = asString(vcsRef?.name)
  const vcsPolicyRaw = asRecord(payload.vcsPolicy)
  const vcsPolicy =
    vcsPolicyRaw != null
      ? {
          required: vcsPolicyRaw.required === true,
          mode: asString(vcsPolicyRaw.mode) ?? undefined,
        }
      : undefined
  const ttlRaw = payload.ttlSecondsAfterFinished
  const ttlSecondsAfterFinished = parseOptionalNumber(ttlRaw)
  if (ttlRaw != null && ttlSecondsAfterFinished === undefined) {
    throw new Error('ttlSecondsAfterFinished must be a number')
  }
  if (ttlSecondsAfterFinished !== undefined && ttlSecondsAfterFinished < 0) {
    throw new Error('ttlSecondsAfterFinished must be >= 0')
  }

  if (!implementationSpecName && !inline) {
    throw new Error('implementationSpecRef or implementation is required')
  }

  const workflowSteps = parseWorkflowSteps(asRecord(payload.workflow))
  if (runtimeType === 'workflow' && (!workflowSteps || workflowSteps.length === 0)) {
    throw new Error('workflow.steps is required for workflow runtime')
  }

  return {
    agentRef: { name },
    namespace,
    metadata,
    idempotencyKey,
    implementationSpecRef: implementationSpecName ? { name: implementationSpecName } : undefined,
    implementation: inline ?? undefined,
    goal,
    runtime: { type: runtimeType, config: asRecord(runtime.config) ?? undefined },
    workflow: workflowSteps ? { steps: workflowSteps } : undefined,
    workload,
    memoryRef: memoryRefName ? { name: memoryRefName } : undefined,
    vcsRef: vcsRefName ? { name: vcsRefName } : undefined,
    vcsPolicy,
    parameters,
    secrets,
    policy,
    ttlSecondsAfterFinished,
  }
}

type AdmissionDecision =
  | { ok: true }
  | { ok: false; status: number; message: string; details?: Record<string, unknown> }

const isTerminalPhase = (value: string) => {
  const phase = value.trim().toLowerCase()
  return phase === 'succeeded' || phase === 'failed' || phase === 'cancelled'
}

const checkAdmissionRateLimits = (
  namespace: string,
  repository: string | null,
  limits: AgentRunSubmissionConfig['rate'],
  now: number,
): AdmissionDecision => {
  const windowMs = limits.windowSeconds * 1000

  const clusterResult = checkRateLimit(admissionRateState.cluster, limits.cluster, windowMs, now)
  if (!clusterResult.ok) {
    return {
      ok: false,
      status: 429,
      message: 'Cluster admission rate limit exceeded',
      details: { scope: 'cluster', retryAfterSeconds: clusterResult.retryAfterSeconds },
    }
  }

  const namespaceBucket = getRateBucket(admissionRateState.perNamespace, namespace)
  const namespaceResult = checkRateLimit(namespaceBucket, limits.perNamespace, windowMs, now)
  if (!namespaceResult.ok) {
    return {
      ok: false,
      status: 429,
      message: `Namespace ${namespace} admission rate limit exceeded`,
      details: { scope: 'namespace', namespace, retryAfterSeconds: namespaceResult.retryAfterSeconds },
    }
  }

  if (repository) {
    const repoKey = normalizeRepository(repository)
    const repoBucket = getRateBucket(admissionRateState.perRepo, repoKey)
    const repoResult = checkRateLimit(repoBucket, limits.perRepo, windowMs, now)
    if (!repoResult.ok) {
      return {
        ok: false,
        status: 429,
        message: `Repository ${repository} admission rate limit exceeded`,
        details: { scope: 'repo', repository, retryAfterSeconds: repoResult.retryAfterSeconds },
      }
    }
  }

  return { ok: true }
}

const evaluateAdmissionLimits = async (
  kube: KubernetesClient,
  namespace: string,
  repository: string | null,
  config: Pick<AgentRunSubmissionConfig, 'admissionNamespaces' | 'concurrency' | 'queue' | 'rate'>,
  now: number,
  recordQueueDepth: NonNullable<AgentRunsApiDependencies['recordAgentQueueDepth']>,
): Promise<AdmissionDecision> => {
  const rateDecision = checkAdmissionRateLimits(namespace, repository, config.rate, now)
  if (!rateDecision.ok) return rateDecision

  const { namespaces, includeCluster } = config.admissionNamespaces
  const normalizedRepo = repository ? normalizeRepository(repository) : ''
  const results = await Promise.all(
    namespaces.map(async (ns) => ({
      namespace: ns,
      list: await kube.list(RESOURCE_MAP.AgentRun, ns),
    })),
  )

  let runningNamespace = 0
  let queuedNamespace = 0
  let runningCluster = 0
  let queuedCluster = 0
  let queuedRepo = 0

  for (const result of results) {
    const items = Array.isArray(result.list.items) ? (result.list.items as Record<string, unknown>[]) : []
    for (const run of items) {
      const phaseRaw = asString(readNested(run, ['status', 'phase'])) ?? 'Pending'
      const phase = phaseRaw.trim().toLowerCase()
      const isRunning = phase === RUNNING_PHASE
      const isQueued = QUEUED_PHASES.has(phase)

      if (isRunning) runningCluster += 1
      if (isQueued) queuedCluster += 1

      if (result.namespace === namespace) {
        if (isRunning) runningNamespace += 1
        if (isQueued) queuedNamespace += 1
      }

      if (normalizedRepo) {
        const runRepo = resolveRepositoryFromRun(run)
        if (runRepo && normalizeRepository(runRepo) === normalizedRepo) {
          if (isQueued) queuedRepo += 1
        }
      }
    }
  }

  recordQueueDepth(queuedNamespace, { scope: 'namespace', namespace })
  if (includeCluster) {
    recordQueueDepth(queuedCluster, { scope: 'cluster' })
  }
  if (normalizedRepo) {
    recordQueueDepth(queuedRepo, { scope: 'repo', repository: normalizedRepo, namespace })
  }

  if (config.concurrency.perNamespace > 0 && runningNamespace >= config.concurrency.perNamespace) {
    return {
      ok: false,
      status: 429,
      message: `Namespace ${namespace} reached concurrency limit`,
      details: { scope: 'namespace', limit: config.concurrency.perNamespace, running: runningNamespace },
    }
  }

  if (includeCluster && config.concurrency.cluster > 0 && runningCluster >= config.concurrency.cluster) {
    return {
      ok: false,
      status: 429,
      message: 'Cluster concurrency limit reached',
      details: { scope: 'cluster', limit: config.concurrency.cluster, running: runningCluster },
    }
  }

  if (config.queue.perNamespace > 0 && queuedNamespace >= config.queue.perNamespace) {
    return {
      ok: false,
      status: 429,
      message: `Namespace ${namespace} reached queue limit`,
      details: { scope: 'namespace', limit: config.queue.perNamespace, queued: queuedNamespace },
    }
  }

  if (includeCluster && config.queue.cluster > 0 && queuedCluster >= config.queue.cluster) {
    return {
      ok: false,
      status: 429,
      message: 'Cluster queue limit reached',
      details: { scope: 'cluster', limit: config.queue.cluster, queued: queuedCluster },
    }
  }

  if (normalizedRepo && config.queue.perRepo > 0 && queuedRepo >= config.queue.perRepo) {
    return {
      ok: false,
      status: 429,
      message: `Repository ${repository} reached queue limit`,
      details: { scope: 'repo', limit: config.queue.perRepo, queued: queuedRepo, repository },
    }
  }

  return { ok: true }
}

const kubeEffect = <A>(
  operation: AgentRunKubeOperation,
  resource: string,
  namespace: string,
  run: () => Promise<A>,
): Effect.Effect<A, AgentRunKubeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentRunKubeError({ operation, resource, namespace, cause }),
  })

export const makeAgentRunSubmitLayer = (deps: AgentRunsApiDependencies) =>
  Layer.mergeAll(
    Layer.succeed(AgentRunStoreService, makeAgentRunStoreService(deps.storeFactory)),
    Layer.succeed(AgentRunKubernetesService, {
      client: (namespace) =>
        Effect.try({
          try: () => getKubeClient(deps),
          catch: (cause) =>
            new AgentRunKubeError({
              operation: 'create-client',
              resource: 'kubernetes-client',
              namespace,
              cause,
            }),
        }),
      getAgentRun: (kube, operation, name, namespace) =>
        kubeEffect(operation, RESOURCE_MAP.AgentRun, namespace, () => kube.get(RESOURCE_MAP.AgentRun, name, namespace)),
      getAgent: (kube, name, namespace) =>
        kubeEffect('get-agent', RESOURCE_MAP.Agent, namespace, () => kube.get(RESOURCE_MAP.Agent, name, namespace)),
      getAgentProvider: (kube, name, namespace) =>
        kubeEffect('get-agent-provider', RESOURCE_MAP.AgentProvider, namespace, () =>
          kube.get(RESOURCE_MAP.AgentProvider, name, namespace),
        ),
      getImplementationSpec: (kube, name, namespace) =>
        kubeEffect('get-implementation-spec', RESOURCE_MAP.ImplementationSpec, namespace, () =>
          kube.get(RESOURCE_MAP.ImplementationSpec, name, namespace),
        ),
      getVcsProvider: (kube, name, namespace) =>
        kubeEffect('get-vcs-provider', RESOURCE_MAP.VersionControlProvider, namespace, () =>
          kube.get(RESOURCE_MAP.VersionControlProvider, name, namespace),
        ),
      evaluateAdmissionLimits: (kube, namespace, repository, config, now, recordQueueDepth) =>
        kubeEffect('evaluate-admission-limits', RESOURCE_MAP.AgentRun, namespace, () =>
          evaluateAdmissionLimits(kube, namespace, repository, config, now, recordQueueDepth),
        ),
      applyAgentRun: (kube, resource, namespace) =>
        kubeEffect('apply-agent-run', RESOURCE_MAP.AgentRun, namespace, () => kube.apply(resource)),
    }),
    Layer.succeed(AgentRunPolicyService, {
      validate: (namespace, checks, kube) =>
        Effect.tryPromise({
          try: () => (deps.validatePolicies ?? validatePolicies)(namespace, checks, kube),
          catch: (cause) =>
            new AgentRunPolicyDeniedError({
              subject: checks.subject ?? { kind: 'AgentRun', name: 'unknown', namespace },
              cause,
            }),
        }),
    }),
    Layer.succeed(AgentRunAuditContextService, {
      resolve: deps.resolveAuditContextFromRequest ?? defaultResolveAuditContextFromRequest,
    }),
    Layer.succeed(AgentRunRepositoryService, {
      resolveFromParameters: deps.resolveRepositoryFromParameters ?? defaultResolveRepositoryFromParameters,
    }),
    Layer.succeed(AgentRunQueueDepthService, {
      record: deps.recordAgentQueueDepth ?? (() => undefined),
    }),
    Layer.succeed(AgentRunIdGeneratorService, {
      next: Effect.sync(deps.idGenerator ?? randomUUID),
    }),
    Layer.succeed(AgentRunRuntimeConfigService, makeAgentRunRuntimeConfigService(deps.runtimeConfig)),
  )

type IdempotencyReservationState = {
  created: boolean
  agentRunName: string | null
  idempotencyKey: string
  agentName: string
  namespace: string
}

const parseDryRunQuery = (request: Request) => {
  const raw = new URL(request.url).searchParams.get('dryRun')
  if (raw == null) return false
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true' || normalized === 'all') return true
  if (normalized === 'false') return false
  throw new Error('dryRun must be true, false, or All')
}

export const createAgentRunResource = (
  parsed: AgentRunPayload,
  deliveryId: string,
  runIdempotencyKey: string,
): Record<string, unknown> => ({
  apiVersion: 'agents.proompteng.ai/v1alpha1',
  kind: 'AgentRun',
  metadata: {
    generateName: parsed.metadata?.generateName ?? `${parsed.agentRef.name}-`,
    namespace: parsed.namespace,
    labels: {
      ...parsed.metadata?.labels,
      ...buildDeliveryIdLabels(deliveryId),
    },
    ...(parsed.metadata?.annotations ? { annotations: parsed.metadata.annotations } : {}),
  },
  spec: {
    agentRef: parsed.agentRef,
    implementationSpecRef: parsed.implementationSpecRef ?? undefined,
    implementation: parsed.implementation ? { inline: parsed.implementation } : undefined,
    goal: parsed.goal ?? undefined,
    runtime: parsed.runtime,
    workflow: parsed.workflow
      ? {
          steps: parsed.workflow.steps.map((step) => ({
            name: step.name,
            implementationSpecRef: step.implementationSpecRef ?? undefined,
            implementation: step.implementation ? { inline: step.implementation } : undefined,
            parameters: step.parameters ?? undefined,
            workload: step.workload ?? undefined,
            retries: step.retries ?? undefined,
            retryBackoffSeconds: step.retryBackoffSeconds ?? undefined,
            timeoutSeconds: step.timeoutSeconds ?? undefined,
            loop: step.loop ?? undefined,
          })),
        }
      : undefined,
    workload: parsed.workload ?? undefined,
    parameters: parsed.parameters ?? {},
    secrets: parsed.secrets ?? undefined,
    memoryRef: parsed.memoryRef ?? undefined,
    vcsRef: parsed.vcsRef ?? undefined,
    vcsPolicy: parsed.vcsPolicy ?? undefined,
    idempotencyKey: runIdempotencyKey,
    ttlSecondsAfterFinished: parsed.ttlSecondsAfterFinished ?? undefined,
  },
})

export const submitAgentRun = async (
  request: Request,
  deps: AgentRunsApiDependencies,
): Promise<AgentRunSubmitSuccess> => {
  const result = await Effect.runPromise(submitAgentRunEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Left') throw result.left
  return result.right
}

type AgentRunSubmitServices =
  | AgentRunStoreService
  | AgentRunKubernetesService
  | AgentRunPolicyService
  | AgentRunAuditContextService
  | AgentRunRepositoryService
  | AgentRunQueueDepthService
  | AgentRunIdGeneratorService
  | AgentRunRuntimeConfigService

export const submitAgentRunEffect = (
  request: Request,
  deps: AgentRunsApiDependencies,
): Effect.Effect<AgentRunSubmitSuccess, AgentRunSubmitError> =>
  submitAgentRunWithServicesEffect(request).pipe(Effect.provide(makeAgentRunSubmitLayer(deps)))

export const submitAgentRunWithServicesEffect = (
  request: Request,
): Effect.Effect<AgentRunSubmitSuccess, AgentRunSubmitError, AgentRunSubmitServices> =>
  Effect.gen(function* () {
    const stores = yield* AgentRunStoreService
    const kubernetes = yield* AgentRunKubernetesService
    const policies = yield* AgentRunPolicyService
    const auditContexts = yield* AgentRunAuditContextService
    const repositories = yield* AgentRunRepositoryService
    const queueDepth = yield* AgentRunQueueDepthService
    const ids = yield* AgentRunIdGeneratorService
    const runtimeConfig = yield* AgentRunRuntimeConfigService
    const deliveryId = yield* Effect.try({
      try: () => requireIdempotencyKey(request),
      catch: (cause) =>
        new AgentRunInvalidPayloadError({
          message: toErrorMessage(cause),
          cause,
        }),
    })
    const payload = yield* Effect.tryPromise({
      try: () => parseJsonBody(request),
      catch: (cause) =>
        new AgentRunInvalidPayloadError({
          message: toErrorMessage(cause),
          cause,
        }),
    })
    const parsed = yield* Effect.try({
      try: () => parseAgentRunPayload(payload),
      catch: (cause) =>
        new AgentRunInvalidPayloadError({
          message: toErrorMessage(cause),
          cause,
        }),
    })
    const dryRun = yield* Effect.try({
      try: () => parseDryRunQuery(request),
      catch: (cause) =>
        new AgentRunInvalidPayloadError({
          message: toErrorMessage(cause),
          cause,
        }),
    })
    const submissionConfig = yield* runtimeConfig.resolveSubmissionConfig(parsed.namespace)

    return yield* Effect.acquireUseRelease(
      stores.open,
      (activeStore) =>
        Effect.gen(function* () {
          const runIdempotencyKey = parsed.idempotencyKey ?? deliveryId
          const repository = repositories.resolveFromParameters(parsed.parameters)
          const auditContext = auditContexts.resolve(request, {
            deliveryId,
            namespace: parsed.namespace,
            repository,
            source: 'v1.agent-runs',
          })

          yield* stores.ready(activeStore)
          const existing = yield* stores.getByDeliveryId(activeStore, deliveryId)
          const kube = yield* kubernetes.client(parsed.namespace)

          if (existing) {
            const resourceNamespace =
              asString(readNested(existing.payload, ['resource', 'metadata', 'namespace'])) ??
              asString(readNested(existing.payload, ['request', 'namespace'])) ??
              parsed.namespace
            const resource = existing.externalRunId
              ? yield* kubernetes.getAgentRun(kube, 'get-existing-run', existing.externalRunId, resourceNamespace)
              : null
            return { status: 200, body: { ok: true, agentRun: existing, resource, idempotent: true } }
          }

          if (submissionConfig.idempotencyEnabled) {
            const scope = yield* stores.getIdempotencyKey(activeStore, {
              namespace: parsed.namespace,
              agentName: parsed.agentRef.name,
              idempotencyKey: runIdempotencyKey,
            })

            if (scope?.agentRunName) {
              const resource = yield* kubernetes.getAgentRun(
                kube,
                'get-idempotent-run',
                scope.agentRunName,
                parsed.namespace,
              )
              const phase = asString(readNested(resource, ['status', 'phase'])) ?? 'Pending'

              if (resource && !isTerminalPhase(phase)) {
                return yield* Effect.fail(
                  new AgentRunConflictError({
                    message: 'AgentRun already exists for idempotency key',
                    details: {
                      namespace: parsed.namespace,
                      agentName: parsed.agentRef.name,
                      idempotencyKey: runIdempotencyKey,
                      existingAgentRunName: scope.agentRunName,
                      phase,
                    },
                  }),
                )
              }

              return {
                status: 200,
                body: {
                  ok: true,
                  idempotent: true,
                  namespace: parsed.namespace,
                  agentName: parsed.agentRef.name,
                  idempotencyKey: runIdempotencyKey,
                  existingAgentRunName: scope.agentRunName,
                  resource,
                },
              }
            }
          }

          const agent = yield* kubernetes.getAgent(kube, parsed.agentRef.name, parsed.namespace)
          if (!agent) {
            return yield* Effect.fail(
              new AgentRunNotFoundError({
                resource: 'agent',
                name: parsed.agentRef.name,
                namespace: parsed.namespace,
              }),
            )
          }

          const agentSpec = (agent.spec ?? {}) as Record<string, unknown>
          const providerName = asString(readNested(agentSpec, ['providerRef', 'name']))
          const provider = providerName
            ? yield* kubernetes.getAgentProvider(kube, providerName, parsed.namespace)
            : null
          if (providerName && !provider) {
            return yield* Effect.fail(
              new AgentRunNotFoundError({
                resource: 'agent provider',
                name: providerName,
                namespace: parsed.namespace,
              }),
            )
          }
          const allowedServiceAccounts = extractAllowedServiceAccounts(agentSpec)
          const effectiveServiceAccount = resolveEffectiveServiceAccount(
            { runtime: parsed.runtime },
            provider,
            submissionConfig.defaultRunnerServiceAccount,
          )

          if (allowedServiceAccounts.length > 0 && !allowedServiceAccounts.includes(effectiveServiceAccount)) {
            return yield* Effect.fail(
              new AgentRunForbiddenError({ message: `service account ${effectiveServiceAccount} is not allowed` }),
            )
          }

          const allowedSourceProviders = extractAllowedImplementationSourceProviders(agentSpec)
          if (allowedSourceProviders.length > 0) {
            const implementations: Array<Record<string, unknown>> = []
            if (parsed.implementation) {
              implementations.push(parsed.implementation)
            } else if (parsed.implementationSpecRef?.name) {
              const implementationSpec = yield* kubernetes.getImplementationSpec(
                kube,
                parsed.implementationSpecRef.name,
                parsed.namespace,
              )
              const implementation = asRecord(implementationSpec?.spec)
              if (!implementation) {
                return yield* Effect.fail(
                  new AgentRunNotFoundError({
                    resource: 'implementation spec',
                    name: parsed.implementationSpecRef.name,
                    namespace: parsed.namespace,
                  }),
                )
              }
              implementations.push(implementation)
            }

            for (const step of parsed.workflow?.steps ?? []) {
              if (step.implementation) {
                implementations.push(step.implementation)
              } else if (step.implementationSpecRef?.name) {
                const implementationSpec = yield* kubernetes.getImplementationSpec(
                  kube,
                  step.implementationSpecRef.name,
                  parsed.namespace,
                )
                const implementation = asRecord(implementationSpec?.spec)
                if (!implementation) {
                  return yield* Effect.fail(
                    new AgentRunNotFoundError({
                      resource: 'implementation spec',
                      name: step.implementationSpecRef.name,
                      namespace: parsed.namespace,
                    }),
                  )
                }
                implementations.push(implementation)
              }
            }

            for (const implementation of implementations) {
              const sourceProvider = extractImplementationSourceProvider(implementation)
              if (!sourceProvider || !allowedSourceProviders.includes(sourceProvider)) {
                return yield* Effect.fail(
                  new AgentRunForbiddenError({
                    message: `implementation source provider ${sourceProvider ?? '<missing>'} is not allowed`,
                  }),
                )
              }
            }
          }

          const requiredSecrets = parsed.secrets ?? extractRequiredSecrets(agentSpec)
          const vcsSecrets = new Set<string>()
          const desiredVcsMode = normalizeVcsMode(parsed.vcsPolicy?.mode ?? null)
          const shouldResolveVcs = submissionConfig.vcsProvidersEnabled && desiredVcsMode !== 'none'
          const resolveVcsRefName = (): Effect.Effect<string | null, AgentRunKubeError> =>
            Effect.gen(function* () {
              if (parsed.vcsRef?.name) return parsed.vcsRef.name
              if (parsed.implementation) {
                const inline = asRecord(parsed.implementation)
                const inlineVcsRef = asRecord(inline?.vcsRef)
                const inlineVcsName = asString(inlineVcsRef?.name)
                if (inlineVcsName) return inlineVcsName
              }
              if (parsed.implementationSpecRef?.name) {
                const impl = yield* kubernetes.getImplementationSpec(
                  kube,
                  parsed.implementationSpecRef.name,
                  parsed.namespace,
                )
                const implRef = asRecord(impl?.spec)
                const implVcsRef = asRecord(implRef?.vcsRef)
                const implVcsName = asString(implVcsRef?.name)
                if (implVcsName) return implVcsName
              }
              const agentVcsRef = asRecord(agentSpec.vcsRef)
              const agentVcsName = asString(agentVcsRef?.name)
              if (agentVcsName) return agentVcsName
              return null
            })

          if (shouldResolveVcs) {
            const vcsRefName = yield* resolveVcsRefName()
            if (!vcsRefName && parsed.vcsPolicy?.required) {
              return yield* Effect.fail(
                new AgentRunInvalidPayloadError({ message: 'vcsRef is required when vcsPolicy.required is true' }),
              )
            }
            if (vcsRefName) {
              const vcsProvider = yield* kubernetes.getVcsProvider(kube, vcsRefName, parsed.namespace)
              if (!vcsProvider) {
                if (parsed.vcsPolicy?.required) {
                  return yield* Effect.fail(
                    new AgentRunNotFoundError({
                      resource: 'version control provider',
                      name: vcsRefName,
                      namespace: parsed.namespace,
                    }),
                  )
                }
              } else {
                const auth = asRecord(readNested(vcsProvider, ['spec', 'auth'])) ?? {}
                const tokenSecret = asRecord(readNested(auth, ['token', 'secretRef']))
                const appSecret = asRecord(readNested(auth, ['app', 'privateKeySecretRef']))
                const sshSecret = asRecord(readNested(auth, ['ssh', 'privateKeySecretRef']))
                const tokenName = asString(tokenSecret?.name)
                const appName = asString(appSecret?.name)
                const sshName = asString(sshSecret?.name)
                if (tokenName) vcsSecrets.add(tokenName)
                if (appName) vcsSecrets.add(appName)
                if (sshName) vcsSecrets.add(sshName)
              }
            }
          }

          const requiredSecretSet = new Set(requiredSecrets)
          for (const name of vcsSecrets) {
            requiredSecretSet.add(name)
          }
          const policy = parsed.policy ?? {}
          const policyChecks = {
            budgetRef: asString(policy.budgetRef) ?? undefined,
            secretBindingRef: asString(policy.secretBindingRef) ?? undefined,
            requiredSecrets: Array.from(requiredSecretSet),
            subject: { kind: 'Agent', name: parsed.agentRef.name, namespace: parsed.namespace },
          }

          if (requiredSecretSet.size > 0 && !policyChecks.secretBindingRef) {
            return yield* Effect.fail(
              new AgentRunForbiddenError({ message: 'secretBindingRef is required when secrets are requested' }),
            )
          }

          const policyDecision = yield* policies.validate(parsed.namespace, policyChecks, kube).pipe(Effect.either)

          if (policyDecision._tag === 'Left') {
            if (!dryRun) {
              const auditEventId = yield* ids.next
              yield* stores
                .createAuditEvent(activeStore, {
                  entityType: 'PolicyDecision',
                  entityId: auditEventId,
                  eventType: 'policy.denied',
                  context: auditContext,
                  details: {
                    subject: policyChecks.subject,
                    checks: policyChecks,
                    reason: describeAgentRunSubmitError(policyDecision.left),
                  },
                })
                .pipe(Effect.catchAll(() => Effect.void))
            }
            return yield* Effect.fail(policyDecision.left)
          }

          if (!dryRun) {
            const auditEventId = yield* ids.next
            yield* stores
              .createAuditEvent(activeStore, {
                entityType: 'PolicyDecision',
                entityId: auditEventId,
                eventType: 'policy.allowed',
                context: auditContext,
                details: { subject: policyChecks.subject, checks: policyChecks },
              })
              .pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() => {
                    console.warn('[agents] failed to persist AgentRun policy.allowed audit event', error)
                  }),
                ),
              )
          }

          const admissionRepository = resolveRepositoryFromParams(parsed.parameters) || null
          const admissionNow = yield* runtimeConfig.now()
          const admission = yield* kubernetes.evaluateAdmissionLimits(
            kube,
            parsed.namespace,
            admissionRepository,
            submissionConfig,
            admissionNow,
            queueDepth.record,
          )
          if (!admission.ok) {
            return yield* Effect.fail(
              new AgentRunAdmissionRejectedError({
                message: admission.message,
                status: admission.status,
                details: admission.details,
              }),
            )
          }

          if (dryRun) {
            const resource = createAgentRunResource(parsed, deliveryId, runIdempotencyKey)
            const defaultRunnerImage = yield* runtimeConfig.resolveDefaultRunnerImage()
            const resolvedWorkloadImage = resolveWorkloadImage({
              workload: parsed.workload ?? null,
              provider,
              defaultRunnerImage,
            })
            return {
              status: 200,
              body: {
                ok: true,
                dryRun: true,
                idempotent: false,
                namespace: parsed.namespace,
                agentName: parsed.agentRef.name,
                providerName: providerName ?? null,
                idempotencyKey: runIdempotencyKey,
                resource,
                resolvedWorkloadImage: resolvedWorkloadImage.image,
                resolvedWorkloadImageSource: resolvedWorkloadImage.source,
                policy: policyChecks,
                admission: { ok: true },
              },
            }
          }

          let idempotencyReservation: IdempotencyReservationState | null = null

          if (submissionConfig.idempotencyEnabled) {
            let reservation = yield* stores.reserveIdempotencyKey(activeStore, {
              namespace: parsed.namespace,
              agentName: parsed.agentRef.name,
              idempotencyKey: runIdempotencyKey,
            })

            if (
              !reservation.created &&
              !reservation.record.agentRunName &&
              (yield* runtimeConfig.isIdempotencyReservationStale(reservation.record.createdAt, submissionConfig))
            ) {
              yield* stores
                .deleteIdempotencyKey(activeStore, {
                  namespace: parsed.namespace,
                  agentName: parsed.agentRef.name,
                  idempotencyKey: runIdempotencyKey,
                })
                .pipe(Effect.catchAll(() => Effect.void))
              reservation = yield* stores.reserveIdempotencyKey(activeStore, {
                namespace: parsed.namespace,
                agentName: parsed.agentRef.name,
                idempotencyKey: runIdempotencyKey,
              })
            }

            if (!reservation.created) {
              const scope = reservation.record
              if (scope.agentRunName) {
                const resource = yield* kubernetes.getAgentRun(
                  kube,
                  'get-idempotent-run',
                  scope.agentRunName,
                  parsed.namespace,
                )
                const phase = asString(readNested(resource, ['status', 'phase'])) ?? 'Pending'
                if (resource && !isTerminalPhase(phase)) {
                  return yield* Effect.fail(
                    new AgentRunConflictError({
                      message: 'AgentRun already exists for idempotency key',
                      details: {
                        namespace: parsed.namespace,
                        agentName: parsed.agentRef.name,
                        idempotencyKey: runIdempotencyKey,
                        existingAgentRunName: scope.agentRunName,
                        phase,
                      },
                    }),
                  )
                }
                return {
                  status: 200,
                  body: {
                    ok: true,
                    idempotent: true,
                    namespace: parsed.namespace,
                    agentName: parsed.agentRef.name,
                    idempotencyKey: runIdempotencyKey,
                    existingAgentRunName: scope.agentRunName,
                    resource,
                  },
                }
              }

              return yield* Effect.fail(
                new AgentRunConflictError({
                  message: 'AgentRun creation already in progress for idempotency key',
                  details: {
                    namespace: parsed.namespace,
                    agentName: parsed.agentRef.name,
                    idempotencyKey: runIdempotencyKey,
                  },
                }),
              )
            }

            idempotencyReservation = {
              created: reservation.created,
              agentRunName: reservation.record.agentRunName,
              idempotencyKey: runIdempotencyKey,
              agentName: parsed.agentRef.name,
              namespace: parsed.namespace,
            }
          }

          const resource = createAgentRunResource(parsed, deliveryId, runIdempotencyKey)
          const appliedResult = yield* kubernetes.applyAgentRun(kube, resource, parsed.namespace).pipe(Effect.either)
          if (appliedResult._tag === 'Left') {
            if (idempotencyReservation) {
              yield* stores
                .deleteIdempotencyKey(activeStore, {
                  namespace: idempotencyReservation.namespace,
                  agentName: idempotencyReservation.agentName,
                  idempotencyKey: idempotencyReservation.idempotencyKey,
                })
                .pipe(Effect.catchAll(() => Effect.void))
            }
            return yield* Effect.fail(appliedResult.left)
          }

          const applied = appliedResult.right
          const metadata = (applied.metadata ?? {}) as Record<string, unknown>
          const externalRunId = asString(metadata.name)
          const runtimeProvider = asString(readNested(applied, ['spec', 'runtime', 'type'])) ?? 'unknown'

          if (idempotencyReservation && externalRunId) {
            yield* stores.assignIdempotencyKey(activeStore, {
              namespace: idempotencyReservation.namespace,
              agentName: idempotencyReservation.agentName,
              idempotencyKey: idempotencyReservation.idempotencyKey,
              agentRunName: externalRunId,
              agentRunUid: asString(metadata.uid) ?? null,
            })
          }

          const statusPhase = asString(asRecord(applied.status)?.phase) ?? 'Pending'
          const record = yield* stores.createRun(activeStore, {
            agentName: parsed.agentRef.name,
            deliveryId,
            provider: runtimeProvider,
            status: statusPhase,
            externalRunId,
            payload: { request: payload, resource: applied, status: asRecord(applied.status) ?? {} },
          })
          yield* stores
            .createAuditEvent(activeStore, {
              entityType: 'AgentRun',
              entityId: record.id,
              eventType: 'agent_run.created',
              context: auditContext,
              details: {
                agent: parsed.agentRef.name,
                agentRunId: record.id,
                agentRunName: externalRunId,
                agentRunUid: asString(asRecord(applied.metadata)?.uid),
                provider: runtimeProvider,
              },
            })
            .pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  console.warn('[agents] failed to persist AgentRun created audit event', error)
                }),
              ),
            )
          return { status: 201, body: { ok: true, agentRun: record, resource: applied } }
        }),
      stores.close,
    )
  })
