import { createFileRoute } from '@tanstack/react-router'
import { asString, errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

export const Route = createFileRoute('/v1/orchestrations/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getOrchestrationHandler(params.id, request),
    },
  },
})

export const getOrchestrationHandler = async (
  id: string,
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'))
  const kube = deps.kubeClient ?? createKubernetesClient()

  try {
    const resource = await kube.get(RESOURCE_MAP.Orchestration, id, namespace)
    if (!resource) return errorResponse('Orchestration not found', 404)
    return okResponse({ ok: true, orchestration: resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace, id: asString(id) })
  }
}
