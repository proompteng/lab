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
    const shouldResolveVcs = desiredVcsMode !== 'none'
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
