import { randomUUID } from 'node:crypto'

import { createFileRoute } from '@tanstack/react-router'
import { requireLeaderForMutationHttp } from '~/server/leader-election'
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
import { extractApprovalPolicies, validatePolicies } from '~/server/primitives-policy'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/orchestrations')({
  server: {
    handlers: {
      POST: async ({ request }) => postOrchestrationsHandler(request),
    },
  },
})

type OrchestrationPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
  policy?: Record<string, unknown>
}

const parseOrchestrationPayload = (payload: Record<string, unknown>): OrchestrationPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  const policy = asRecord(payload.policy) ?? undefined
  return { name, namespace, spec, policy }
}

export const postOrchestrationsHandler = async (
  request: Request,
  deps: { storeFactory?: typeof createPrimitivesStore; kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const leaderResponse = requireLeaderForMutationHttp()
  if (leaderResponse) return leaderResponse

  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseOrchestrationPayload(payload)
    const steps = Array.isArray(parsed.spec.steps) ? (parsed.spec.steps as Record<string, unknown>[]) : []
    const approvalPolicies = extractApprovalPolicies(steps)

    const policy = parsed.policy ?? {}
    const policyChecks = {
      approvalPolicies,
      budgetRef: asString(policy.budgetRef) ?? undefined,
      subject: { kind: 'Orchestration', name: parsed.name, namespace: parsed.namespace },
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
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'Orchestration',
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
        entityType: 'Orchestration',
        entityId: uid,
        eventType: 'orchestration.created',
        payload: { deliveryId, name: parsed.name, namespace: parsed.namespace },
      })
    }

    return okResponse({ ok: true, orchestration: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
