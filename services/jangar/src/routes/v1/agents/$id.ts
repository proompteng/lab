import { createFileRoute } from '@tanstack/react-router'
import { asString, errorResponse, normalizeNamespace, okResponse } from '~/server/primitives-http'
import { createKubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

export const Route = createFileRoute('/v1/agents/$id')({
  server: {
    handlers: {
      GET: async ({ params, request }) => getAgentHandler(params.id, request),
    },
  },
})

export const getAgentHandler = async (
  id: string,
  request: Request,
  deps: { kubeClient?: ReturnType<typeof createKubernetesClient> } = {},
) => {
  const url = new URL(request.url)
  const namespace = normalizeNamespace(url.searchParams.get('namespace'))
  const kube = deps.kubeClient ?? createKubernetesClient()

  try {
    const resource = await kube.get(RESOURCE_MAP.Agent, id, namespace)
    if (!resource) return errorResponse('Agent not found', 404)
    return okResponse({ ok: true, agent: resource })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return errorResponse(message, 500, { namespace, id: asString(id) })
  }
}
