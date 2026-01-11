import { randomUUID } from 'node:crypto'

import { createFileRoute } from '@tanstack/react-router'
import {
  asRecord,
  asString,
  errorResponse,
  normalizeNamespace,
  okResponse,
  parseJsonBody,
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
  parameters?: Record<string, string>
  runtimeOverrides?: Record<string, unknown>
  retryPolicy?: Record<string, unknown>
  timeoutSeconds?: number
  policy?: Record<string, unknown>
  secrets?: string[]
}

const normalizeStringMap = (value: Record<string, unknown> | null): Record<string, string> | undefined => {
  if (!value) return undefined
  const entries = Object.entries(value)
  const output: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (raw == null) continue
    output[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return output
}

const parseAgentRunPayload = (payload: Record<string, unknown>): AgentRunPayload => {
  const agentRef = asRecord(payload.agentRef)
  const name = asString(agentRef?.name)
  if (!name) throw new Error('agentRef.name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const parameters = normalizeStringMap(asRecord(payload.parameters))
  const runtimeOverrides = asRecord(payload.runtimeOverrides) ?? undefined
  const retryPolicy = asRecord(payload.retryPolicy) ?? undefined
  const timeoutSeconds = typeof payload.timeoutSeconds === 'number' ? payload.timeoutSeconds : undefined
  const policy = asRecord(payload.policy) ?? undefined
  const secrets = Array.isArray(payload.secrets)
    ? payload.secrets.filter((item) => typeof item === 'string')
    : undefined
  return { agentRef: { name }, namespace, parameters, runtimeOverrides, retryPolicy, timeoutSeconds, policy, secrets }
}

const extractAgentRuntimeType = (agent: Record<string, unknown>) => {
  const spec = (agent.spec ?? {}) as Record<string, unknown>
  const runtime = (spec.runtime ?? {}) as Record<string, unknown>
  return asString(runtime.type) ?? 'argo'
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

    const kube = deps.kubeClient ?? createKubernetesClient()
    const agent = await kube.get(RESOURCE_MAP.Agent, parsed.agentRef.name, parsed.namespace)
    if (!agent) {
      return errorResponse(`agent ${parsed.agentRef.name} not found`, 404)
    }

    const agentSpec = (agent.spec ?? {}) as Record<string, unknown>
    const allowedServiceAccounts = extractAllowedServiceAccounts(agentSpec)
    const runtimeServiceAccount = asString(
      (parsed.runtimeOverrides?.argo as Record<string, unknown> | undefined)?.serviceAccount,
    )
    const effectiveServiceAccount = runtimeServiceAccount ?? extractRuntimeServiceAccount(agentSpec)

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
      await store.ready
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
        parameters: parsed.parameters ?? {},
        deliveryId,
        runtimeOverrides: parsed.runtimeOverrides ?? undefined,
        retryPolicy: parsed.retryPolicy ?? undefined,
        timeoutSeconds: parsed.timeoutSeconds ?? undefined,
      },
    }

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const externalRunId = asString(metadata.name)
    const provider = extractAgentRuntimeType(agent)

    const record = await store.createAgentRun({
      agentName: parsed.agentRef.name,
      deliveryId,
      provider,
      status: 'Pending',
      externalRunId,
      payload: { request: payload, resource: applied },
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
