import { createFileRoute } from '@tanstack/react-router'
import { errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'
import { hydrateMemoryRecord } from '~/server/primitives-memory'
import { createPrimitivesStore } from '~/server/primitives-store'

export const Route = createFileRoute('/v1/memories/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getMemoryHandler(params.id, request),
    },
  },
})

export const getMemoryHandler = async (
  id: string,
  request: Request,
  deps: {
    storeFactory?: typeof createPrimitivesStore
    kubeClient?: ReturnType<typeof createKubernetesClient>
  } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'))
  const kube = deps.kubeClient ?? createKubernetesClient()
  const store = (deps.storeFactory ?? createPrimitivesStore)()
  try {
    const resource = await kube.get(RESOURCE_MAP.Memory, id, namespace)
    if (!resource) return errorResponse('Memory not found', 404)
    await store.ready
    const record = await hydrateMemoryRecord(resource, namespace, kube, store)
    return okResponse({ ok: true, memory: resource, record })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, message.includes('DATABASE_URL') ? 503 : 500)
  } finally {
    await store.close()
  }
}
