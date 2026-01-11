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
import { createKubernetesClient } from '~/server/primitives-kube'
import {
  extractAllowedServiceAccounts,
  extractRequiredSecrets,
  extractRuntimeServiceAccount,
  validatePolicies,
} from '~/server/primitives-policy'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/agents')({
  server: {
    handlers: {
      POST: async ({ request }) => postAgentsHandler(request),
    },
  },
})

type AgentPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
  policy?: Record<string, unknown>
}

const parseAgentPayload = (payload: Record<string, unknown>): AgentPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  const policy = asRecord(payload.policy) ?? undefined
  return { name, namespace, spec, policy }
}

export const postAgentsHandler = async (
  request: Request,
  deps: { storeFactory?: typeof createPrimitivesStore; kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseAgentPayload(payload)
    const runtimeServiceAccount = extractRuntimeServiceAccount(parsed.spec)
    const allowedServiceAccounts = extractAllowedServiceAccounts(parsed.spec)
    if (
      runtimeServiceAccount &&
      allowedServiceAccounts.length > 0 &&
      !allowedServiceAccounts.includes(runtimeServiceAccount)
    ) {
      return errorResponse(`service account ${runtimeServiceAccount} is not allowed`, 403)
    }

    const requiredSecrets = extractRequiredSecrets(parsed.spec)
    const policy = parsed.policy ?? {}
    const policyChecks = {
      budgetRef: asString(policy.budgetRef) ?? undefined,
      secretBindingRef: asString(policy.secretBindingRef) ?? undefined,
      requiredSecrets,
      subject: { kind: 'Agent', name: parsed.name, namespace: parsed.namespace },
    }

    if (requiredSecrets.length > 0 && !policyChecks.secretBindingRef) {
      return errorResponse('secretBindingRef is required when allowedSecrets are set', 403)
    }

    const kube = deps.kubeClient ?? createKubernetesClient()
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

    const resource = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'Agent',
      metadata: {
        name: parsed.name,
        namespace: parsed.namespace,
        labels: {
          'jangar.proompteng.ai/delivery-id': deliveryId,
        },
      },
      spec: parsed.spec,
    }

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const uid = asString(metadata.uid)

    if (uid) {
      await store.createAuditEvent({
        entityType: 'Agent',
        entityId: uid,
        eventType: 'agent.created',
        payload: { deliveryId, name: parsed.name, namespace: parsed.namespace },
      })
    }

    return okResponse({ ok: true, agent: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
