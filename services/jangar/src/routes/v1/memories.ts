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
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/memories')({
  server: {
    handlers: {
      POST: async ({ request }) => postMemoriesHandler(request),
    },
  },
})

type MemoryPayload = {
  name: string
  namespace: string
  spec: Record<string, unknown>
}

const parseMemoryPayload = (payload: Record<string, unknown>): MemoryPayload => {
  const name = asString(payload.name)
  if (!name) throw new Error('name is required')
  const namespace = normalizeNamespace(asString(payload.namespace))
  const spec = asRecord(payload.spec)
  if (!spec) throw new Error('spec is required')
  return { name, namespace, spec }
}

export const postMemoriesHandler = async (
  request: Request,
  deps: {
    storeFactory?: typeof createPrimitivesStore
    kubeClient?: ReturnType<typeof createKubernetesClient>
  } = {},
) => {
  try {
    const deliveryId = requireIdempotencyKey(request)
    const payload = await parseJsonBody(request)
    const parsed = parseMemoryPayload(payload)

    const kube = deps.kubeClient ?? createKubernetesClient()
    const resource = {
      apiVersion: 'memory.proompteng.ai/v1alpha1',
      kind: 'Memory',
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

    const store = (deps.storeFactory ?? createPrimitivesStore)()
    try {
      await store.ready
      const record = await store.upsertMemoryResource({
        memoryName: parsed.name,
        provider: asString(asRecord(parsed.spec.providerRef)?.name) ?? 'unknown',
        status: asString(asRecord(applied.status)?.phase) ?? 'Pending',
      })
      if (uid) {
        await store.createAuditEvent({
          entityType: 'Memory',
          entityId: uid,
          eventType: 'memory.created',
          payload: { deliveryId, name: parsed.name, namespace: parsed.namespace },
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
