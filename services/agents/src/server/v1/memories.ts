import { resolveAuditContextFromRequest as defaultResolveAuditContextFromRequest } from '../audit-logging'
import { errorResponse, okResponse, parseJsonBody, requireIdempotencyKey } from '../http'
import { createKubernetesClient, type KubernetesClient } from '../kube-types'
import { asRecord, asString, normalizeNamespace } from '../primitives'
import { hydrateMemoryRecord } from '../primitives-memory'

import { buildDeliveryIdLabels } from './delivery-labels'

export type MemoriesApiStore = {
  ready: Promise<unknown>
  close: () => Promise<unknown>
  upsertMemoryResource: (input: {
    memoryName: string
    provider: string
    status: string
    connectionSecret: Record<string, unknown> | null
  }) => Promise<unknown>
  createAuditEvent: (input: {
    entityType: string
    entityId: string
    eventType: string
    context?: Record<string, unknown>
    details?: Record<string, unknown>
  }) => Promise<unknown>
}

export type MemoriesApiDependencies = {
  storeFactory: () => MemoriesApiStore
  kubeClient?: KubernetesClient
  kubeClientFactory?: () => KubernetesClient
  requireLeaderForMutation?: () => Response | null
  resolveAuditContextFromRequest?: (
    request: Request,
    defaults: { deliveryId: string; namespace: string; repository: string | null; source: string },
  ) => Record<string, unknown>
}

type MemoryPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
}

const getKubeClient = (deps: Pick<MemoriesApiDependencies, 'kubeClient' | 'kubeClientFactory'>) =>
  deps.kubeClient ?? deps.kubeClientFactory?.() ?? createKubernetesClient()

const parseMemoryPayload = (payload: Record<string, unknown>): MemoryPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  return { name, namespace, spec }
}

export const postMemoriesHandler = async (request: Request, deps: MemoriesApiDependencies) => {
  const leaderResponse = deps.requireLeaderForMutation?.()
  if (leaderResponse) return leaderResponse

  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseMemoryPayload(payload)

    const kube = getKubeClient(deps)
    const resource = {
      apiVersion: 'agents.proompteng.ai/v1alpha1',
      kind: 'Memory',
      metadata: {
        name: parsed.name,
        namespace: parsed.namespace,
        labels: buildDeliveryIdLabels(deliveryId),
      },
      spec: parsed.spec,
    }

    const applied = await kube.apply(resource)
    const metadata = (applied.metadata ?? {}) as Record<string, unknown>
    const uid = asString(metadata.uid)
    const auditContext = (deps.resolveAuditContextFromRequest ?? defaultResolveAuditContextFromRequest)(request, {
      deliveryId,
      namespace: parsed.namespace,
      repository: null,
      source: 'v1.memories',
    })

    const store = deps.storeFactory()
    try {
      await store.ready
      const record = await hydrateMemoryRecord(applied, parsed.namespace, kube, store)
      if (uid) {
        await store.createAuditEvent({
          entityType: 'Memory',
          entityId: uid,
          eventType: 'memory.created',
          context: auditContext,
          details: { name: parsed.name, memoryUid: uid },
        })
      }
      return okResponse({ ok: true, memory: applied, record }, 201)
    } finally {
      await store.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 400)
  }
}
