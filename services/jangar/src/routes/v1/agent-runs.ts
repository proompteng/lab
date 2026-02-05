import { randomUUID } from 'node:crypto'

import { createFileRoute } from '@tanstack/react-router'
import {
  asRecord,
  asString,
  errorResponse,
  normalizeNamespace,
  okResponse,
  parseJsonBody,
  readNested,
  requireIdempotencyKey,
} from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import {
  extractAllowedServiceAccounts,
  extractRequiredSecrets,
  extractRuntimeServiceAccount,
  validatePolicies,
} from '~/server/primitives-policy'
import { createPrimitivesStore } from '~/server/primitives-store'
import { recordAgentQueueDepth } from '~/server/metrics'

export const Route = createFileRoute('/v1/agent-runs')({
  server: {
    handlers: {
      GET: async ({ request }) => getAgentRunsHandler(request),
      POST: async ({ request }) => postAgentRunsHandler(request),
    },
  },
})

type AgentRunPayload = {
  agentRef: { name: string }
  namespace: string
  implementationSpecRef?: { name: string }
  implementation?: Record<string, unknown>
  runtime: { type: string; config?: Record<string, unknown> }
  workflow?: { steps: WorkflowStepPayload[] }
  workload?: Record<string, unknown>
  memoryRef?: { name: string }
  vcsRef?: { name: string }
  vcsPolicy?: { required?: boolean; mode?: string }
  parameters?: Record<string, string>
  secrets?: string[]
  policy?: Record<string, unknown>
  ttlSecondsAfterFinished?: number
}

type WorkflowStepPayload = {
  name: string
  implementationSpecRef?: { name: string }
  implementation?: Record<string, unknown>
  parameters?: Record<string, string>
  workload?: Record<string, unknown>
  retries?: number
  retryBackoffSeconds?: number
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

const parseOptionalNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const normalizeVcsMode = (value?: string | null) => {
  const raw = value?.trim().toLowerCase()
  if (raw === 'read-only' || raw === 'read-write' || raw === 'none') return raw
  return 'read-write'
}

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

const isVcsProvidersEnabled = () => parseBooleanEnv(process.env.JANGAR_AGENTS_CONTROLLER_VCS_PROVIDERS_ENABLED, true)

const DEFAULT_CONCURRENCY = {
  perNamespace: 10,
  cluster: 100,
}
const DEFAULT_QUEUE_LIMITS = {
  perNamespace: 200,
  perRepo: 50,
  cluster: 1000,
}
const DEFAULT_RATE_LIMITS = {
  windowSeconds: 60,
  perNamespace: 120,
  perRepo: 30,
  cluster: 600,
}

const QUEUED_PHASES = new Set(['pending', 'queued', 'progressing', 'inprogress'])
const RUNNING_PHASE = 'running'

type RateBucket = { count: number; resetAt: number }

const admissionRateState = {
  cluster: { count: 0, resetAt: 0 } as RateBucket,
  perNamespace: new Map<string, RateBucket>(),
  perRepo: new Map<string, RateBucket>(),
}

const parseNumberEnv = (value: string | undefined, fallback: number, min = 0) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

const parseAdmissionNamespaces = (namespace: string) => {
  const raw = process.env.JANGAR_AGENTS_CONTROLLER_NAMESPACES
  if (!raw) return { namespaces: [namespace], includeCluster: true }
  const list = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (list.length === 0) return { namespaces: [namespace], includeCluster: true }
  if (list.includes('*')) {
    return { namespaces: [namespace], includeCluster: false }
  }
  return { namespaces: list, includeCluster: true }
}

const parseAdmissionLimits = () => ({
  concurrency: {
    perNamespace: parseNumberEnv(
      process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE,
      DEFAULT_CONCURRENCY.perNamespace,
      1,
    ),
    cluster: parseNumberEnv(
      process.env.JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER,
      DEFAULT_CONCURRENCY.cluster,
      1,
    ),
  },
  queue: {
    perNamespace: parseNumberEnv(
      process.env.JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE,
      DEFAULT_QUEUE_LIMITS.perNamespace,
    ),
    perRepo: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_QUEUE_REPO, DEFAULT_QUEUE_LIMITS.perRepo),
    cluster: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER, DEFAULT_QUEUE_LIMITS.cluster),
  },
  rate: {
    windowSeconds: parseNumberEnv(
      process.env.JANGAR_AGENTS_CONTROLLER_RATE_WINDOW_SECONDS,
      DEFAULT_RATE_LIMITS.windowSeconds,
      1,
    ),
    perNamespace: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE, DEFAULT_RATE_LIMITS.perNamespace),
    perRepo: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_RATE_REPO, DEFAULT_RATE_LIMITS.perRepo),
    cluster: parseNumberEnv(process.env.JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER, DEFAULT_RATE_LIMITS.cluster),
  },
})

const normalizeRepository = (value: string) => value.trim().toLowerCase()

const resolveRepositoryFromParams = (params: Record<string, string> | undefined) => {
  if (!params) return ''
  const candidates = [params.repository, params.repo, params.issueRepository]
  for (const candidate of candidates) {
    if (candidate && candidate.trim().length > 0) return candidate.trim()
  }
  return ''
}

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

  const implementationSpecRef = asRecord(payload.implementationSpecRef)
  const implementationSpecName = asString(implementationSpecRef?.name)

  const inline = asRecord(payload.implementation)
  const runtime = asRecord(payload.runtime)
  if (!runtime) throw new Error('runtime is required')
  const runtimeType = asString(runtime.type)
  if (!runtimeType) throw new Error('runtime.type is required')

  const parameters = normalizeParameterMap(asRecord(payload.parameters))
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
    implementationSpecRef: implementationSpecName ? { name: implementationSpecName } : undefined,
    implementation: inline ?? undefined,
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
  kube: ReturnType<typeof createKubernetesClient>,
  namespace: string,
  repository: string | null,
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
  let runningRepo = 0
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
          if (isRunning) runningRepo += 1
          if (isQueued) queuedRepo += 1
        }
      }
    }
  }

  recordAgentQueueDepth(queuedNamespace, { scope: 'namespace', namespace })
  if (includeCluster) {
    recordAgentQueueDepth(queuedCluster, { scope: 'cluster' })
  }
  if (normalizedRepo) {
    recordAgentQueueDepth(queuedRepo, { scope: 'repo', repository: normalizedRepo, namespace })
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

export const getAgentRunsHandler = async (
  request: Request,
  deps: { storeFactory?: typeof createPrimitivesStore } = {},
) => {
  const url = new URL(request.url)
  const agentName = asString(url.searchParams.get('agentId')) ?? asString(url.searchParams.get('agentName'))
  if (!agentName) return errorResponse('agentId is required', 400)

  const store = (deps.storeFactory ?? createPrimitivesStore)()
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

export const postAgentRunsHandler = async (
  request: Request,
  deps: {
    storeFactory?: typeof createPrimitivesStore
    kubeClient?: ReturnType<typeof createKubernetesClient>
  } = {},
) => {
  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseAgentRunPayload(payload)

    await store.ready
    const existing = await store.getAgentRunByDeliveryId(deliveryId)
    if (existing) {
      const resourceNamespace =
        asString(readNested(existing.payload, ['resource', 'metadata', 'namespace'])) ??
        asString(readNested(existing.payload, ['request', 'namespace'])) ??
        parsed.namespace
      const kube = deps.kubeClient ?? createKubernetesClient()
      const resource = existing.externalRunId
        ? await kube.get(RESOURCE_MAP.AgentRun, existing.externalRunId, resourceNamespace)
        : null
      return okResponse({ ok: true, agentRun: existing, resource, idempotent: true })
    }

    const kube = deps.kubeClient ?? createKubernetesClient()
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
      await validatePolicies(parsed.namespace, policyChecks, kube)
      await store.createAuditEvent({
        entityType: 'PolicyDecision',
        entityId: randomUUID(),
        eventType: 'policy.allowed',
        payload: { deliveryId, subject: policyChecks.subject, checks: policyChecks },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await store.createAuditEvent({
          entityType: 'PolicyDecision',
          entityId: randomUUID(),
          eventType: 'policy.denied',
          payload: { deliveryId, subject: policyChecks.subject, checks: policyChecks, reason: message },
        })
      } catch {
        // ignore audit failures
      }
      return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 403)
    }

    const repository = resolveRepositoryFromParams(parsed.parameters) || null
    const admission = await evaluateAdmissionLimits(kube, parsed.namespace, repository)
    if (!admission.ok) {
      return errorResponse(admission.message, admission.status, admission.details)
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
        idempotencyKey: deliveryId,
        ttlSecondsAfterFinished: parsed.ttlSecondsAfterFinished ?? undefined,
      },
    }

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const externalRunId = asString(metadata.name)
    const provider = asString(readNested(applied, ['spec', 'runtime', 'type'])) ?? 'unknown'

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
      payload: { deliveryId, agent: parsed.agentRef.name, namespace: parsed.namespace },
    })
    return okResponse({ ok: true, agentRun: record, resource: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
