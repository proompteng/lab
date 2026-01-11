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
import { extractApprovalPolicies, validatePolicies } from '~/server/primitives-policy'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/orchestration-runs')({
  server: {
    handlers: {
      GET: async ({ request }) => getOrchestrationRunsHandler(request),
      POST: async ({ request }) => postOrchestrationRunsHandler(request),
    },
  },
})

type OrchestrationRunPayload = {
  orchestrationRef: { name: string }
  namespace: string
  parameters?: Record<string, string>
  policy?: Record<string, unknown>
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

const parseOrchestrationRunPayload = (payload: Record<string, unknown>): OrchestrationRunPayload => {
  const orchestrationRef = asRecord(payload.orchestrationRef)
  const name = asString(orchestrationRef?.name)
  if (!name) throw new Error('orchestrationRef.name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const parameters = normalizeStringMap(asRecord(payload.parameters))
  const policy = asRecord(payload.policy) ?? undefined
  return { orchestrationRef: { name }, namespace, parameters, policy }
}

export const getOrchestrationRunsHandler = async (
  request: Request,
  deps: { storeFactory?: typeof createPrimitivesStore } = {},
) => {
  const url = new URL(request.url)
  const orchestrationName =
    asString(url.searchParams.get('orchestrationId')) ?? asString(url.searchParams.get('orchestrationName'))
  if (!orchestrationName) return errorResponse('orchestrationId is required', 400)

  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    await store.ready
    const runs = await store.getOrchestrationRunsByName(orchestrationName)
    return okResponse({ ok: true, runs })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}

export const postOrchestrationRunsHandler = async (
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
    const parsed = parseOrchestrationRunPayload(payload)

    await store.ready
    const existing = await store.getOrchestrationRunByDeliveryId(deliveryId)
    if (existing) {
      const resourceNamespace =
        asString(readNested(existing.payload, ['resource', 'metadata', 'namespace'])) ??
        asString(readNested(existing.payload, ['request', 'namespace'])) ??
        parsed.namespace
      const kube = deps.kubeClient ?? createKubernetesClient()
      const resource = existing.externalRunId
        ? await kube.get(RESOURCE_MAP.OrchestrationRun, existing.externalRunId, resourceNamespace)
        : null
      return okResponse({ ok: true, orchestrationRun: existing, resource, idempotent: true })
    }

    const kube = deps.kubeClient ?? createKubernetesClient()
    const orchestration = await kube.get(RESOURCE_MAP.Orchestration, parsed.orchestrationRef.name, parsed.namespace)
    if (!orchestration) {
      return errorResponse(`orchestration ${parsed.orchestrationRef.name} not found`, 404)
    }

    const spec = (orchestration.spec ?? {}) as Record<string, unknown>
    const steps = Array.isArray(spec.steps) ? (spec.steps as Record<string, unknown>[]) : []
    const approvalPolicies = extractApprovalPolicies(steps)

    const policy = parsed.policy ?? {}
    const policyChecks = {
      approvalPolicies,
      budgetRef: asString(policy.budgetRef) ?? undefined,
      subject: { kind: 'Orchestration', name: parsed.orchestrationRef.name, namespace: parsed.namespace },
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
      apiVersion: 'orchestration.proompteng.ai/v1alpha1',
      kind: 'OrchestrationRun',
      metadata: {
        generateName: `${parsed.orchestrationRef.name}-`,
        namespace: parsed.namespace,
        labels: {
          'jangar.proompteng.ai/delivery-id': deliveryId,
        },
      },
      spec: {
        orchestrationRef: parsed.orchestrationRef,
        parameters: parsed.parameters ?? {},
        deliveryId,
      },
    }

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const externalRunId = asString(metadata.name)

    const record = await store.createOrchestrationRun({
      orchestrationName: parsed.orchestrationRef.name,
      deliveryId,
      provider: 'argo',
      status: 'Pending',
      externalRunId,
      payload: { request: payload, resource: applied },
    })
    await store.createAuditEvent({
      entityType: 'OrchestrationRun',
      entityId: record.id,
      eventType: 'orchestration_run.created',
      payload: { deliveryId, orchestration: parsed.orchestrationRef.name, namespace: parsed.namespace },
    })
    return okResponse({ ok: true, orchestrationRun: record, resource: applied }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  } finally {
    await store.close()
  }
}
