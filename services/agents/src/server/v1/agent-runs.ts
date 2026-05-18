import { randomUUID } from 'node:crypto'

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
  getAgentRunsByAgent: (agentName: string) => Promise<unknown[]>
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

export const getAgentRunsHandler = async (request: Request, deps: Pick<AgentRunsApiDependencies, 'storeFactory'>) => {
  const url = new URL(request.url)
  const agentName = asString(url.searchParams.get('agentId')) ?? asString(url.searchParams.get('agentName'))
  if (!agentName) return errorResponse('agentId is required', 400)

  const store = deps.storeFactory()
  try {
    await store.ready
    const runs = await store.getAgentRunsByAgent(agentName)
    return okResponse({ ok: true, runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}

export const postAgentRunsHandler = async (request: Request, deps: AgentRunsApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.() ?? null
  if (leaderResponse) return leaderResponse

  const store = deps.storeFactory()
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseAgentRunPayload(payload)
    const runIdempotencyKey = parsed.idempotencyKey ?? deliveryId
    const repository = (deps.resolveRepositoryFromParameters ?? defaultResolveRepositoryFromParameters)(
      parsed.parameters,
    )
    const auditContext = (deps.resolveAuditContextFromRequest ?? defaultResolveAuditContextFromRequest)(request, {
      deliveryId,
      namespace: parsed.namespace,
      repository,
      source: 'v1.agent-runs',
    })

    await store.ready
    const existing = await store.getAgentRunByDeliveryId(deliveryId)
    if (existing) {
      const resourceNamespace =
        asString(readNested(existing.payload, ['resource', 'metadata', 'namespace'])) ??
        asString(readNested(existing.payload, ['request', 'namespace'])) ??
        parsed.namespace
      const kube = getKubeClient(deps)
      const resource = existing.externalRunId
        ? await kube.get(RESOURCE_MAP.AgentRun, existing.externalRunId, resourceNamespace)
        : null
      return okResponse({ ok: true, agentRun: existing, resource, idempotent: true })
    }

    if (isAgentRunIdempotencyEnabled()) {
      const scope = await store.getAgentRunIdempotencyKey({
        namespace: parsed.namespace,
        agentName: parsed.agentRef.name,
        idempotencyKey: runIdempotencyKey,
      })

      if (scope?.agentRunName) {
        const kube = getKubeClient(deps)
        const resource = await kube.get(RESOURCE_MAP.AgentRun, scope.agentRunName, parsed.namespace)
        const phase = asString(readNested(resource, ['status', 'phase'])) ?? 'Pending'

        if (resource && !isTerminalPhase(phase)) {
          return errorResponse('AgentRun already exists for idempotency key', 409, {
            namespace: parsed.namespace,
            agentName: parsed.agentRef.name,
            idempotencyKey: runIdempotencyKey,
            existingAgentRunName: scope.agentRunName,
            phase,
          })
        }

        return okResponse({
          ok: true,
          idempotent: true,
          namespace: parsed.namespace,
          agentName: parsed.agentRef.name,
          idempotencyKey: runIdempotencyKey,
          existingAgentRunName: scope.agentRunName,
          resource,
        })
      }
    }

    const kube = getKubeClient(deps)
    const agent = await kube.get(RESOURCE_MAP.Agent, parsed.agentRef.name, parsed.namespace)
    if (!agent) {
      return errorResponse(`agent ${parsed.agentRef.name} not found`, 404)
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
      return errorResponse(`service account ${effectiveServiceAccount} is not allowed`, 403)
    }

    const requiredSecrets = parsed.secrets ?? extractRequiredSecrets(agentSpec)
    const vcsSecrets = new Set<string>()
    const desiredVcsMode = normalizeVcsMode(parsed.vcsPolicy?.mode ?? null)
    const shouldResolveVcs = isVcsProvidersEnabled() && desiredVcsMode !== 'none'
    const resolveVcsRefName = async () => {
      if (parsed.vcsRef?.name) return parsed.vcsRef.name
      if (parsed.implementation) {
        const inline = asRecord(parsed.implementation)
        const inlineVcsRef = asRecord(inline?.vcsRef)
        const inlineVcsName = asString(inlineVcsRef?.name)
        if (inlineVcsName) return inlineVcsName
      }
      if (parsed.implementationSpecRef?.name) {
        const impl = await kube.get(
          RESOURCE_MAP.ImplementationSpec,
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
    }

    if (shouldResolveVcs) {
      const vcsRefName = await resolveVcsRefName()
      if (!vcsRefName && parsed.vcsPolicy?.required) {
        return errorResponse('vcsRef is required when vcsPolicy.required is true', 400)
      }
      if (vcsRefName) {
        const vcsProvider = await kube.get(RESOURCE_MAP.VersionControlProvider, vcsRefName, parsed.namespace)
        if (!vcsProvider) {
          if (parsed.vcsPolicy?.required) {
            return errorResponse(`version control provider ${vcsRefName} not found`, 404)
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
      return errorResponse('secretBindingRef is required when secrets are requested', 403)
    }

    try {
      await (deps.validatePolicies ?? validatePolicies)(parsed.namespace, policyChecks, kube)
      await store.createAuditEvent({
        entityType: 'PolicyDecision',
        entityId: randomUUID(),
        eventType: 'policy.allowed',
        context: auditContext,
        details: { subject: policyChecks.subject, checks: policyChecks },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await store.createAuditEvent({
          entityType: 'PolicyDecision',
          entityId: randomUUID(),
          eventType: 'policy.denied',
          context: auditContext,
          details: { subject: policyChecks.subject, checks: policyChecks, reason: message },
        })
      } catch {
        // ignore audit failures
      }
      return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 403)
    }

    const admissionRepository = resolveRepositoryFromParams(parsed.parameters) || null
    const admission = await evaluateAdmissionLimits(
      kube,
      parsed.namespace,
      admissionRepository,
      deps.recordAgentQueueDepth ?? (() => undefined),
    )
    if (!admission.ok) {
      return errorResponse(admission.message, admission.status, admission.details)
    }

    let idempotencyReservation: {
      created: boolean
      agentRunName: string | null
      idempotencyKey: string
      agentName: string
      namespace: string
    } | null = null

    if (isAgentRunIdempotencyEnabled()) {
      let reservation = await store.reserveAgentRunIdempotencyKey({
        namespace: parsed.namespace,
        agentName: parsed.agentRef.name,
        idempotencyKey: runIdempotencyKey,
      })

      if (
        !reservation.created &&
        !reservation.record.agentRunName &&
        isIdempotencyReservationStale(reservation.record.createdAt)
      ) {
        try {
          await store.deleteAgentRunIdempotencyKey({
            namespace: parsed.namespace,
            agentName: parsed.agentRef.name,
            idempotencyKey: runIdempotencyKey,
          })
        } catch {
          // ignore: if we fail to reclaim, treat as in-progress.
        }
        reservation = await store.reserveAgentRunIdempotencyKey({
          namespace: parsed.namespace,
          agentName: parsed.agentRef.name,
          idempotencyKey: runIdempotencyKey,
        })
      }

      if (!reservation.created) {
        const scope = reservation.record
        if (scope.agentRunName) {
          const resource = await kube.get(RESOURCE_MAP.AgentRun, scope.agentRunName, parsed.namespace)
          const phase = asString(readNested(resource, ['status', 'phase'])) ?? 'Pending'
          if (resource && !isTerminalPhase(phase)) {
            return errorResponse('AgentRun already exists for idempotency key', 409, {
              namespace: parsed.namespace,
              agentName: parsed.agentRef.name,
              idempotencyKey: runIdempotencyKey,
              existingAgentRunName: scope.agentRunName,
              phase,
            })
          }
          return okResponse({
            ok: true,
            idempotent: true,
            namespace: parsed.namespace,
            agentName: parsed.agentRef.name,
            idempotencyKey: runIdempotencyKey,
            existingAgentRunName: scope.agentRunName,
            resource,
          })
        }

        return errorResponse('AgentRun creation already in progress for idempotency key', 409, {
          namespace: parsed.namespace,
          agentName: parsed.agentRef.name,
          idempotencyKey: runIdempotencyKey,
        })
      }

      idempotencyReservation = {
        created: reservation.created,
        agentRunName: reservation.record.agentRunName,
        idempotencyKey: runIdempotencyKey,
        agentName: parsed.agentRef.name,
        namespace: parsed.namespace,
      }
    }

    const resource: Record<string, unknown> = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'AgentRun',
      metadata: {
        generateName: `${parsed.agentRef.name}-`,
        namespace: parsed.namespace,
        labels: {
          'jangar.proompteng.ai/delivery-id': deliveryId,
        },
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
    }

    let applied: Record<string, unknown>
    try {
      applied = await kube.apply(resource)
    } catch (error) {
      if (idempotencyReservation) {
        await store.deleteAgentRunIdempotencyKey({
          namespace: idempotencyReservation.namespace,
          agentName: idempotencyReservation.agentName,
          idempotencyKey: idempotencyReservation.idempotencyKey,
        })
      }
      throw error
    }
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const externalRunId = asString(metadata.name)
    const provider = asString(readNested(applied, ['spec', 'runtime', 'type'])) ?? 'unknown'

    if (idempotencyReservation && externalRunId) {
      await store.assignAgentRunIdempotencyKey({
        namespace: idempotencyReservation.namespace,
        agentName: idempotencyReservation.agentName,
        idempotencyKey: idempotencyReservation.idempotencyKey,
        agentRunName: externalRunId,
        agentRunUid: asString(metadata.uid) ?? null,
      })
    }

    const statusPhase = asString(asRecord(applied.status)?.phase) ?? 'Pending'
    const record = await store.createAgentRun({
      agentName: parsed.agentRef.name,
      deliveryId,
      provider,
      status: statusPhase,
      externalRunId,
      payload: { request: payload, resource: applied, status: asRecord(applied.status) ?? {} },
    })
    await store.createAuditEvent({
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
    })
    return okResponse({ ok: true, agentRun: record, resource: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
