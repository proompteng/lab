import { randomUUID } from 'node:crypto'

import { Context, Data, Effect, Layer } from 'effect'

import { resolveAgentRunAdmissionConfig } from '../agents-controller/controller-config'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient, RESOURCE_MAP } from '../kube-types'
import { asRecord, asString, normalizeNamespace, readNested } from '../primitives'
import {
  extractAllowedServiceAccounts,
  extractRequiredSecrets,
  extractRuntimeServiceAccount,
  type PolicyChecks,
  validatePolicies,
} from '../primitives-policy'

import { type AgentRunPayload, type WorkflowStepPayload, parseGoal, parseOptionalNumber } from './agent-runs-payload'
import { buildDeliveryIdLabels } from './delivery-labels'

export type AgentRunIdempotencyRecord = {
  namespace: string
  agentName: string
  idempotencyKey: string
  agentRunName: string | null
  agentRunUid: string | null
  createdAt: Date | string
}

export type AgentRunIdempotencyReservation = {
  record: AgentRunIdempotencyRecord
  created: boolean
}

export type AgentRunRecord = {
  id: string
  agentName: string
  deliveryId: string
  provider: string
  status: string
  externalRunId: string | null
  payload: Record<string, unknown>
  createdAt?: unknown
  updatedAt?: unknown
}

export type AgentRunsApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  listAgentRuns: (input?: {
    agentName?: string | null
    statuses?: string[] | null
    limit?: number | null
  }) => Promise<unknown[]>
  getAgentRunByDeliveryId: (deliveryId: string) => Promise<AgentRunRecord | null>
  getAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<AgentRunIdempotencyRecord | null>
  reserveAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<AgentRunIdempotencyReservation>
  deleteAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
  }) => Promise<unknown>
  assignAgentRunIdempotencyKey: (input: {
    namespace: string
    agentName: string
    idempotencyKey: string
    agentRunName: string
    agentRunUid: string | null
  }) => Promise<unknown>
  createAgentRun: (input: {
    agentName: string
    deliveryId: string
    provider: string
    status: string
    externalRunId: string | null
    payload: Record<string, unknown>
  }) => Promise<AgentRunRecord>
  createAuditEvent: (input: {
    entityType: string
    entityId: string
    eventType: string
    context?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => Promise<unknown>
}

export type AgentRunsApiDependencies = {
  storeFactory: () => AgentRunsApiStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  requireLeaderForMutation?: () => Response | null
  recordAgentQueueDepth?: (
    depth: number,
    labels: { scope: 'namespace' | 'cluster' | 'repo'; namespace?: string; repository?: string },
  ) => void
  resolveAuditContextFromRequest?: (
    request: Request,
    defaults: { deliveryId: string; namespace: string; repository?: string; source: string },
  ) => Record<string, unknown>
  resolveRepositoryFromParameters?: (params: Record<string, string> | undefined) => string | undefined
  validatePolicies?: (namespace: string, checks: PolicyChecks, kube: KubernetesClient) => Promise<void>
}

type AgentRunQueueDepthRecorder = NonNullable<AgentRunsApiDependencies['recordAgentQueueDepth']>
type AgentRunAuditContextResolver = NonNullable<AgentRunsApiDependencies['resolveAuditContextFromRequest']>
type AgentRunRepositoryResolver = NonNullable<AgentRunsApiDependencies['resolveRepositoryFromParameters']>

type AgentRunStoreServiceDefinition = {
  readonly open: Effect.Effect<AgentRunsApiStore, AgentRunStorageError>
}

type AgentRunKubernetesServiceDefinition = {
  readonly client: (namespace: string) => Effect.Effect<KubernetesClient, AgentRunKubeError>
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

export class AgentRunStoreService extends Context.Tag('agents/AgentRunStoreService')<
  AgentRunStoreService,
  AgentRunStoreServiceDefinition
>() {}

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

const isVcsProvidersEnabled = () => resolveAgentRunAdmissionConfig('agents', process.env).vcsProvidersEnabled
const isAgentRunIdempotencyEnabled = () => resolveAgentRunAdmissionConfig('agents', process.env).idempotencyEnabled

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

const isIdempotencyReservationStale = (createdAt: unknown) => {
  const ttlSeconds = resolveAgentRunAdmissionConfig('agents', process.env).idempotencyReservationTtlSeconds
  if (ttlSeconds <= 0) return false
  const createdAtMs = parseTimestampMs(createdAt)
  if (createdAtMs == null) return false
  return Date.now() - createdAtMs >= ttlSeconds * 1000
}

const parseAdmissionNamespaces = (namespace: string) =>
  resolveAgentRunAdmissionConfig(namespace, process.env).admissionNamespaces

const parseAdmissionLimits = () => {
  const config = resolveAgentRunAdmissionConfig('agents', process.env)
  return {
    concurrency: config.concurrency,
    queue: config.queue,
    rate: config.rate,
  }
}

const parseListLimit = (value: string | null) => {
  if (!value) return 50
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 50
  return Math.min(parsed, 500)
}

const parseStatusFilter = (value: string | null) => {
  if (!value) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
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
  limits: ReturnType<typeof parseAdmissionLimits>['rate'],
): AdmissionDecision => {
  const windowMs = limits.windowSeconds * 1000
  const now = Date.now()

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
  recordQueueDepth: NonNullable<AgentRunsApiDependencies['recordAgentQueueDepth']>,
): Promise<AdmissionDecision> => {
  const limits = parseAdmissionLimits()
  const rateDecision = checkAdmissionRateLimits(namespace, repository, limits.rate)
  if (!rateDecision.ok) return rateDecision

  const { namespaces, includeCluster } = parseAdmissionNamespaces(namespace)
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

  if (limits.concurrency.perNamespace > 0 && runningNamespace >= limits.concurrency.perNamespace) {
    return {
      ok: false,
      status: 429,
      message: `Namespace ${namespace} reached concurrency limit`,
      details: { scope: 'namespace', limit: limits.concurrency.perNamespace, running: runningNamespace },
    }
  }

  if (includeCluster && limits.concurrency.cluster > 0 && runningCluster >= limits.concurrency.cluster) {
    return {
      ok: false,
      status: 429,
      message: 'Cluster concurrency limit reached',
      details: { scope: 'cluster', limit: limits.concurrency.cluster, running: runningCluster },
    }
  }

  if (limits.queue.perNamespace > 0 && queuedNamespace >= limits.queue.perNamespace) {
    return {
      ok: false,
      status: 429,
      message: `Namespace ${namespace} reached queue limit`,
      details: { scope: 'namespace', limit: limits.queue.perNamespace, queued: queuedNamespace },
    }
  }

  if (includeCluster && limits.queue.cluster > 0 && queuedCluster >= limits.queue.cluster) {
    return {
      ok: false,
      status: 429,
      message: 'Cluster queue limit reached',
      details: { scope: 'cluster', limit: limits.queue.cluster, queued: queuedCluster },
    }
  }

  if (normalizedRepo && limits.queue.perRepo > 0 && queuedRepo >= limits.queue.perRepo) {
    return {
      ok: false,
      status: 429,
      message: `Repository ${repository} reached queue limit`,
      details: { scope: 'repo', limit: limits.queue.perRepo, queued: queuedRepo, repository },
    }
  }

  return { ok: true }
}

type AgentRunStorageOperation =
  | 'open-store'
  | 'store-ready'
  | 'list-runs'
  | 'read-delivery-id'
  | 'read-idempotency-key'
  | 'reserve-idempotency-key'
  | 'delete-idempotency-key'
  | 'assign-idempotency-key'
  | 'create-agent-run'
  | 'create-audit-event'

type AgentRunKubeOperation =
  | 'create-client'
  | 'get-existing-run'
  | 'get-idempotent-run'
  | 'get-agent'
  | 'get-implementation-spec'
  | 'get-vcs-provider'
  | 'evaluate-admission-limits'
  | 'apply-agent-run'

export class AgentRunInvalidPayloadError extends Data.TaggedError('AgentRunInvalidPayloadError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class AgentRunStorageError extends Data.TaggedError('AgentRunStorageError')<{
  readonly operation: AgentRunStorageOperation
  readonly cause: unknown
}> {}

export class AgentRunKubeError extends Data.TaggedError('AgentRunKubeError')<{
  readonly operation: AgentRunKubeOperation
  readonly resource: string
  readonly namespace: string
  readonly cause: unknown
}> {}

export class AgentRunNotFoundError extends Data.TaggedError('AgentRunNotFoundError')<{
  readonly resource: string
  readonly name: string
  readonly namespace: string
}> {}

export class AgentRunPolicyDeniedError extends Data.TaggedError('AgentRunPolicyDeniedError')<{
  readonly subject: { kind: string; name: string; namespace?: string }
  readonly cause: unknown
}> {}

export class AgentRunAdmissionRejectedError extends Data.TaggedError('AgentRunAdmissionRejectedError')<{
  readonly message: string
  readonly status: number
  readonly details?: Record<string, unknown>
}> {}

export class AgentRunConflictError extends Data.TaggedError('AgentRunConflictError')<{
  readonly message: string
  readonly details?: Record<string, unknown>
}> {}

export class AgentRunForbiddenError extends Data.TaggedError('AgentRunForbiddenError')<{
  readonly message: string
}> {}

export type AgentRunSubmitError =
  | AgentRunInvalidPayloadError
  | AgentRunStorageError
  | AgentRunKubeError
  | AgentRunNotFoundError
  | AgentRunPolicyDeniedError
  | AgentRunAdmissionRejectedError
  | AgentRunConflictError
  | AgentRunForbiddenError

type AgentRunSubmitSuccess = {
  status: number
  body: Record<string, unknown>
}

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const describeAgentRunSubmitError = (error: unknown) => {
  if (error instanceof AgentRunInvalidPayloadError) return error.message
  if (error instanceof AgentRunNotFoundError) {
    return `${error.resource} ${error.name} not found in namespace ${error.namespace}`
  }
  if (error instanceof AgentRunForbiddenError) return error.message
  if (error instanceof AgentRunConflictError) return error.message
  if (error instanceof AgentRunAdmissionRejectedError) return error.message
  if (error instanceof AgentRunPolicyDeniedError) {
    return `policy denied for ${error.subject.kind} ${error.subject.namespace}/${error.subject.name}: ${toErrorMessage(
      error.cause,
    )}`
  }
  if (error instanceof AgentRunStorageError) {
    return `agent run storage ${error.operation} failed: ${toErrorMessage(error.cause)}`
  }
  if (error instanceof AgentRunKubeError) {
    return `kubernetes ${error.operation} failed for ${error.resource} in namespace ${error.namespace}: ${toErrorMessage(
      error.cause,
    )}`
  }
  return toErrorMessage(error)
}

const agentRunSubmitStatus = (error: unknown) => {
  if (error instanceof AgentRunInvalidPayloadError) return 400
  if (error instanceof AgentRunNotFoundError) return 404
  if (error instanceof AgentRunPolicyDeniedError || error instanceof AgentRunForbiddenError) return 403
  if (error instanceof AgentRunConflictError) return 409
  if (error instanceof AgentRunAdmissionRejectedError) return error.status
  if (error instanceof AgentRunKubeError) return 502
  if (error instanceof AgentRunStorageError) return 503
  return 500
}

const agentRunSubmitDetails = (error: unknown) => {
  if (error instanceof AgentRunConflictError || error instanceof AgentRunAdmissionRejectedError) {
    return error.details
  }
  return undefined
}

const storeEffect = <A>(
  operation: AgentRunStorageOperation,
  run: () => Promise<A>,
): Effect.Effect<A, AgentRunStorageError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new AgentRunStorageError({ operation, cause }),
  })

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

const closeStoreEffect = (store: AgentRunsApiStore) =>
  Effect.promise(() => store.close()).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        console.warn('[agents] failed to close AgentRun API store', error)
      }),
    ),
  )

export const makeAgentRunSubmitLayer = (deps: AgentRunsApiDependencies) =>
  Layer.mergeAll(
    Layer.succeed(AgentRunStoreService, {
      open: Effect.try({
        try: () => deps.storeFactory(),
        catch: (cause) => new AgentRunStorageError({ operation: 'open-store', cause }),
      }),
    }),
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
  )

type IdempotencyReservationState = {
  created: boolean
  agentRunName: string | null
  idempotencyKey: string
  agentName: string
  namespace: string
}

const createAgentRunResource = (
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
      ...(parsed.metadata?.labels ?? {}),
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

export const getAgentRunsHandler = async (request: Request, deps: Pick<AgentRunsApiDependencies, 'storeFactory'>) => {
  const url = new URL(request.url)
  const agentName = asString(url.searchParams.get('agentId')) ?? asString(url.searchParams.get('agentName'))
  const statuses = parseStatusFilter(url.searchParams.get('status'))
  const limit = parseListLimit(url.searchParams.get('limit'))
  if (!agentName && statuses.length === 0) return errorResponse('agentId or status is required', 400)

  let store: AgentRunsApiStore | null = null
  try {
    store = deps.storeFactory()
    const activeStore = store
    await store.ready
    const runs = await Effect.runPromise(
      storeEffect('list-runs', () => activeStore.listAgentRuns({ agentName, statuses, limit })),
    )
    return okResponse({ ok: true, runs })
  } catch (error) {
    if (error instanceof AgentRunStorageError) {
      return errorResponse(describeAgentRunSubmitError(error), agentRunSubmitStatus(error))
    }
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store?.close()
  }
}

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

    const store = yield* stores.open

    return yield* Effect.acquireUseRelease(
      Effect.succeed(store),
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

          yield* storeEffect('store-ready', () => Promise.resolve(activeStore.ready).then(() => undefined))
          const existing = yield* storeEffect('read-delivery-id', () => activeStore.getAgentRunByDeliveryId(deliveryId))
          const kube = yield* kubernetes.client(parsed.namespace)

          if (existing) {
            const resourceNamespace =
              asString(readNested(existing.payload, ['resource', 'metadata', 'namespace'])) ??
              asString(readNested(existing.payload, ['request', 'namespace'])) ??
              parsed.namespace
            const resource = existing.externalRunId
              ? yield* kubeEffect('get-existing-run', RESOURCE_MAP.AgentRun, resourceNamespace, () =>
                  kube.get(RESOURCE_MAP.AgentRun, existing.externalRunId!, resourceNamespace),
                )
              : null
            return { status: 200, body: { ok: true, agentRun: existing, resource, idempotent: true } }
          }

          if (isAgentRunIdempotencyEnabled()) {
            const scope = yield* storeEffect('read-idempotency-key', () =>
              activeStore.getAgentRunIdempotencyKey({
                namespace: parsed.namespace,
                agentName: parsed.agentRef.name,
                idempotencyKey: runIdempotencyKey,
              }),
            )

            if (scope?.agentRunName) {
              const resource = yield* kubeEffect('get-idempotent-run', RESOURCE_MAP.AgentRun, parsed.namespace, () =>
                kube.get(RESOURCE_MAP.AgentRun, scope.agentRunName!, parsed.namespace),
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

          const agent = yield* kubeEffect('get-agent', RESOURCE_MAP.Agent, parsed.namespace, () =>
            kube.get(RESOURCE_MAP.Agent, parsed.agentRef.name, parsed.namespace),
          )
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
          const allowedServiceAccounts = extractAllowedServiceAccounts(agentSpec)
          const runtimeServiceAccount = extractRuntimeServiceAccount({ runtime: parsed.runtime })
          const effectiveServiceAccount = runtimeServiceAccount

          if (
            effectiveServiceAccount &&
            allowedServiceAccounts.length > 0 &&
            !allowedServiceAccounts.includes(effectiveServiceAccount)
          ) {
            return yield* Effect.fail(
              new AgentRunForbiddenError({ message: `service account ${effectiveServiceAccount} is not allowed` }),
            )
          }

          const requiredSecrets = parsed.secrets ?? extractRequiredSecrets(agentSpec)
          const vcsSecrets = new Set<string>()
          const desiredVcsMode = normalizeVcsMode(parsed.vcsPolicy?.mode ?? null)
          const shouldResolveVcs = isVcsProvidersEnabled() && desiredVcsMode !== 'none'
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
                const impl = yield* kubeEffect(
                  'get-implementation-spec',
                  RESOURCE_MAP.ImplementationSpec,
                  parsed.namespace,
                  () => kube.get(RESOURCE_MAP.ImplementationSpec, parsed.implementationSpecRef!.name, parsed.namespace),
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
              const vcsProvider = yield* kubeEffect(
                'get-vcs-provider',
                RESOURCE_MAP.VersionControlProvider,
                parsed.namespace,
                () => kube.get(RESOURCE_MAP.VersionControlProvider, vcsRefName, parsed.namespace),
              )
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
            yield* storeEffect('create-audit-event', () =>
              activeStore.createAuditEvent({
                entityType: 'PolicyDecision',
                entityId: randomUUID(),
                eventType: 'policy.denied',
                context: auditContext,
                details: {
                  subject: policyChecks.subject,
                  checks: policyChecks,
                  reason: describeAgentRunSubmitError(policyDecision.left),
                },
              }),
            ).pipe(Effect.catchAll(() => Effect.void))
            return yield* Effect.fail(policyDecision.left)
          }

          yield* storeEffect('create-audit-event', () =>
            activeStore.createAuditEvent({
              entityType: 'PolicyDecision',
              entityId: randomUUID(),
              eventType: 'policy.allowed',
              context: auditContext,
              details: { subject: policyChecks.subject, checks: policyChecks },
            }),
          )

          const admissionRepository = resolveRepositoryFromParams(parsed.parameters) || null
          const admission = yield* kubeEffect(
            'evaluate-admission-limits',
            RESOURCE_MAP.AgentRun,
            parsed.namespace,
            () => evaluateAdmissionLimits(kube, parsed.namespace, admissionRepository, queueDepth.record),
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

          let idempotencyReservation: IdempotencyReservationState | null = null

          if (isAgentRunIdempotencyEnabled()) {
            let reservation = yield* storeEffect('reserve-idempotency-key', () =>
              activeStore.reserveAgentRunIdempotencyKey({
                namespace: parsed.namespace,
                agentName: parsed.agentRef.name,
                idempotencyKey: runIdempotencyKey,
              }),
            )

            if (
              !reservation.created &&
              !reservation.record.agentRunName &&
              isIdempotencyReservationStale(reservation.record.createdAt)
            ) {
              yield* storeEffect('delete-idempotency-key', () =>
                activeStore.deleteAgentRunIdempotencyKey({
                  namespace: parsed.namespace,
                  agentName: parsed.agentRef.name,
                  idempotencyKey: runIdempotencyKey,
                }),
              ).pipe(Effect.catchAll(() => Effect.void))
              reservation = yield* storeEffect('reserve-idempotency-key', () =>
                activeStore.reserveAgentRunIdempotencyKey({
                  namespace: parsed.namespace,
                  agentName: parsed.agentRef.name,
                  idempotencyKey: runIdempotencyKey,
                }),
              )
            }

            if (!reservation.created) {
              const scope = reservation.record
              if (scope.agentRunName) {
                const resource = yield* kubeEffect('get-idempotent-run', RESOURCE_MAP.AgentRun, parsed.namespace, () =>
                  kube.get(RESOURCE_MAP.AgentRun, scope.agentRunName!, parsed.namespace),
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
          const appliedResult = yield* kubeEffect('apply-agent-run', RESOURCE_MAP.AgentRun, parsed.namespace, () =>
            kube.apply(resource),
          ).pipe(Effect.either)
          if (appliedResult._tag === 'Left') {
            if (idempotencyReservation) {
              yield* storeEffect('delete-idempotency-key', () =>
                activeStore.deleteAgentRunIdempotencyKey({
                  namespace: idempotencyReservation.namespace,
                  agentName: idempotencyReservation.agentName,
                  idempotencyKey: idempotencyReservation.idempotencyKey,
                }),
              ).pipe(Effect.catchAll(() => Effect.void))
            }
            return yield* Effect.fail(appliedResult.left)
          }

          const applied = appliedResult.right
          const metadata = (applied.metadata ?? {}) as Record<string, unknown>
          const externalRunId = asString(metadata.name)
          const provider = asString(readNested(applied, ['spec', 'runtime', 'type'])) ?? 'unknown'

          if (idempotencyReservation && externalRunId) {
            yield* storeEffect('assign-idempotency-key', () =>
              activeStore.assignAgentRunIdempotencyKey({
                namespace: idempotencyReservation.namespace,
                agentName: idempotencyReservation.agentName,
                idempotencyKey: idempotencyReservation.idempotencyKey,
                agentRunName: externalRunId,
                agentRunUid: asString(metadata.uid) ?? null,
              }),
            )
          }

          const statusPhase = asString(asRecord(applied.status)?.phase) ?? 'Pending'
          const record = yield* storeEffect('create-agent-run', () =>
            activeStore.createAgentRun({
              agentName: parsed.agentRef.name,
              deliveryId,
              provider,
              status: statusPhase,
              externalRunId,
              payload: { request: payload, resource: applied, status: asRecord(applied.status) ?? {} },
            }),
          )
          yield* storeEffect('create-audit-event', () =>
            activeStore.createAuditEvent({
              entityType: 'AgentRun',
              entityId: record.id,
              eventType: 'agent_run.created',
              context: auditContext,
              details: {
                agent: parsed.agentRef.name,
                agentRunId: record.id,
                agentRunName: externalRunId,
                agentRunUid: asString(asRecord(applied.metadata)?.uid),
                provider,
              },
            }),
          )
          return { status: 201, body: { ok: true, agentRun: record, resource: applied } }
        }),
      closeStoreEffect,
    )
  })

export const postAgentRunsHandler = async (request: Request, deps: AgentRunsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.() ?? null
  if (leaderResponse) return leaderResponse

  const result = await Effect.runPromise(submitAgentRunEffect(request, deps).pipe(Effect.either))
  if (result._tag === 'Right') {
    return okResponse(result.right.body, result.right.status)
  }
  return errorResponse(
    describeAgentRunSubmitError(result.left),
    agentRunSubmitStatus(result.left),
    agentRunSubmitDetails(result.left),
  )
}
