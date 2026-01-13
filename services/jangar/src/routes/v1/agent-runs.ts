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
  workload?: Record<string, unknown>
  memoryRef?: { name: string }
  parameters?: Record<string, unknown>
  secrets?: string[]
  policy?: Record<string, unknown>
}

const normalizeParameterMap = (value: Record<string, unknown> | null): Record<string, unknown> | undefined => {
  if (!value) return undefined
  const entries = Object.entries(value)
  const output: Record<string, unknown> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    output[key] = raw
  }
  return output
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

  if (!implementationSpecName && !inline) {
    throw new Error('implementationSpecRef or implementation is required')
  }

  return {
    agentRef: { name },
    namespace,
    implementationSpecRef: implementationSpecName ? { name: implementationSpecName } : undefined,
    implementation: inline ?? undefined,
    runtime: { type: runtimeType, config: asRecord(runtime.config) ?? undefined },
    workload,
    memoryRef: memoryRefName ? { name: memoryRefName } : undefined,
    parameters,
    secrets,
    policy,
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
    const policy = parsed.policy ?? {}
    const policyChecks = {
      budgetRef: asString(policy.budgetRef) ?? undefined,
      secretBindingRef: asString(policy.secretBindingRef) ?? undefined,
      requiredSecrets,
      subject: { kind: 'Agent', name: parsed.agentRef.name, namespace: parsed.namespace },
    }

    if (requiredSecrets.length > 0 && !policyChecks.secretBindingRef) {
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
        workload: parsed.workload ?? undefined,
        parameters: parsed.parameters ?? {},
        secrets: parsed.secrets ?? undefined,
        memoryRef: parsed.memoryRef ?? undefined,
        idempotencyKey: deliveryId,
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
